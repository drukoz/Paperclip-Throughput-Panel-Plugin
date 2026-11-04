import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { ProbeRunResult } from "./probe-types.ts";

/** The arguments of every Claude check: one Haiku request with a tiny prompt, no tools, no MCP servers, no skills, nothing saved. */
export const PROBE_ARGS: readonly string[] = [
  "-p",
  "--model", "haiku",
  "--output-format", "stream-json",
  "--verbose",
  "--tools", "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--system-prompt", "Reply with the single word OK.",
  "OK",
];

/** Bytes kept from each of stdout and stderr when the caller gives no cap. */
export const PROBE_MAX_OUTPUT_BYTES = 1_048_576;

/** How to run one Claude check. */
export interface RunProbeOptions {
  /** Absolute path of the Claude Code CLI. */
  claudePath: string;
  /** The account's Claude token. Passed only in the child's environment; never logged or returned. */
  token: string;
  /** Private folder used as the child's HOME, CLAUDE_CONFIG_DIR and working directory; created with mode 0o700 when missing. */
  configDir: string;
  /** The child's whole process group is killed after this many milliseconds. */
  timeoutMs: number;
  /** Bytes kept from each of stdout and stderr; default PROBE_MAX_OUTPUT_BYTES. */
  maxOutputBytes?: number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Kills the child's process group, so a helper it started cannot outlive it. */
function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Runs the Claude Code CLI once with PROBE_ARGS and returns what it printed. Never throws. */
export async function runProbe(options: RunProbeOptions): Promise<ProbeRunResult> {
  const cap = options.maxOutputBytes ?? PROBE_MAX_OUTPUT_BYTES;
  try {
    await mkdir(options.configDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { stdout: "", stderr: "", exitCode: null, timedOut: false, spawnError: `cannot create ${options.configDir}: ${messageOf(err)}` };
  }
  return new Promise<ProbeRunResult>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (exitCode: number | null, spawnError: string | null) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode,
        timedOut,
        spawnError,
      });
    };
    let child: ChildProcess;
    try {
      child = spawn(options.claudePath, [...PROBE_ARGS], {
        cwd: options.configDir,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: options.configDir,
          CLAUDE_CONFIG_DIR: options.configDir,
          CLAUDE_CODE_OAUTH_TOKEN: options.token,
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (spawnErr) {
      finish(null, messageOf(spawnErr));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes >= cap) return;
      const kept = chunk.subarray(0, cap - outBytes);
      out.push(kept);
      outBytes += kept.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes >= cap) return;
      const kept = chunk.subarray(0, cap - errBytes);
      err.push(kept);
      errBytes += kept.length;
    });
    child.on("error", (spawnErr) => {
      killGroup(child);
      finish(null, spawnErr.message);
    });
    child.on("close", (code) => {
      finish(code, null);
    });
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, options.timeoutMs);
  });
}
