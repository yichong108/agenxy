import cors from 'cors';
import express from 'express';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';

/**
 * 创建并配置 Express 应用实例
 *
 * 注册通用中间件与路由。与 HTTP 监听解耦，便于单测直接注入 app，
 * 无需真正绑定端口。
 *
 * @returns 配置完成的 Express 应用
 */
export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(healthRouter);
  app.use(authRouter);
  app.use(settingsRouter);

  return app;
}
