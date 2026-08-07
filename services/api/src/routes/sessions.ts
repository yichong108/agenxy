import { Router } from 'express'
import type { PatchSessionRequest, SessionMessagesPayload } from '@openworker/shared'

import { fail, ok, BadRequestError, NotFoundError } from '../http/envelope.js'
import { getAuthedUser, requireAuth } from '../middleware/auth.js'
import {
  getSessionMessages,
  patchSession,
  putSessionMessages,
  softDeleteSession
} from '../services/session-service.js'

/**
 * 会话路由（需 JWT）
 *
 * - PATCH/DELETE /sessions/:id
 * - GET/PUT /sessions/:id/messages
 */
export const sessionsRouter = Router()

sessionsRouter.use(requireAuth)

sessionsRouter.patch('/sessions/:id', async (req, res) => {
  try {
    const user = getAuthedUser(req)
    const body = (req.body ?? {}) as PatchSessionRequest
    const session = await patchSession(user.id, req.params.id!, body)
    res.status(200).json(ok({ session }))
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(200).json(fail(40420, error.message))
      return
    }
    if (error instanceof BadRequestError) {
      res.status(200).json(fail(40021, error.message))
      return
    }
    console.error('[api] PATCH /sessions/:id failed', error)
    res.status(200).json(fail(50022, error instanceof Error ? error.message : String(error)))
  }
})

sessionsRouter.delete('/sessions/:id', async (req, res) => {
  try {
    const user = getAuthedUser(req)
    await softDeleteSession(user.id, req.params.id!)
    res.status(200).json(ok({ ok: true }))
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(200).json(fail(40420, error.message))
      return
    }
    console.error('[api] DELETE /sessions/:id failed', error)
    res.status(200).json(fail(50023, error instanceof Error ? error.message : String(error)))
  }
})

sessionsRouter.get('/sessions/:id/messages', async (req, res) => {
  try {
    const user = getAuthedUser(req)
    const data = await getSessionMessages(user.id, req.params.id!)
    res.status(200).json(ok(data))
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(200).json(fail(40420, error.message))
      return
    }
    console.error('[api] GET /sessions/:id/messages failed', error)
    res.status(200).json(fail(50024, error instanceof Error ? error.message : String(error)))
  }
})

sessionsRouter.put('/sessions/:id/messages', async (req, res) => {
  try {
    const user = getAuthedUser(req)
    const body = (req.body ?? {}) as SessionMessagesPayload
    const data = await putSessionMessages(user.id, req.params.id!, body)
    res.status(200).json(ok(data))
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(200).json(fail(40420, error.message))
      return
    }
    if (error instanceof BadRequestError) {
      res.status(200).json(fail(40022, error.message))
      return
    }
    console.error('[api] PUT /sessions/:id/messages failed', error)
    res.status(200).json(fail(50025, error instanceof Error ? error.message : String(error)))
  }
})
