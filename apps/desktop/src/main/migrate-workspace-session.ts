import type { Message } from '@ag-ui/client'

import { hasAccessToken } from '@/main/auth-token'
import { mainLog } from '@/main/logger'
import {
  clearLegacyLocalWorkspaceSessionKeys,
  isWorkspaceSessionMigratedToApi,
  listWorkspaces,
  markWorkspaceSessionMigratedToApi,
  readLegacyLocalWorkspaceSessionData
} from '@/main/store'
import {
  apiCreateSession,
  apiCreateWorkspace,
  apiListSessions,
  apiListWorkspaces,
  apiPutSessionMessages,
  logWorkspaceSessionApiError
} from '@/main/workspace-session-api'
import type { ChatMessage } from '@/shared/ipc'
import { HOME_WORKSPACE_ID } from '@/shared/ipc'

/**
 * 将旧版有损 ChatMessage 尽量映射为 AG-UI Message[]
 *
 * @param list - 本地 ChatMessage
 */
function chatMessagesToAgui(list: ChatMessage[]): Message[] {
  const out: Message[] = []
  for (const msg of list) {
    if (!msg?.id || !msg.content?.trim()) continue
    if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') {
      out.push({ id: msg.id, role: msg.role, content: msg.content })
    }
  }
  return out
}

/**
 * 一次性将 electron-store 中的 workspace/session 上传到 API，然后清除本地键
 *
 * 仅当远端几乎为空（仅可能有自动 Home）且本地有数据时执行。
 */
export async function migrateLocalWorkspaceSessionToApiIfNeeded(): Promise<void> {
  if (!hasAccessToken()) return
  if (isWorkspaceSessionMigratedToApi()) return

  const legacy = readLegacyLocalWorkspaceSessionData()
  const hasLocalWorkspaces = legacy.workspaces.length > 0
  const hasLocalSessions = Object.values(legacy.sessionsMetaByWorkspace).some((x) => x.length > 0)
  const hasLocalMessages = Object.values(legacy.sessionsMessagesByWorkspace).some(
    (bucket) => Object.keys(bucket).length > 0
  )

  if (!hasLocalWorkspaces && !hasLocalSessions && !hasLocalMessages) {
    markWorkspaceSessionMigratedToApi()
    clearLegacyLocalWorkspaceSessionKeys()
    return
  }

  try {
    const remoteWorkspaces = await apiListWorkspaces()
    const nonHomeRemote = remoteWorkspaces.filter((w) => w.id !== HOME_WORKSPACE_ID)
    let remoteSessionCount = 0
    for (const w of remoteWorkspaces) {
      const sessions = await apiListSessions(w.id)
      remoteSessionCount += sessions.length
    }

    // 远端已有用户数据则跳过上传，只清本地键
    if (nonHomeRemote.length > 0 || remoteSessionCount > 0) {
      mainLog.info('[migrate] remote already has data; skip upload, clear local keys')
      markWorkspaceSessionMigratedToApi()
      clearLegacyLocalWorkspaceSessionKeys()
      return
    }

    mainLog.info('[migrate] uploading legacy workspace/session data to API')

    for (const ws of legacy.workspaces) {
      if (ws.id === HOME_WORKSPACE_ID) {
        // Home 由 hydrate/ensure 保证；尽量补 path
        continue
      }
      try {
        await apiCreateWorkspace({
          id: ws.id,
          name: ws.name,
          path: ws.path,
          isDefault: ws.isDefault,
          sortOrder: legacy.workspaces.indexOf(ws)
        })
      } catch (error) {
        logWorkspaceSessionApiError(`migrate workspace ${ws.id}`, error)
      }
    }

    // 刷新后 Home 等已在远端
    const after = await apiListWorkspaces()
    const remoteIds = new Set(after.map((w) => w.id))

    for (const [workspaceId, sessions] of Object.entries(legacy.sessionsMetaByWorkspace)) {
      if (!remoteIds.has(workspaceId) && workspaceId !== HOME_WORKSPACE_ID) {
        // 工作区创建失败则跳过
        continue
      }
      const targetWs = remoteIds.has(workspaceId) ? workspaceId : HOME_WORKSPACE_ID
      for (const session of sessions) {
        try {
          await apiCreateSession(targetWs, { id: session.id, name: session.name })
          const chat =
            legacy.sessionsMessagesByWorkspace[workspaceId]?.[session.id] ||
            legacy.sessionsMessagesByWorkspace[targetWs]?.[session.id] ||
            []
          const messages = chatMessagesToAgui(chat)
          if (messages.length > 0) {
            await apiPutSessionMessages(session.id, messages)
          }
        } catch (error) {
          logWorkspaceSessionApiError(`migrate session ${session.id}`, error)
        }
      }
    }

    markWorkspaceSessionMigratedToApi()
    clearLegacyLocalWorkspaceSessionKeys()
    mainLog.info('[migrate] legacy workspace/session migration done')
    // 调用方应 re-hydrate；此处仅保证 listWorkspaces 仍可用
    void listWorkspaces()
  } catch (error) {
    logWorkspaceSessionApiError('migrateLocalWorkspaceSessionToApiIfNeeded', error)
  }
}
