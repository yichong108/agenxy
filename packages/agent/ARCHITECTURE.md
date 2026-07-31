# 心智架构

## 一句话

负责提供 Agent 创建的工厂。引擎核心是工具循环与模型；内建工作区工具与可选 Skills 是基础层——MCP / 意图筛选是宿主增强。

## 边界与依赖

**属于本包：**

- `createAgent` 工厂与 `send` 运行入口
- ReAct 工具循环、消息模型、工具定义（`defineTool`）
- 内建工作区工具：文件系统、grep、shell、可选 Tavily 联网搜索（`buildWorkspaceTools`）
- 可选的基础 Skills：仅通过 `skills.paths` 配置扫描路径，加载 `SKILL.md` 为工具
- 宿主可注入 `prepareTooling` / `wrapReactRun` 覆盖默认组装

**不属于本包（由宿主可选实现）：**

- 意图分类、按意图筛选 skills
- Skills 市场安装、Electron 路径、UI 状态
- MCP 连接与元工具

**依赖：** `@agenwork/shared`、AI SDK、zod、`@vscode/ripgrep`。不依赖 Desktop / Electron。

## 反模式（本模块已出现过/严禁）

- 将意图分类、skill 标签表硬编码进 agent 核心
- 让 agent 依赖宿主特有的 skills 目录布局（bundled / market / userData）
- 在工作流中强制执行仅 Desktop 需要的增强阶段
