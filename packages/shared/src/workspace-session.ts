/**
 * 工作空间 / 会话 API 共享 DTO
 *
 * 与 Desktop IPC 的 WorkspaceInfo / SessionInfo 对齐；时间戳为 epoch ms。
 * 消息载荷透传 AG-UI Message[]，服务端不解析语义。
 */

/** 固定 ID：用户主目录工作区（每用户未删除唯一一条） */
export const HOME_WORKSPACE_ID = 'workspace-home'

/**
 * 工作空间元数据（列表与详情）
 */
export type WorkspaceDto = {
  id: string
  name: string
  path: string | null
  createdAt: number
  updatedAt: number
  isDefault?: boolean
  /** 侧栏排序，越小越靠前 */
  sortOrder: number
}

/**
 * 创建工作空间请求体
 */
export type CreateWorkspaceRequest = {
  id?: string
  name: string
  path?: string | null
  isDefault?: boolean
  sortOrder?: number
}

/**
 * 更新工作空间请求体（部分字段）
 */
export type PatchWorkspaceRequest = {
  name?: string
  path?: string | null
  isDefault?: boolean
}

/**
 * 重排工作空间请求体
 */
export type ReorderWorkspacesRequest = {
  /** 未删除工作区的完整有序 id 列表 */
  orderedIds: string[]
}

/**
 * 会话元数据（列表项不含 messages）
 */
export type SessionDto = {
  id: string
  workspaceId: string
  name: string
  createdAt: number
  updatedAt: number
}

/**
 * 创建会话请求体
 */
export type CreateSessionRequest = {
  id?: string
  name?: string
}

/**
 * 更新会话请求体
 */
export type PatchSessionRequest = {
  name?: string
  /** 为 true 时刷新 updatedAt（例如发消息后 touch） */
  touch?: boolean
}

/**
 * 会话消息整包载荷 — 完整 AG-UI Message[] 无损存储
 *
 * `messages` 为 JSON 透传数组，结构与 `@ag-ui/client` 的 Message 对齐。
 */
export type SessionMessagesPayload = {
  messages: unknown[]
}
