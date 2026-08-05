# 心智架构

## 一句话

负责创建Agent。
Agent核心是ReAct；
Agent不负责流程编排；
Agent可选Skills；
Agent可选MCP。

会话消息与工具统一使用 AI SDK 的 `CoreMessage` / `Tool` / `ToolSet`。

## 边界与依赖

createAgent的内部不依赖外部，只依赖createAgent的入参。
send的内部不依赖外部，只依赖send的入参

## 反模式（本模块已出现过/严禁）

- 让 agent 依赖宿主特有的 skills 目录布局（bundled / market / userData）

- 在工作流中强制执行仅 Desktop 需要的增强阶段

- 在宿主侧重复实现 MCP 连接池 / 工具绑定（应走 `send({ mcp: { configPath } })` 与 `agent.mcp`）
- 将 MCP 实现细节从包根大量导出（连接池、buildTools 等应保持包内私有）
- 自定义与 AI SDK 平行的 Message / Tool 数据结构（应直接使用 CoreMessage / ToolSet）
- 在 agent 包内使用或收集 `ToolTimelineEvent`（UI/IPC 时间线类型，应由宿主在 `onTool` 中映射与持有）
