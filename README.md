# Magpie Codex Prompt Optimizer

在 Codex 桌面端输入框旁注入“优化”按钮。点击后由 Magpie 本机服务整理当前提示词；再次点击可还原原文，优化过程中再次点击可取消。

## 功能

- 支持 OpenAI Chat Completions 兼容接口与 Anthropic Messages 接口。
- 支持简洁、结构化、编程三种优化风格，并可分别修改 System Prompt。
- 默认保留草稿的段落顺序、列表、Markdown、换行和代码块格式。
- 优化按钮使用隔离浮层，不修改 Codex 的 React/ProseMirror 组件树，避免输入路径参与额外 DOM 更新。
- 保留 `@文件`、URL、文件路径和代码块等原始内容。
- 检测输入框在请求期间是否被修改；发生变化时不会覆盖用户的新内容。
- Codex 页面切换、刷新、重新加载或普通重启后，由 CDP 控制器自动重新注入。
- API Key 只保存在本机配置文件中，不注入 Codex DOM、不写入 `localStorage`、不写入日志。

## 安装

需要 Magpie、Codex 桌面端和 Node.js 22 或更高版本。克隆并安装：

```bash
git clone https://github.com/yejuntian/magpie-codex-prompt-optimizer.git
magpie plugin add "$(pwd)/magpie-codex-prompt-optimizer"
magpie plugin list --json
```

在 Magpie 左侧 `Plugins` 分组打开 `Codex Prompt Optimizer`。插件页默认使用本机端口 `47821`；在 Magpie Web 中会通过 `magpie.service` 同源代理访问该端口。

本地开发：

```bash
cd magpie-codex-prompt-optimizer
npm start
```

## 首次使用

1. 在插件页填写模型协议、Base URL、API Key 和模型。
2. 点击“重启 Codex 并注入”。该操作会先正常退出 `/Applications/ChatGPT.app`，再以本机调试端口 `9333` 重新打开。
3. 回到 Codex，在输入框底部附近查找“优化”按钮。
4. 点击“优化”；成功后再次点击还原。右键按钮可修改非密钥设置。

调试端口的启动环境会保存在当前 macOS 用户会话中。首次设置后，Codex 后续普通重启仍会监听本机 `9333` 端口，Magpie 会自动重新连接并注入。

重启前请确认 Codex 中没有尚未保存的重要草稿。已经发送的消息不会受影响。

## 上游协议

OpenAI 兼容接口：

- Base URL 示例：`https://api.openai.com/v1`
- 请求地址：`<Base URL>/chat/completions`
- 认证头：`Authorization: Bearer <API Key>`

Anthropic Messages：

- Base URL 示例：`https://api.anthropic.com`
- 请求地址：`<Base URL>/v1/messages`
- 认证头：`x-api-key: <API Key>` 与 `anthropic-version: 2023-06-01`

当前安全边界要求 HTTPS，支持解析到内网地址的自定义域名和局域网 API，同时拒绝回环、链路本地地址、URL 凭据和 HTTP 重定向。

## 配置与数据

配置文件：

```text
~/.magpie-codex-prompt-optimizer/config.json
```

目录权限为 `0700`，文件权限为 `0600`。可用环境变量 `MAGPIE_CPO_CONFIG` 指定其他配置路径。

网络行为：

- Magpie 插件服务只监听 `127.0.0.1`。
- 每次服务启动都会生成新的 UI 会话令牌；API 请求必须携带该令牌。
- 提示词正文会发送到用户配置的上游模型服务。
- 上游响应限制为 5 MB，请求超时为 120 秒。

## 限制

- 按钮定位依赖 Codex 当前 DOM。Codex 大版本更新改变输入框结构后，可能需要调整 `injected/prompt-optimizer.js` 中的选择器。
- 内置一键重启目前只支持 macOS，并识别 `/Applications/ChatGPT.app` 或 `/Applications/Codex.app`。
- 如果 `47821` 或 `9333` 被占用，需要在 Magpie 插件选项或配置文件中改用其他端口。
- Magpie 页面沙箱不允许直接访问 Codex DOM 或任意外部网络；DOM 注入通过本机 CDP 完成。

## 验证

```bash
npm test
find . -type f \( -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check
```

手动检查：

```bash
node scripts/inject.mjs
```

该命令默认连接 `http://127.0.0.1:9333`，输出已连接的 Codex 页面和注入状态。可用 `CPO_CDP_ENDPOINT` 覆盖地址。

## 开源许可

本项目采用 [MIT License](LICENSE)。欢迎提交 Issue 或 Pull Request。
