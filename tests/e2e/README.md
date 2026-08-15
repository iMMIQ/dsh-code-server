# End-to-end tests

Browser-level regression suites for the packaged runtime and the full DSH
stack. They exist because two regressions (settings written to the wrong
file, Restricted Mode disabling the TS language server) once shipped in a
runtime that passed every existing check.

## Suites

| Script | Needs | Guards |
| --- | --- | --- |
| `runtime-settings.mjs` | runtime only | settings.json write/read round-trip (`User/`, never `Machine/`), workspace trust off, TS diagnostics alive |
| `dsh-chat.mjs` | runtime + harness | Chat view + Ctrl+I inline chat: sentinel reaches the session, mock reply streams back into the widget, extension auto-install |
| `dsh-commands.mjs` | runtime + harness | `DSH: Ask` (selection context) and `DSH: Fix` (all five fixture diagnostics) reach the session and the conversation model |

All three run against a **mock LLM** (OpenAI-compatible SSE, loopback only) —
no real API key is ever needed, and the only key in the environment is a
placeholder rejected by anything except the mock.

## Prerequisites

- node ≥ 22 and pnpm (for the harness profile install)
- `zstd` on PATH (session logs are zstd-compressed)
- `fuser` (psmisc) for deterministic port cleanup
- the packaged runtime (built by `scripts/package-runtimes.sh`, or unpack a
  published `.tgz`)
- for the full-stack suites: a DeepSeek Harness checkout with its CLI built
  (`apps/cli/lib/bin.js` exists after `pnpm install && pnpm build` there)
- Playwright's Chromium: `pnpm exec playwright install chromium`

## Running

```bash
pnpm build                                   # plugin lib/ the profile links to
bash scripts/package-runtimes.sh /tmp/rt     # or unpack a published archive
node tests/e2e/runtime-settings.mjs --runtime /tmp/rt/package/bin/dsh-code-server-runtime
node tests/e2e/dsh-chat.mjs      --runtime /tmp/rt/package/bin/dsh-code-server-runtime \
                                  --harness /path/to/deepseek-harness
node tests/e2e/dsh-commands.mjs  --runtime ... --harness ...
```

Flags (also env vars `DSH_E2E_RUNTIME`, `DSH_E2E_HARNESS`, `DSH_E2E_PORT_BASE`,
`DSH_E2E_OUT`): `--runtime` (always), `--harness` (full-stack suites),
`--port-base` (default 3100; dsh, sidecar, mock LLM and the standalone runtime
take base..base+3), `--out` (screenshots and logs, default
`tests/e2e/.artifacts/<script>/`, gitignored), `--keep` (keep the temp tree).

CI runs `runtime-settings` on every push/PR and all three suites in the
Release workflow before a GitHub Release is published.

## Notes for maintaining these tests

- The workspace and its live session are created through the public HTTP API
  (`workspace.create` → `session.create` → `workspace.insertSessionBefore` →
  `session.prompt`); no first-run UI automation is involved.
- Wait for `/dsh-code-server/status` **by body** (`phase === "ready"`): the
  web app answers unknown paths with a 200 SPA fallback, so a bare 200 does
  not prove the plugin is up.
- This monaco build uses the native edit context — there is no `.inputarea`
  textarea; type on the keyboard once the editor owns focus.
- Measure `.monaco-editor.focused .view-lines` for font size: background
  editors are always present at the default size.
- The Ctrl+I widget and the quick-input Enter submit are flaky on the first
  attempt; the helpers retry both and the retry loops are load-bearing.
- Everything user-specific is a flag or env var. The suite must never embed
  absolute local paths, API keys or session ids — CI audits for this.
