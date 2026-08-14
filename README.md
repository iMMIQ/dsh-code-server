# dsh-code-server

Embeds a code-server VS Code Workbench in DeepSeek Harness Web without modifying DSH source. Clicking a DSH file reference opens the right-hand editor drawer and uses code-server's existing IPC to open the file in the live Workbench.

This first version targets a trusted, single-user localhost setup.

## Install

Choose the full release package for your OS and CPU. It includes code-server 4.106.3, so no separate IDE installation is required. For example, on Linux x86-64:

```bash
dsh plugin --profile web add \
  https://github.com/iMMIQ/dsh-code-server/releases/download/v0.1.0/dsh-code-server-0.1.0-linux-amd64.tgz
dsh --profile web
```

Release assets are provided for `linux-amd64`, `linux-arm64`, `macos-amd64`, and `macos-arm64`; Windows is not supported. Each installation uses about 460 MB after extraction. Update or roll back by running the same command with the target version and platform, then restart DSH and refresh the browser. Remove the plugin with:

```bash
dsh plugin --profile web remove dsh-code-server
```

The full packages redistribute the official code-server 4.106.3 standalone build under its MIT license. Its license and third-party notices remain inside `vendor/code-server`.

See [README.zh-CN.md](./README.zh-CN.md) for compatibility, development installation, configuration, limitations, and security details.
