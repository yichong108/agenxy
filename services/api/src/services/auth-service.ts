import type { AuthUser, LoginResult } from '@luneto/shared';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { RowDataPacket } from 'mysql2/promise';

import { env } from '../config/env.js';
import { mysqlPool } from '../db/mysql.js';

type UserRow = RowDataPacket & {
  id: string;
  username: string;
  password_hash: string;
  role: string;
};

/** 登录失败时抛出，由路由映射为 HTTP 401 */
export class InvalidCredentialsError extends Error {
  constructor(message = 'Invalid username or password') {
    super(message);
    this.name = 'InvalidCredentialsError';
  }
}

/** JWT 载荷中的用户声明 */
export type AuthTokenPayload = {
  sub: string;
  username: string;
  role: string;
};

/**
 * 将数据库用户行映射为对外公开的 AuthUser（不含密码）
 *
 * @param row - users 表行
 * @returns 公开用户信息
 */
function toAuthUser(row: Pick<UserRow, 'id' | 'username' | 'role'>): AuthUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role
  };
}

/**
 * 校验账号密码并签发 access token
 *
 * @param username - 登录账号（去首尾空白后匹配）
 * @param password - 明文密码
 * @returns 含 accessToken 与用户公开信息的登录结果
 * @throws {InvalidCredentialsError} 账号不存在或密码不匹配
 */
export async function loginWithPassword(
  username: string,
  password: string
): Promise<LoginResult> {
  const normalized = username.trim();
  if (!normalized || !password) {
    throw new InvalidCredentialsError();
  }

  const [rows] = await mysqlPool.query<UserRow[]>(
    'SELECT id, username, password_hash, role FROM users WHERE username = ? LIMIT 1',
    [normalized]
  );
  const row = rows[0];
  if (!row) {
    throw new InvalidCredentialsError();
  }

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) {
    throw new InvalidCredentialsError();
  }

  const user = toAuthUser(row);
  const payload: AuthTokenPayload = {
    sub: user.id,
    username: user.username,
    role: user.role
  };
  const accessToken = jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn']
  });

  return { accessToken, user };
}

/**
 * 校验 Bearer token 并返回对应用户公开信息
 *
 * @param token - JWT access token（不含 Bearer 前缀）
 * @returns 用户公开信息；token 无效或用户已删除时返回 null
 */
export async function getUserFromAccessToken(token: string): Promise<AuthUser | null> {
  let payload: AuthTokenPayload;
  try {
    payload = jwt.verify(token, env.jwtSecret) as AuthTokenPayload;
  } catch {
    return null;
  }

  if (!payload?.sub) return null;

  const [rows] = await mysqlPool.query<UserRow[]>(
    'SELECT id, username, role FROM users WHERE id = ? LIMIT 1',
    [payload.sub]
  );
  const row = rows[0];
  if (!row) return null;
  return toAuthUser(row);
}
