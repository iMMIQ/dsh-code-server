# dsh-code-server

在不修改 DeepSeek Harness 源码的前提下，把 code-server 的完整 VS Code Workbench 嵌入 DSH Web 页面。DSH 中的文件链接会打开右侧编辑器抽屉，并通过 code-server 已有的 IPC 在当前编辑器窗口定位文件。LSP、终端、Git 和 VS Code 扩展仍由 code-server 的 Extension Host 提供。

## 当前兼容范围

- 已针对 DeepSeek Harness commit `47f9438`、DSH 裁剪版 code-server `4.132.0-dsh.1`（Code `1.132.0`）验证。
- 仅支持单用户、localhost；code-server 被强制绑定到 `127.0.0.1` 并使用 `auth none`。
- DSH 当前的文件点击链只传递路径，不传递 tool location 中的行号，因此第一版定位到第 1 行。
- 浏览器里是内嵌 Workbench，但 code-server 仍监听独立的 loopback 端口。DSH 的 WebSocket 路由只支持精确路径，外部插件无法在不修改 DSH 的情况下完整代理 code-server 的动态 WebSocket 路径。
- 唯一的非公开兼容点是浏览器插件对 `ctx.workspaces.openPath` 的可恢复包装。插件加载时会检查该方法是否存在且可写，卸载时恢复原始对象形状；DSH 升级后必须运行兼容测试。

`tests/dsh-compat.spec.ts` 会检查当前 sibling DSH checkout 的点击链、方法签名和 overlay slot。升级 DSH 后先运行 `pnpm check`；任何一项变化都会明确失败，而不是让点击行为静默退回系统默认应用。

## 安装

选择与系统匹配的完整发布包。发布包已经包含 code-server `4.132.0-dsh.1`，用户不需要单独安装 IDE：

| 系统 | 发布包后缀 |
| --- | --- |
| Linux x86-64 | `linux-amd64` |
| Linux ARM64 | `linux-arm64` |
| macOS Intel | `macos-amd64` |
| macOS Apple Silicon | `macos-arm64` |

暂不支持 Windows。每个完整包下载约 110–121MB，安装解压后约占用 460MB。

例如，在 Linux x86-64 上安装到 DSH 的 `web` profile：

```bash
dsh plugin --profile web add \
  https://github.com/iMMIQ/dsh-code-server/releases/download/v0.1.1/dsh-code-server-0.1.1-linux-amd64.tgz
dsh --profile web --dump-config
dsh --profile web
```

升级或回滚时，将命令中的两个版本号和平台后缀替换为目标制品并重新执行，然后重启 DSH、刷新浏览器。卸载会同时删除 profile 依赖和 bundle 层：

```bash
dsh plugin --profile web remove dsh-code-server
```

完整包使用 [`iMMIQ/code-server`](https://github.com/iMMIQ/code-server/tree/dsh-v4.132.0) 的已审计裁剪版：移除内置 Copilot、Chat、Agent Host 和 MCP 运行时，保留编辑器、终端、Git、Extension Host 与 LSP。对应源码提交通过 `third_party/code-server` submodule 固定；MIT License 和第三方声明保留在包内 `vendor/code-server` 目录。

从源码开发时，可以构建本仓库并安装本地 checkout：

```bash
pnpm install
pnpm check
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /path/to/dsh-code-server
pnpm dsh --profile web
```

也可以不安装 bundle，用一次性 patch 加载已存在于 profile 依赖中的包。推荐使用 `dsh plugin add`，因为它会把本包的 `dsh.bundle` 层加入 profile。

插件默认优先使用完整包内的 code-server，开发版没有内置运行时时才从 `PATH` 查找。地址默认是 `http://127.0.0.1:3081`。端口或可执行文件需要调整时，在 DSH 的用户 patch 中覆盖整段配置：

```yaml
- id: dsh-code-server
  config:
    executable: /absolute/path/to/code-server
    host: 127.0.0.1
    port: 3081
    startupTimeoutMs: 20000
```

Cordis patch 对 `config` 是整段替换，不是字段合并，所以覆盖时应保留所有需要的字段。

## 使用

打开 DSH Web 后，右下角的 `</>` 按钮可以展开编辑器。在对话中点击 read/edit 等工具展示的文件路径也会自动展开抽屉并在已经运行的 Workbench 中打开该文件。抽屉关闭时 iframe 不会卸载，因此扩展宿主和编辑状态会继续保留。

桌面端默认使用停靠模式：编辑器占据右侧空间时，DSH 主框架会同步收窄，对话区重新排版而不会被遮挡。编辑器标题栏上的布局按钮可以在停靠和浮层之间切换，选择会保存在浏览器中。宽度不超过 800px 时自动使用全屏浮层，避免把对话区挤到不可用。

插件会等到 DSH 至少注册了一个 workspace 后再创建 Workbench iframe。这样既保证 code-server 从一开始就打开正确目录，也避免其空 workspace 会话导致 `--reuse-window` 返回 500。

## 安全边界

控制接口只接受同源 JSON 请求。文件会先经过 `realpath`，且必须位于 DSH 已注册 workspace 的规范路径之下。子进程使用参数数组启动，不拼接 shell 命令。该插件仍等价于给当前本机用户提供一个完整 IDE，只适用于可信 localhost 环境。
