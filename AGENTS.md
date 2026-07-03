# Agent instructions

This file guides AI assistants and contributors working on this repository.

## Project

**Agenxy** — an Electron desktop app for agents (React, Ant Design, AI SDK, MCP). Main code lives under `src/` (`main`, `renderer`, `preload`).

## Package Manager

- **pnpm is the only allowed package manager.** npm must not be used for this project. All dependency management operations (installing, updating, adding dependencies) must be performed using pnpm.

## Language and commits

- **Git commit messages, PR titles, and PR descriptions must be written in English.** Use clear, imperative-style subjects (e.g. "Fix workspace pane scroll", "Add MCP reconnect handler"). Body text may add context in English when helpful.
- **Follow Conventional Commits format:** `<type>(<scope>): <description>`

  - **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `merge`, `improvement`
  - **Scope:** optional, describes the module/page (e.g., `feat(auth):`, `fix(payment):`)
  - **Description:** imperative mood, max 50 characters, no period
  - **Examples:**
    - `feat(auth): add OAuth2 support`
    - `fix(api): resolve rate limit bypass`
    - `perf(dashboard): lazy load chart data`
    - `docs: update API documentation`
  - **Breaking changes:** add `!` before `:` or include `BREAKING CHANGE:` in footer

- **Changelog-style or release notes entries** intended for the repo or automation should also be in English unless an existing localized process says otherwise.
- User-facing UI copy and docs may follow product language choices; this rule applies to **version control and review metadata** (commits, PRs, merge commit messages).

## Code changes

- Keep diffs focused on the requested task; avoid unrelated refactors.
- Match existing naming, imports, and patterns in touched files.
- Run checks the project defines (e.g. `pnpm typecheck`, `pnpm lint`) before opening a PR when feasible.
- 需要lint:fix并修复

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

## Communication

- When the maintainer asks for responses in a specific language (e.g. chat replies), follow that request for **conversation**; **commits and PR text remain English** as above.
