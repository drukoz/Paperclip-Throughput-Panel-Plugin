// A stand-in for the Claude Code CLI in tests: never calls Anthropic.
// Usage: node fake-claude.mjs <scenario> <the CLI's own arguments...>
import { spawn } from "node:child_process";

const scenario = process.argv[2];
const args = process.argv.slice(3);

const EVENT = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1793894400,"rateLimitType":"seven_day","utilization":0.96,"overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"surpassedThreshold":0.75,"unifiedWindows":{"seven_day":{"utilization":0.96,"resetsAt":1793894400,"status":"allowed_warning","surpassedThreshold":0.75}}},"uuid":"u1","session_id":"s1"}';

if (scenario === "ok") {
  process.stdout.write('{"type":"system","subtype":"init","session_id":"s1","tools":[],"claude_code_version":"2.1.318","apiKeySource":"none"}\n');
  process.stdout.write(EVENT + "\n");
  process.stdout.write('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]},"session_id":"s1"}\n');
  process.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"s1"}\n');
  process.stderr.write("fake: a warning on stderr\n");
  process.exitCode = 0;
} else if (scenario === "env") {
  process.stdout.write(JSON.stringify({
    args,
    home: process.env.HOME ?? null,
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    tokenMatches: process.env.CLAUDE_CODE_OAUTH_TOKEN === "test-token",
    path: process.env.PATH ?? null,
    autoUpdater: process.env.DISABLE_AUTOUPDATER ?? null,
    nonEssential: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null,
    sentinel: process.env.RUK518_SENTINEL ?? null,
    cwd: process.cwd(),
  }) + "\n");
} else if (scenario === "fail") {
  process.stdout.write('{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Fix external API key","session_id":"s1"}\n');
  process.exitCode = 1;
} else if (scenario === "slow") {
  // A helper in the same process group, like a tool Claude Code might start.
  const helper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  process.stdout.write(JSON.stringify({ pid: process.pid, helperPid: helper.pid }) + "\n");
  setInterval(() => {}, 1000);
} else if (scenario === "big") {
  process.stdout.write("x".repeat(2_000_000));
} else {
  process.stderr.write(`unknown scenario ${scenario}\n`);
  process.exitCode = 2;
}
