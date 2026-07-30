# Agent 说明

本文件用于指导在本仓库中工作的 AI 助手与贡献者。

## 项目

**Agenwork** — 面向智能体的 Electron 桌面应用（React、Ant Design、AI SDK、MCP）。主要代码位于 `src/`（`main`、`renderer`、`preload`）。

## 包管理器

- **仅允许使用 pnpm。** 本项目禁止使用 npm。所有依赖管理操作（安装、更新、添加依赖）必须使用 pnpm。

## 语言与提交

- **Git 提交信息、PR 标题与 PR 描述必须使用英文。** 使用清晰的祈使句式主题（例如 "Fix workspace pane scroll"、"Add MCP reconnect handler"）。正文可在有帮助时补充英文上下文。
- **遵循 Conventional Commits 格式：** `<type>(<scope>): <description>`
  - **类型（Types）：** `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore`、`merge`、`improvement`
  - **范围（Scope）：** 可选，描述模块/页面（例如 `feat(auth):`、`fix(payment):`）
  - **描述（Description）：** 祈使语气，最多 50 个字符，不加句号
  - **示例：**
    - `feat(auth): add OAuth2 support`
    - `fix(api): resolve rate limit bypass`
    - `perf(dashboard): lazy load chart data`
    - `docs: update API documentation`
  - **破坏性变更：** 在 `:` 前加 `!`，或在 footer 中写 `BREAKING CHANGE:`
- **面向仓库或自动化的 Changelog / 发布说明** 也应使用英文，除非已有本地化流程另有规定。
- 面向用户的 UI 文案与文档可按产品语言选择；本规则适用于**版本控制与评审元数据**（提交、PR、合并提交信息）。



## 代码变更

- 保持 diff 聚焦于所请求的任务；避免无关重构。
- 在改动的文件中沿用现有命名、导入与模式。
- 在可行时，打开 PR 前运行项目定义的检查（例如 `pnpm typecheck`、`pnpm lint`）。
- 需要 lint:fix 并修复



### 注释规范



#### 函数注释

- **必须为所有导出函数添加注释**，描述函数的用途、意图和实现原因
- 使用 JSDoc 格式：`/** ... */`
- 注释应包含：
  - 函数的**目的**（做什么）
  - **参数说明**：每个参数的类型、含义和约束条件
  - **返回值说明**：返回值的类型和含义
  - **异常/错误情况**：可能抛出的异常及触发条件
  - **设计决策**：为什么这样实现，关键算法或权衡取舍

```typescript
/**
 * 获取会话列表并按更新时间排序
 * 
 * 此函数从本地存储读取所有会话，过滤掉已删除的会话，
 * 并按最后更新时间降序排列。
 * 
 * @param filterDeleted - 是否过滤已删除的会话
 * @returns 会话列表，按更新时间从新到旧排序
 * @throws {StorageError} 当读取存储失败时抛出
 */
function getSessions(filterDeleted: boolean = true): Session[] {
  // ...
}
```



#### 变量注释

- **必须为复杂或非直观的变量添加注释**
- 注释应说明变量的**含义**、**用途**和**约束条件**
- 对于简单的局部变量（如循环计数器 `i`），无需强制添加注释

```typescript
// 会话过期时间（毫秒）- 用户30天未访问的会话将被标记为过期
const SESSION_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;

// 当前活动的会话ID，用于UI高亮显示
let activeSessionId: string | null = null;
```



#### 类和接口注释

- **必须为导出的类和接口添加注释**
- 说明类/接口的职责、核心功能和设计模式

```typescript
/**
 * 会话管理器 - 负责会话的创建、读取、更新和删除操作
 * 
 * 使用单例模式确保全局只有一个会话管理器实例，
 * 所有会话操作都通过此类进行统一管理。
 */
class SessionManager {
  // ...
}
```

## 沟通

- 当维护者要求以特定语言回复时（例如聊天回复），按该要求进行**对话**；**提交与 PR 文本仍须使用英文**（见上文）。



# 架构


## 模块心智文档
- [@agenwork/agent](packages/agent/ARCHITECTURE.md) 智能体
- [@agenwork/shared](packages/shared/ARCHITECTURE.md) 公用工具
- [@agenwork/api](services/api/ARCHITECTURE.md) 后端API服务
- [@agenwork/desktop](apps/desktop/ARCHITECTURE.md) 桌面客户端
- [@agenwork/shared](apps/landing/ARCHITECTURE.md) 文档项目
