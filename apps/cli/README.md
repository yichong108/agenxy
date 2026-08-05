# 心智架构

## 一句话

命令行宿主：从环境变量解析模型配置，调用 `createAgent` 发起对话。

## 边界与依赖

- 依赖 `@openwork/agent`（`createAgent` / `getChatModel`），不重复实现 ReAct / 工具。
- 会话消息仅在进程内持有，不做桌面端式持久化。
- 模型凭据来自环境变量（或 `.env`），不读桌面 AppSettings 存储。

## 反模式（本模块已出现过/严禁）

- 在 CLI 内复制 Desktop 的会话 / IPC / 工具时间线逻辑
- 绕过 `createAgent` 直接拼装 ReAct 循环

# 用法

## 开发（tsx，改完即跑）

```bash
cp apps/cli/.env.example apps/cli/.env
# 编辑 OPENWORK_API_KEY 等

pnpm cli:start -- "列出当前目录文件"
pnpm cli:start
pnpm cli:start -- -m ask -C ./some-workspace
```

## 打包后测试

```bash
pnpm cli:build
pnpm cli:start:dist -- --help
pnpm cli:start:dist -- "用一句话介绍你自己"
```

产物在 `apps/cli/dist/index.js`（ESM bundle；`@vscode/ripgrep` 仍走 node_modules）。
