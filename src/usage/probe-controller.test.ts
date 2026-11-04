import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_TOKEN_MESSAGE, createProbeController } from "./probe-controller.ts";
import type { ProbeAccountSetting } from "./probe-controller.ts";
import type { ProbeParseResult, ProbeRunResult } from "./probe-types.ts";

const START_MS = Date.parse("2026-11-04T00:00:00.000Z");

function runOk(): ProbeRunResult {
  return { stdout: "out", stderr: "", exitCode: 0, timedOut: false, spawnError: null };
}

/** A promise a test can settle by hand, to hold a check in flight. */
function gate(): { promise: Promise<ProbeRunResult>; resolve: (result: ProbeRunResult) => void } {
  let resolve!: (result: ProbeRunResult) => void;
  const promise = new Promise<ProbeRunResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Harness {
  controller: ReturnType<typeof createProbeController>;
  /** The tokens passed to run, in call order. */
  tokens: string[];
  state: {
    clock: number;
    runImpl: (token: string) => Promise<ProbeRunResult>;
    parseImpl: (stdout: string, at: string) => ProbeParseResult;
  };
}

/** A controller on a manual clock with fakes for the token, the runner and the parser. */
function makeHarness(): Harness {
  const tokens: string[] = [];
  const state = {
    clock: START_MS,
    runImpl: async (token: string): Promise<ProbeRunResult> => {
      tokens.push(token);
      return runOk();
    },
    parseImpl: (stdout: string, at: string): ProbeParseResult => ({
      kind: "ok",
      observation: {
        reading: {
          source: "probe",
          at,
          usage: {
            session: null,
            weekly: { usedPercent: 96, resetsAt: null },
            fable: null,
          },
        },
        status: "allowed_warning",
        rateLimitType: "seven_day",
        overageStatus: null,
        overageDisabledReason: null,
      },
    }),
  };
  const controller = createProbeController({
    now: () => state.clock,
    resolveToken: async (raw) => (typeof raw === "string" && raw !== "" ? raw : null),
    run: (token) => state.runImpl(token),
    parse: (stdout, at) => state.parseImpl(stdout, at),
  });
  return { controller, tokens, state };
}

function account(label: string, token: unknown): ProbeAccountSetting {
  return { label, token };
}

test("the first kick checks every due account once, in settings order", async () => {
  const { controller, tokens } = makeHarness();
  controller.configure([account("A", "ta"), account("B", "tb")], 15);
  await controller.kick();
  assert.deepEqual(tokens, ["ta", "tb"]);
  for (const state of controller.snapshot().accounts) {
    assert.notEqual(state.last, null);
    assert.equal(state.error, null);
    assert.equal(state.probing, false);
  }
});

test("lastAttemptAt is the ISO time the check started", async () => {
  const { controller } = makeHarness();
  controller.configure([account("A", "ta")], 15);
  await controller.kick();
  assert.equal(controller.snapshot().accounts[0]!.lastAttemptAt, "2026-11-04T00:00:00.000Z");
});

test("an account is not checked again before the interval", async () => {
  const { controller, tokens, state } = makeHarness();
  controller.configure([account("A", "ta"), account("B", "tb")], 15);
  await controller.kick();
  assert.equal(tokens.length, 2);
  state.clock += 14 * 60_000;
  await controller.kick();
  assert.equal(tokens.length, 2);
  state.clock += 60_000;
  await controller.kick();
  assert.deepEqual(tokens, ["ta", "tb", "ta", "tb"]);
});

test("a kick during a pass returns the same promise and starts no second pass", async () => {
  const { controller, tokens, state } = makeHarness();
  const opened = gate();
  state.runImpl = async (token: string): Promise<ProbeRunResult> => {
    tokens.push(token);
    return opened.promise;
  };
  controller.configure([account("A", "ta"), account("B", "tb")], 15);
  const p1 = controller.kick();
  const p2 = controller.kick();
  assert.equal(p1, p2);
  opened.resolve(runOk());
  await p1;
  assert.deepEqual(tokens, ["ta", "tb"]);
});

test("probing is true only for the account being checked", async () => {
  const { controller, tokens, state } = makeHarness();
  const opened = gate();
  state.runImpl = async (token: string): Promise<ProbeRunResult> => {
    tokens.push(token);
    return opened.promise;
  };
  controller.configure([account("A", "ta"), account("B", "tb")], 15);
  const pass = controller.kick();
  const snapshot = controller.snapshot();
  assert.equal(snapshot.accounts[0]!.probing, true);
  assert.equal(snapshot.accounts[1]!.probing, false);
  opened.resolve(runOk());
  await pass;
});

test("an empty token setting gives the no-token message and runs nothing", async () => {
  const { controller, tokens } = makeHarness();
  controller.configure([account("A", "")], 15);
  await controller.kick();
  assert.deepEqual(tokens, []);
  assert.equal(controller.snapshot().accounts[0]!.error, NO_TOKEN_MESSAGE);
});

test("a spawn error, a timeout and a parse error each give their message", async () => {
  const spawn = makeHarness();
  spawn.state.runImpl = async (): Promise<ProbeRunResult> => ({
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: false,
    spawnError: "spawn /x ENOENT",
  });
  spawn.controller.configure([account("A", "ta")], 15);
  await spawn.controller.kick();
  assert.equal(spawn.controller.snapshot().accounts[0]!.error, "Could not start Claude Code: spawn /x ENOENT");

  const timeout = makeHarness();
  timeout.state.runImpl = async (): Promise<ProbeRunResult> => ({
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: true,
    spawnError: null,
  });
  timeout.controller.configure([account("A", "ta")], 15);
  await timeout.controller.kick();
  assert.equal(timeout.controller.snapshot().accounts[0]!.error, "Claude Code did not answer in time");

  const parse = makeHarness();
  parse.state.parseImpl = (): ProbeParseResult => ({
    kind: "error",
    message: "Claude Code printed no usage report",
  });
  parse.controller.configure([account("A", "ta")], 15);
  await parse.controller.kick();
  assert.equal(parse.controller.snapshot().accounts[0]!.error, "Claude Code printed no usage report");
});

test("a failed check keeps the last good observation", async () => {
  const { controller, state } = makeHarness();
  controller.configure([account("A", "ta")], 15);
  await controller.kick();
  const good = controller.snapshot().accounts[0]!.last;
  assert.notEqual(good, null);
  state.clock += 15 * 60_000;
  state.parseImpl = (): ProbeParseResult => ({ kind: "error", message: "Claude Code printed no usage report" });
  await controller.kick();
  const after = controller.snapshot().accounts[0]!;
  assert.deepEqual(after.last, good);
  assert.equal(after.error, "Claude Code printed no usage report");
});

test("a throwing run is reported and the pass goes on", async () => {
  const { controller, tokens, state } = makeHarness();
  state.runImpl = async (token: string): Promise<ProbeRunResult> => {
    tokens.push(token);
    if (token === "ta") throw new Error("kaput");
    return runOk();
  };
  controller.configure([account("A", "ta"), account("B", "tb")], 15);
  await controller.kick();
  assert.equal(controller.snapshot().accounts[0]!.error, "Claude check failed: kaput");
  assert.deepEqual(tokens, ["ta", "tb"]);
});

test("configure keeps unchanged accounts and resets changed ones", async () => {
  const { controller } = makeHarness();
  controller.configure([account("A", "ta"), account("B", "tb")], 15);
  await controller.kick();
  controller.configure([account("A", "ta"), account("B", "tb2"), account("C", "tc")], 15);
  const [a, b, c] = controller.snapshot().accounts;
  assert.notEqual(a!.last, null);
  assert.equal(b!.last, null);
  assert.equal(b!.lastAttemptAt, null);
  assert.equal(c!.last, null);
  assert.equal(c!.lastAttemptAt, null);
});

test("snapshot returns copies", async () => {
  const { controller } = makeHarness();
  controller.configure([account("A", "ta")], 15);
  controller.snapshot().accounts[0]!.error = "x";
  assert.equal(controller.snapshot().accounts[0]!.error, null);
});

test("the snapshot never contains a token", async () => {
  const { controller } = makeHarness();
  controller.configure([account("A", "secret-ta"), account("B", "secret-tb")], 15);
  await controller.kick();
  const json = JSON.stringify(controller.snapshot());
  assert.equal(json.includes("secret-ta"), false);
  assert.equal(json.includes("secret-tb"), false);
});
