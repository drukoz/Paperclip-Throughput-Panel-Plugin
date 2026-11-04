import type {
  PlanProbeSnapshot,
  ProbeAccountState,
  ProbeParseResult,
  ProbeRunResult,
} from "./probe-types.ts";

/** One Claude account as set in the plugin settings. */
export interface ProbeAccountSetting {
  /** Shown in the panel. */
  label: string;
  /** The raw setting: a literal token string or a { type: "secret_ref", ... } object. Never the resolved token. */
  token: unknown;
}

/** What the controller needs from the outside world; tests pass fakes. */
export interface ProbeControllerDeps {
  /** Epoch milliseconds now. */
  now: () => number;
  /** The account's token from its raw setting, or null when it is missing or unreadable. */
  resolveToken: (raw: unknown) => Promise<string | null>;
  /** Runs one Claude check with the token. */
  run: (token: string) => Promise<ProbeRunResult>;
  /** Reads one check's stdout; `at` is the ISO time the check finished. */
  parse: (stdout: string, at: string) => ProbeParseResult;
}

/** Decides when each account is checked and keeps what the checks found. */
export interface ProbeController {
  /** Replaces the accounts and the interval. An account whose label and token setting are both unchanged keeps its state; every other account starts empty. */
  configure(accounts: readonly ProbeAccountSetting[], intervalMinutes: number): void;
  /** A copy of every account's state, in settings order, and the interval. */
  snapshot(): PlanProbeSnapshot;
  /** Starts a pass unless one is running, and returns the running pass. A pass checks each due account one at a time, in settings order. Never rejects. */
  kick(): Promise<void>;
}

/** The message for an account whose token setting is empty or cannot be read. */
export const NO_TOKEN_MESSAGE = "No token: set this account's token in the plugin settings";

interface Entry {
  key: string;
  setting: ProbeAccountSetting;
  state: ProbeAccountState;
  /** Epoch ms of the last attempt, or null before the first. */
  attemptAtMs: number | null;
}

function keyOf(setting: ProbeAccountSetting): string {
  let token: string;
  try {
    token = JSON.stringify(setting.token) ?? "";
  } catch {
    token = String(setting.token);
  }
  return `${setting.label}\u0000${token}`;
}

/** ISO 8601 for epoch ms; the Unix epoch for a value Date cannot represent, because toISOString throws on an invalid Date. */
function isoOf(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Creates a controller with no accounts and a 15-minute interval. */
export function createProbeController(deps: ProbeControllerDeps): ProbeController {
  let entries: Entry[] = [];
  let intervalMinutes = 15;
  let running: Promise<void> | null = null;

  function isDue(entry: Entry): boolean {
    return entry.attemptAtMs === null || deps.now() - entry.attemptAtMs >= intervalMinutes * 60_000;
  }

  async function check(entry: Entry): Promise<void> {
    const state = entry.state;
    try {
      const startedMs = deps.now();
      entry.attemptAtMs = startedMs;
      state.lastAttemptAt = isoOf(startedMs);
      state.probing = true;
      const token = await deps.resolveToken(entry.setting.token);
      if (token === null) {
        state.error = NO_TOKEN_MESSAGE;
        return;
      }
      const result = await deps.run(token);
      if (result.spawnError !== null) {
        state.error = `Could not start Claude Code: ${result.spawnError}`;
        return;
      }
      if (result.timedOut) {
        state.error = "Claude Code did not answer in time";
        return;
      }
      const parsed = deps.parse(result.stdout, isoOf(deps.now()));
      if (parsed.kind === "ok") {
        state.last = parsed.observation;
        state.error = null;
      } else {
        state.error = parsed.message;
      }
    } catch (err) {
      state.error = `Claude check failed: ${messageOf(err)}`;
    } finally {
      state.probing = false;
    }
  }

  async function pass(): Promise<void> {
    // A copy, so configure() during a pass does not change this pass's list.
    for (const entry of [...entries]) {
      if (isDue(entry)) await check(entry);
    }
  }

  return {
    configure(accounts, minutes) {
      const previous = entries;
      const used = new Set<Entry>();
      entries = accounts.map((setting) => {
        const key = keyOf(setting);
        const kept = previous.find((entry) => entry.key === key && !used.has(entry));
        if (kept !== undefined) {
          used.add(kept);
          return kept;
        }
        return {
          key,
          setting,
          state: { label: setting.label, last: null, lastAttemptAt: null, error: null, probing: false },
          attemptAtMs: null,
        };
      });
      intervalMinutes = minutes;
    },
    snapshot() {
      return { accounts: entries.map((entry) => ({ ...entry.state })), intervalMinutes };
    },
    kick() {
      if (running === null) {
        running = pass().finally(() => {
          running = null;
        });
      }
      return running;
    },
  };
}
