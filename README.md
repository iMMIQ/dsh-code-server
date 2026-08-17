# dsh-code-server

A plugin for DeepSeek Harness (DSH): it adds a full VS Code workbench to DSH
Web and wires it into your live DSH sessions — chat with the workspace agent
from inside the editor, turn selections into questions, and open any file the
conversation mentions, all without leaving the browser.

Current release: **v0.1.5** · VS Code `1.132.0` · Linux & macOS (amd64 / arm64)

## What you get

- **A full VS Code workbench in DSH Web.** Editor, integrated terminal, Git,
  extensions and language servers run in a right-hand drawer that docks beside
  the conversation or floats above it.
- **File references open in the editor.** Click a file path shown by a
  conversation tool call and it opens in the running workbench.
- **A native Chat view connected to your DSH session.** Replies stream in as
  they are generated; each tool call leaves a `✓ read src/index.ts · 12ms`
  row with a clickable file chip, and failures are called out separately.
- **Inline chat (Ctrl+I).** Select code, press Ctrl+I and ask — the selection
  travels with the question, the answer streams into the inline zone, and the
  turn also lands in the DSH conversation.
- **Editor commands.** `DSH: Ask About This Selection` (also in the editor
  context menu), `DSH: Fix Problems in This File`, `DSH: Explain Terminal
  Selection`, and a `Fix with DSH` quick-fix offered on any diagnostic.
- **Full tool output.** Bash cards whose output was truncated get an
  **Open full output** button that opens the complete stdout/stderr files.
- **No bundled cloud AI.** Copilot, the agent host and the MCP runtime are
  removed from the bundled workbench; the Chat surfaces talk to your own DSH
  session only.

## Requirements

- DeepSeek Harness with plugin support (verified against commit `47f9438`)
- Linux or macOS on x86-64 or ARM64 — Windows is not supported
- About 460 MB of disk after installation
- A trusted, single-user localhost setup (see [Security](#security))

## Install

Pick the release archive for your platform and add it to a DSH profile:

```bash
dsh plugin --profile web add \
  https://github.com/iMMIQ/dsh-code-server/releases/download/v0.1.5/dsh-code-server-0.1.5-linux-amd64.tgz
dsh --profile web
```

| Platform | Archive suffix |
| --- | --- |
| Linux x86-64 | `linux-amd64` |
| Linux ARM64 | `linux-arm64` |
| macOS Intel | `macos-amd64` |
| macOS Apple Silicon | `macos-arm64` |

The archive is self-contained — it bundles the workbench runtime, so no
separate IDE installation is needed. Update or roll back by running the same
command with the target version, then restart DSH and refresh the browser.
Remove the plugin with:

```bash
dsh plugin --profile web remove dsh-code-server
```

## Usage

- Open DSH Web and press the `</>` button in the bottom-right corner: the
  workbench opens in a drawer beside the conversation. In docked mode the
  conversation reflows instead of being covered; below 800px viewport width
  the editor becomes a fullscreen overlay. Collapsing the drawer keeps the
  workbench alive — edits, terminals and extensions survive.
- Click file paths in the conversation to open them in the workbench
  (positioning currently lands on line 1).
- The Chat view sits in the workbench's secondary side bar (or open it via
  *Chat: Focus on Chat View* in the command palette). Type a question and the
  workspace's DSH session answers, streaming into the view. The workspace
  needs an active session — start one in DSH first; otherwise you get a clear
  error.
- Select code and press Ctrl+I for inline chat: the selection is sent along
  with the question, the answer streams into the zone right in the editor,
  and the turn is recorded in the DSH conversation.
- Right-click a selection for `DSH: Ask About This Selection`. Use
  `DSH: Fix Problems in This File` on a file with diagnostics, take the
  `Fix with DSH` quick-fix from the lightbulb or the Problems panel, or
  select terminal output and run `DSH: Explain Terminal Selection`.
- On a bash card with truncated output, press **Open full output** to open
  the complete output files in the workbench.

## Configuration

The workbench server listens on `http://127.0.0.1:3081` and uses the
code-server bundled with the plugin (a copy on `PATH` is only used when the
bundled runtime is missing, e.g. in development). To change that, override
the block in your DSH user patch — it replaces the defaults as a whole, so
keep every field you need:

```yaml
- id: dsh-code-server
  config:
    executable: /absolute/path/to/code-server
    host: 127.0.0.1
    port: 3081
    startupTimeoutMs: 20000
```

## Security

The plugin targets a trusted, single-user localhost setup. code-server is
forced to bind to `127.0.0.1` with authentication disabled, so nothing
outside the machine can reach it. Requests from the workbench extension carry
a one-time token generated at each launch, and opening files is limited to
your registered DSH workspaces and DSH's own temporary output files.
Installing this plugin is equivalent to giving the local user a full IDE.

## Compatibility

Each release is developed and verified against a pinned DSH version (see
[Requirements](#requirements)); the integration surfaces are guarded by
automated tests. After upgrading DSH, switch to the plugin release that
matches it if anything misbehaves.

## Development

```bash
pnpm install
pnpm check        # unit tests + DSH compatibility tests
pnpm build

cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /path/to/dsh-code-server
pnpm dsh --profile web
```

Browser-level end-to-end suites live in [`tests/e2e`](./tests/e2e/README.md).

## License

The plugin code is licensed under the [GNU LGPL v3](./LICENSE). The workbench
runtime bundled in the release archives is a trimmed fork of
[code-server](https://github.com/coder/code-server)
([`iMMIQ/code-server` @ `dsh-v4.132.0`](https://github.com/iMMIQ/code-server/tree/dsh-v4.132.0)),
MIT-licensed, with its license and third-party notices retained under
`vendor/code-server` in the package.
