import { Router } from 'express';
import type { LoginRequest } from '@luneto/shared';

import {
  getUserFromAccessToken,
  InvalidCredentialsError,
  loginWithPassword
} from '../services/auth-service.js';

/** 与桌面端 `request.ts` 对齐的统一响应 envelope */
type ApiEnvelope<T> = {
  code: number;
  message: string;
  data: T | null;
};

/**
 * 构造成功响应（HTTP 200 + code 0）
 *
 * @param data - 业务数据
 * @param message - 可选提示文案
 */
function ok<T>(data: T, message = 'ok'): ApiEnvelope<T> {
  return { code: 0, message, data };
}

/**
 * 构造业务失败响应（HTTP 200 + 非 0 code，供客户端 envelope 解包）
 *
 * @param code - 业务错误码
 * @param message - 错误说明
 */
function fail(code: number, message: string): ApiEnvelope<null> {
  return { code, message, data: null };
}

/**
 * 认证路由
 *
 * - POST /auth/login — 账号密码登录，返回 JWT 与用户信息
 * - GET  /auth/me    — 用 Bearer token 查询当前用户（可选，便于会话恢复）
 *
 * 当前不提供注册接口。响应统一为 `{ code, message, data }`。
 */
export const authRouter = Router();

authRouter.post('/auth/login', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Partial<LoginRequest>;
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username.trim() || !password) {
      res.status(200).json(fail(40001, 'username and password are required'));
      return;
    }

    const data = await loginWithPassword(username, password);
    res.status(200).json(ok(data));
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      res.status(200).json(fail(40101, error.message));
      return;
    }
    console.error('[api] POST /auth/login failed', error);
    res.status(200).json(
      fail(50001, error instanceof Error ? error.message : String(error))
    );
  }
});

authRouter.get('/auth/me', async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(200).json(fail(40102, 'Missing or invalid Authorization header'));
      return;
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      res.status(200).json(fail(40102, 'Missing access token'));
      return;
    }

    const user = await getUserFromAccessToken(token);
    if (!user) {
      res.status(200).json(fail(40102, 'Invalid or expired token'));
      return;
    }

    res.status(200).json(ok({ user }));
  } catch (error) {
    console.error('[api] GET /auth/me failed', error);
    res.status(200).json(
      fail(50002, error instanceof Error ? error.message : String(error))
    );
  }
});
