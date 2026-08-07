# 心智架构

## 一句话

负责创建 Agent。
宿主入口是 `OpenWorkerAgent`（AG-UI）；
底层核心是 ReAct（`createAgent`，包内私有）；
Agent 不负责流程编排；
Agent 可选 Skills；
Agent 可选 MCP。

会话消息与工具：底层 ReAct 使用 AI SDK 的 `CoreMessage` / `Tool` / `ToolSet`；
宿主侧经 `OpenWorkerAgent`（见 `createAGUIAgent.ts`）以 AG-UI 协议接入。

## 边界与依赖

- **Desktop 宿主禁止直接依赖本包**；应经 [`@openworker/uni-agent`](../uni-agent/README.md)。
- **外部禁止直接使用 `createAgent` / `agent.send`**；一律经 `OpenWorkerAgent.runAgent`（或 `run`）与 AG-UI 事件。
- `createAgent` 仅由 `OpenWorkerAgent` 内部委托，不从包根导出。
- MCP 宿主能力经 `OpenWorkerAgent.mcp`（probe / warmup / dispose）。
- send 的 Skills / MCP 按用户目录约定自动加载：`~/.openworker/skills` 与 `~/.openworker/mcp.json`。

## 反模式（本模块已出现过/严禁）

- Desktop 直接依赖 `@openworker/agent`（应使用 `@openworker/uni-agent`）
- 宿主直接 import / 调用 `createAgent`（应使用 `OpenWorkerAgent` / `uni-agent`）
- 让 agent 依赖宿主特有的 skills 目录布局（bundled / userData）；应统一走 `~/.openworker/skills`
- 在工作流中强制执行仅 Desktop 需要的增强阶段
- 在宿主侧重复实现 MCP 连接池 / 工具绑定（应走 send 内置加载与 `OpenWorkerAgent.mcp`）
- 将 MCP 实现细节从包根大量导出（连接池、buildTools 等应保持包内私有）
- 自定义与 AI SDK 平行的 Message / Tool 数据结构（应直接使用 CoreMessage / ToolSet）
- 在 agent 包内使用或收集 `ToolTimelineEvent`（UI/IPC 时间线类型，应由宿主从 AG-UI 事件派生）
- 依赖 AG-UI 对 `forwardedProps` 原样保留函数/LanguageModel（`runAgent` 会 `structuredClone`；`OpenWorkerAgent` 已剥离 `provider` / `abortController`）
