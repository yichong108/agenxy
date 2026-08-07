import { Router } from 'express'
import type {
  CreateSessionRequest,
  CreateWorkspaceRequest,
  PatchWorkspaceRequest,
  ReorderWorkspacesRequest
} from '@openworker/shared'

import { fail, ok, BadRequestError, NotFoundError } from '../http/envelope.js'
import { getAuthedUser, requireAuth } from '../middleware/auth.js'
import { createSession, listSessions } from '../services/session-service.js'
import {
  createWorkspace,
  listWorkspaces,
  patchWorkspace,
  reorderWorkspaces,
  softDeleteWorkspace
} from '../services/workspace-service.js'

/**
 * 工作空间路由（需 JWT）
 *
 * - GET/POST /workspaces
 * - PUT /workspaces/reorder
 * - PATCH/DELETE /workspaces/:id
 * - GET/POST /workspaces/:workspaceId/sessions
 */
export const workspacesRouter = Router()

workspacesRouter.use(requireAuth)

workspacesRouter.get('/workspaces', async (req, res) => {
  try {
    const user = getAuthedUser(req)
    const list = await listWorkspaces(user.id)
    res.status(200).json(ok({ list }))
  } catch (error) {
    console.error('[api] GET /workspaces failed', error)
    res.status(200).json(fail(50010, error instanceof Error ? error.message : String(error)))
  }
})

workspacesRouter.post('/workspaces', async (req, res) => {
  try {
    const user = getAuthedUser(req)
    const body = (req.body ?? {}) as CreateWorkspaceRequest
    const workspace = await createWorkspace(user.id, body)
    res.status(200).json(ok({ workspace }))
  } catch (error) {
    if (error instanceof BadRequestError) {
      res.status(200).json(fail(40010, error.message))
      return
    }
    console.error('[api] POST /workspaces failed', error)
    res.status(200).json(fail(50011, error instanceof Error ? error.message : String(error)))
  }
})

workspacesRouter.put('/workspaces/reorder', async (req, res) => {
  try {
    const user = getAuthedUser(req)
    const body = (req.body ?? {}) as ReorderWorkspacesRequest
    const list = await reorderWorkspaces(user.id, body.orderedIds)
    res.status(200).json(ok({ list }))
  } catch (error) {
    if (error instanceof BadRequestError) {
      res.status(200).json(fail(40011, error.message))
      return
    }
    console.error('[api] PUT /workspaces/reorder failed', error)
    res.status(200).json(fail(50012, error instanceof Error ? error.message : String(error)))
  }
})

workspacesRouter.patch('/workspaces/:id', async (req, res) => {
  try {
    const user = getAuthedUser(req)
    const body = (req.body ?? {}) as PatchWorkspaceRequest
    const workspace = await patchWorkspace(user.id, req.params.id!, body)
    res.status(200).json(ok({ workspace }))
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(200).json(fail(40410, error.message))
      return
    }
    if (error instanceof BadRequestError) {
      res.status(200).json(fail(40012, error.message))
      return
    }
    console.error('[api] PATCH /workspaces/:id failed', error)
    res.status(200).json(fail(50013, error instanceof Error ? error.message : String(error)))
  }
})

workspacesRouter.delete('/workspaces/:id', async (req, res) => {
  try {
    const user = getAuthedUser(req)
    await softDeleteWorkspace(user.id, req.params.id!)
    res.status(200).json(ok({ ok: true }))
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(200).json(fail(40410, error.message))
      return
    }
    console.error('[api] DELETE /workspaces/:id failed', error)
    res.status(200).json(fail(50014, error instanceof Error ? error.message : String(error)))
  }
})

workspacesRouter.get('/workspaces/:workspaceId/sessions', async (req, res) => {
  try {
    const user = getAuthedUser(req)
    const list = await listSessions(user.id, req.params.workspaceId!)
    res.status(200).json(ok({ list }))
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(200).json(fail(40410, error.message))
      return
    }
    console.error('[api] GET /workspaces/:workspaceId/sessions failed', error)
    res.status(200).json(fail(50020, error instanceof Error ? error.message : String(error)))
  }
})

workspacesRouter.post('/workspaces/:workspaceId/sessions', async (req, res) => {
  try {
    const user = getAuthedUser(req)
    const body = (req.body ?? {}) as CreateSessionRequest
    const session = await createSession(user.id, req.params.workspaceId!, body)
    res.status(200).json(ok({ session }))
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(200).json(fail(40410, error.message))
      return
    }
    if (error instanceof BadRequestError) {
      res.status(200).json(fail(40020, error.message))
      return
    }
    console.error('[api] POST /workspaces/:workspaceId/sessions failed', error)
    res.status(200).json(fail(50021, error instanceof Error ? error.message : String(error)))
  }
})
