# @openworker/cursor-agent

Cursor SDK local 运行时的 AG-UI 适配包。

## 一句话

导出 `CursorAgent`（`AbstractAgent`），宿主用法与 `@openworker/agent` 的 `OpenWorkerAgent` 对齐；内部用 `@cursor/sdk`，不对宿主暴露 SDK 细节。

## 边界

- 宿主只经 `runAgent` / `subscribe` / `abortRun` / `dispose` 交互。
- 仅支持 local runtime（`local.cwd`）。
- v1 不注入 OpenWorker MCP / Skills；`mcp` 为空实现以保接口一致。
- `settingSources: []`，避免误加载 Cursor IDE 全量配置。

## 使用

```ts
import { CursorAgent } from '@openworker/cursor-agent'

const agent = new CursorAgent({
  agentId: 'cursor-desktop',
  agent: {
    apiKey: process.env.CURSOR_API_KEY!,
    model: 'composer-2.5',
    local: { cwd: '/path/to/workspace' }
  }
})

await agent.runAgent({ runId: 'r1' })
```
