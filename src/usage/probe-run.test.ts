import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROBE_ARGS, runProbe } from "./probe-run.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "probe-run-"));
const configDir = join(dir, "nested", "config");

/**
 * A shell wrapper that runs the fake CLI for one scenario. It runs the fake
 * under the test's own absolute node, because the child's PATH has no node in it.
 */
function wrapper(scenario: string): string {
  const path = join(dir, `claude-${scenario}`);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${scenario} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** The first stdout line, which the fixtures use for their one JSON report. */
function firstLine(stdout: string): string {
  const line = stdout.split("\n")[0];
  assert.ok(line !== undefined, "expected at least one stdout line");
  return line;
}

/** What the env scenario reports about the child's arguments and environment. */
interface EnvReport {
  args: string[];
  home: string | null;
  configDir: string | null;
  tokenMatches: boolean;
  path: string | null;
  autoUpdater: string | null;
  nonEssential: string | null;
  sentinel: string | null;
  cwd: string;
}

test("runs the CLI and returns its output", async () => {
  const result = await runProbe({ claudePath: wrapper("ok"), token: "test-token", configDir, timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.spawnError, null);
  assert.ok(result.stdout.includes("rate_limit_event"), `stdout was: ${result.stdout}`);
  assert.ok(result.stderr.includes("a warning on stderr"), `stderr was: ${result.stderr}`);
});

test("creates the config folder with mode 700", async () => {
  await runProbe({ claudePath: wrapper("ok"), token: "test-token", configDir, timeoutMs: 10_000 });
  assert.equal(statSync(configDir).mode & 0o777, 0o700);
});

test("passes the fixed arguments and only the six environment variables", async () => {
  process.env.RUK518_SENTINEL = "1";
  try {
    const result = await runProbe({ claudePath: wrapper("env"), token: "test-token", configDir, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0);
    const env = JSON.parse(result.stdout) as EnvReport;
    assert.deepStrictEqual(env.args, [...PROBE_ARGS]);
    assert.equal(env.home, configDir);
    assert.equal(env.configDir, configDir);
    assert.equal(env.tokenMatches, true);
    assert.equal(env.path, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(env.autoUpdater, "1");
    assert.equal(env.nonEssential, "1");
    assert.equal(env.sentinel, null);
    // macOS resolves /var to /private/var, so the child reports the cwd realpathed.
    assert.equal(env.cwd, realpathSync(configDir));
  } finally {
    delete process.env.RUK518_SENTINEL;
  }
});

test("kills the process group on timeout", async () => {
  const startedAt = Date.now();
  const result = await runProbe({ claudePath: wrapper("slow"), token: "test-token", configDir, timeoutMs: 3_000 });
  assert.ok(Date.now() - startedAt < 10_000, "the probe must resolve soon after its timeout");
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  const pids = JSON.parse(firstLine(result.stdout)) as { pid: number; helperPid: number };
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(pids.pid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(pids.helperPid, 0), { code: "ESRCH" });
});

test("returns a failing exit code", async () => {
  const result = await runProbe({ claudePath: wrapper("fail"), token: "test-token", configDir, timeoutMs: 10_000 });
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.equal(result.spawnError, null);
  assert.ok(result.stdout.includes("Invalid API key"), `stdout was: ${result.stdout}`);
});

test("reports a CLI that does not exist", async () => {
  const result = await runProbe({ claudePath: "/nonexistent/claude-ruk518", token: "test-token", configDir, timeoutMs: 10_000 });
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.match(result.spawnError ?? "", /ENOENT/);
});

test("caps the output", async () => {
  const result = await runProbe({
    claudePath: wrapper("big"),
    token: "test-token",
    configDir,
    timeoutMs: 10_000,
    maxOutputBytes: 1000,
  });
  assert.equal(result.stdout.length, 1000);
  assert.equal(result.exitCode, 0);
});

test("never returns the token", async () => {
  for (const scenario of ["ok", "env", "fail"] as const) {
    const result = await runProbe({ claudePath: wrapper(scenario), token: "test-token", configDir, timeoutMs: 10_000 });
    assert.ok(!JSON.stringify(result).includes("test-token"), `the ${scenario} result must not carry the token`);
  }
});
