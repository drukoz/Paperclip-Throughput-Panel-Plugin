### Claude accounts

With at least one Claude account set, the expanded panel shows one **Claude · <label>** section per account instead of the single **Claude plan** section. For each account the worker runs one tiny Claude Code request (`claude -p` with Haiku, a one-word reply, no tools, no MCP servers, nothing saved) and reads the usage report Claude Code prints with it. A check runs only while the panel is expanded and its tab is visible, at most every `claudeCheckMinutes` minutes per account, one account at a time. Each check spends a small amount of that account's Claude usage. Claude Code runs with a private config folder, `$TMPDIR/rukoz-throughput-panel/claude-check`, not your own `~/.claude`.

To set up an account:

1. In Terminal, run `claude setup-token` and sign in with that account in the browser window it opens. It prints a long-lived token.
2. Store the token as a Paperclip company secret and put a secret reference in **Claude account N: token**: `{ "type": "secret_ref", "secretId": "<uuid>" }`. If the settings page takes only text, paste the token itself.
3. Set **Claude account N: label**, for example the account's email address.
4. A build that changes the worker reaches it only after you disable and re-enable the plugin once (`paperclipai plugin disable rukoz.throughput-panel`, then `paperclipai plugin enable rukoz.throughput-panel`). A page reload alone loads only the panel.

What the bars can show: Anthropic reports only the window closest to its limit. Since 31 October 2026 that has usually been the weekly window, so the 5-hour bar shows "—" with the note "Anthropic reports only the weekly limit right now". Fable's weekly window is not reported for these tokens, so its row is hidden. Hover a bar for its reset time and age.

| Message under an account | Meaning |
| --- | --- |
| No token: set this account's token in the plugin settings | The token setting is empty, or its secret cannot be read. |
| Could not start Claude Code: … | `claudePath` is wrong, or the CLI is not installed. |
| Claude Code did not answer in time | The check ran past 60 seconds and was stopped. |
| Claude Code: … | Claude Code's own error, for example a revoked token. |
| Limit reached: Claude is blocked on this account until the reset | The account is at its limit. |
| Last check failed: … | The newest check failed; the bars show the one before. |

The worker resolves each token for one check, passes it only to that Claude Code process, and never stores, logs or shows it.
