# 心智架构



## 一句话



负责提供 Agent 创建的工厂。引擎核心是工具循环与模型；内建工作区工具、可选 Skills，以及可选 MCP（由 `mcp.configPath` 驱动）是基础层。



## 边界与依赖



**属于本包：**



- `createAgent` 工厂与 `send` 运行入口

- ReAct 工具循环、消息模型、工具定义（`defineTool`）

- 内建工作区工具：文件系统、grep、shell、可选 Tavily 联网搜索（`buildWorkspaceTools`）

- 可选的基础 Skills：仅通过 `skills.paths` 配置扫描路径，加载 `SKILL.md` 为工具

- 可选 MCP：通过 `mcp.configPath` 读取配置文件，内部实现连接池与工具绑定；宿主侧仅用 `agent.mcp`（probe / warmup / dispose）
- 宿主可注入 `prepareTooling`；注入时仍会按 `mcp.configPath` 自动叠加 MCP



**不属于本包（由宿主可选实现）：**



- Skills 市场安装、Electron 路径、UI 状态

- MCP 配置文件的 UI 编辑与落盘路径选择（宿主负责写入 `mcp.configPath` 指向的文件）



**依赖：** `@agenwork/shared`、AI SDK、zod、`@vscode/ripgrep`、`@modelcontextprotocol/sdk`。不依赖 Desktop / Electron。



## 反模式（本模块已出现过/严禁）



- 让 agent 依赖宿主特有的 skills 目录布局（bundled / market / userData）

- 在工作流中强制执行仅 Desktop 需要的增强阶段

- 在宿主侧重复实现 MCP 连接池 / 工具绑定（应走 `mcp.configPath` 与 `agent.mcp`）
- 将 MCP 实现细节从包根大量导出（连接池、buildTools 等应保持包内私有）
