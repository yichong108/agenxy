# 心智架构

## 一句话

负责创建Agent。
Agent核心是ReAct；
Agent不负责流程编排；
Agent可选Skills；
Agent可选MCP。

会话消息与工具统一使用 AI SDK 的 `CoreMessage` / `Tool` / `ToolSet`。

## 边界与依赖

createAgent 的内部不依赖外部，只依赖 createAgent 的入参。
send 的 Skills / MCP 按用户目录约定自动加载：`~/.openworker/skills` 与 `~/.openworker/mcp.json`（可通过 `getOpenworkerSkillsPath` / `getOpenworkerMcpConfigPath` 读取同一路径）。

## 反模式（本模块已出现过/严禁）

- 让 agent 依赖宿主特有的 skills 目录布局（bundled / userData）；应统一走 `~/.openworker/skills`

- 在工作流中强制执行仅 Desktop 需要的增强阶段

- 在宿主侧重复实现 MCP 连接池 / 工具绑定（应走 send 内置加载与 `agent.mcp`）
- 将 MCP 实现细节从包根大量导出（连接池、buildTools 等应保持包内私有）
- 自定义与 AI SDK 平行的 Message / Tool 数据结构（应直接使用 CoreMessage / ToolSet）
- 在 agent 包内使用或收集 `ToolTimelineEvent`（UI/IPC 时间线类型，应由宿主在 `onTool` 中映射与持有）
