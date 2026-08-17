# dsh-code-server

DeepSeek Harness（DSH）插件：为 DSH Web 装上完整 VS Code 工作台，并与你的 DSH
会话打通——在编辑器里直接对话工作区 agent、把选区一键变成提问、会话里提到的文件
点开即达，全程不用离开浏览器。

当前发布：**v0.1.5** · VS Code `1.132.0` · Linux 与 macOS（amd64 / arm64）

## 功能

- **内嵌完整 VS Code 工作台。** 编辑器、集成终端、Git、扩展和语言服务器全部
  可用；工作台显示在右侧抽屉里，可停靠在对话旁，也可切换为浮层。
- **文件引用点击即开。** 对话中工具调用展示的文件路径，点击就在运行中的工作台
  打开；read 行会直接落到 agent 正在阅读的那一行。
- **原生 Chat 视图，直连 DSH 会话。** 回复边生成边流式上屏；每个工具调用留下
  `✓ read src/index.ts · 12ms` 结果行并带可点击的文件 chip，失败会单独标出。
- **行内聊天（Ctrl+I）。** 选中代码按 Ctrl+I 提问，选区随问题一起发送，回答
  直接流进行内浮层，这轮对话也会落在 DSH 对话流里。
- **编辑器命令。** `DSH: Ask About This Selection`（也在编辑器右键菜单）、
  `DSH: Fix Problems in This File`、`DSH: Explain Terminal Selection`，以及任意
  诊断上提供的 `Fix with DSH` 快速修复。
- **完整工具输出。** 输出被截断的 bash 卡片会出现 **Open full output** 按钮，
  一键打开完整的 stdout/stderr 文件。
- **不内置云端 AI。** 捆绑的工作台已移除 Copilot、Agent Host 和 MCP 运行时；
  Chat 只与你自己的 DSH 会话通信。

## 环境要求

- 支持插件的 DeepSeek Harness（已针对 commit `47f9438` 验证）
- Linux 或 macOS，x86-64 / ARM64；暂不支持 Windows
- 安装后约 460 MB 磁盘占用
- 可信的单用户 localhost 环境（见[安全边界](#安全边界)）

## 安装

按平台选择发布包，加入 DSH profile：

```bash
dsh plugin --profile web add \
  https://github.com/iMMIQ/dsh-code-server/releases/download/v0.1.5/dsh-code-server-0.1.5-linux-amd64.tgz
dsh --profile web
```

| 系统 | 发布包后缀 |
| --- | --- |
| Linux x86-64 | `linux-amd64` |
| Linux ARM64 | `linux-arm64` |
| macOS Intel | `macos-amd64` |
| macOS Apple Silicon | `macos-arm64` |

发布包自包含——内置工作台运行时，无需单独安装 IDE。升级或回滚时把命令里的版本
号换成目标版本重新执行，然后重启 DSH、刷新浏览器。卸载：

```bash
dsh plugin --profile web remove dsh-code-server
```

## 使用

- 打开 DSH Web，点右下角 `</>` 按钮展开编辑器：工作台在对话旁的抽屉里打开。
  停靠模式下对话区会自动收窄重排而不是被遮挡；视口宽度不足 800px 时自动切换
  为全屏浮层。收起抽屉不会卸载工作台，编辑状态、终端和扩展都保留。
- 点击对话里的文件路径即可在工作台打开。read 工具行会定位到其阅读窗口的起始
  行，其余行落在第 1 行。
- Chat 视图在工作台的副侧边栏（也可用命令面板的 *Chat: Focus on Chat View*
  打开）。输入问题，工作区的 DSH 会话流式作答。该工作区需要已有活跃会话——
  先在 DSH 里打开，否则会得到明确的报错。
- 选中代码按 Ctrl+I 行内提问：选区随问题一起发送，回答直接流进编辑器里的
  浮层，这轮对话同时记录在 DSH 对话流里。
- 右键选区用 `DSH: Ask About This Selection`；带诊断的文件用
  `DSH: Fix Problems in This File`；光标停在问题上时，从灯泡菜单或问题面板
  取 `Fix with DSH` 快速修复；在终端里选中输出后运行
  `DSH: Explain Terminal Selection`。
- 输出被截断的 bash 卡片，点 **Open full output** 在工作台打开完整输出文件。

## 配置

工作台服务默认监听 `http://127.0.0.1:3081`，默认使用插件自带的 code-server
（仅当内置运行时缺失时才用 `PATH` 上的副本，比如开发环境）。需要调整时在 DSH
用户 patch 中覆盖整段配置——配置块是整体替换，请把需要的字段写全：

```yaml
- id: dsh-code-server
  config:
    executable: /absolute/path/to/code-server
    host: 127.0.0.1
    port: 3081
    startupTimeoutMs: 20000
```

## 安全边界

插件面向可信的单用户 localhost 环境。code-server 被强制绑定 `127.0.0.1` 且
关闭认证，本机之外无法访问；工作台扩展发来的请求携带每次启动生成的一次性
token。文件打开跟随会话行指向任意已存在的本地路径——workspace 文件、DSH
临时输出、/tmp 下的草稿均可——这与工作台自带打开对话框本就能访问的范围
一致。安装本插件等价于给本机用户提供一个完整 IDE。

## 兼容性

每个发布版本都针对固定版本的 DSH 开发验证（见[环境要求](#环境要求)），依赖的
集成面由自动化测试守卫。升级 DSH 后如遇异常，请换用与之匹配的插件版本。

## 开发

```bash
pnpm install
pnpm check        # 单元测试 + DSH 兼容性测试
pnpm build

cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /path/to/dsh-code-server
pnpm dsh --profile web
```

浏览器级端到端测试见 [`tests/e2e`](./tests/e2e/README.md)。

## 许可证

插件代码以 [GNU LGPL v3](./LICENSE) 发布。发布包内置的工作台运行时是
[code-server](https://github.com/coder/code-server) 的裁剪版
fork（[`iMMIQ/code-server` @ `dsh-v4.132.0`](https://github.com/iMMIQ/code-server/tree/dsh-v4.132.0)，
MIT），其许可与第三方声明保留在包内 `vendor/code-server`。
