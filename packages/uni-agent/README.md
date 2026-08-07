# @openworker/uni-agent

统一 AG-UI Agent 门面。

## 一句话

只暴露 `UniAgent` 类（`extends AbstractAgent`）。按 `agentType` 在内部委托 OpenWorker 或 Cursor 后端；宿主不直接依赖这两个包。

## 使用

```ts
import { UniAgent } from '@openworker/uni-agent'

const agent = new UniAgent({
  agentType, // 'openworker' | 'cursor' — 由本类内部选型
  agentId: 'desktop-session',
  threadId: 'session-1',
  cwd: '/path/to/workspace',
  cursorApiKey: '...',
  cursorModel: 'composer-2.5'
})

agent.assertReady({ provider })
const forwardedProps = agent.buildRunForwardedProps({
  composerMode: 'build',
  abortController,
  workspacePath: cwd,
  provider
})
await agent.runAgent({ runId: 'r1', forwardedProps })
await agent.dispose()
```

MCP 宿主：

```ts
const mcpHost = new UniAgent({
  agentType: 'openworker',
  role: 'mcp-host',
  agentId: 'mcp-host'
})
await mcpHost.mcp.warmup()
await mcpHost.dispose()
```

## 边界

- AG-UI 入口：仅 `UniAgent`
- Desktop 等宿主：只依赖本包
- 终端 / 路径 / skills / `resolveChatModel` 为本包附带的宿主工具转发（非第二套 Agent API）
