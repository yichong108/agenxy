import { createApp } from './app.js';
import { env } from './config/env.js';
import { ensureSchema } from './db/schema.js';

/**
 * 启动 API HTTP 服务
 *
 * 先确保 MySQL schema 就绪，再绑定配置端口并输出启动日志。
 * 启动失败时以非零退出码结束进程，方便进程管理器识别并重启。
 */
async function main() {
  await ensureSchema();
  console.log('[api] mysql schema ready');

  const app = createApp();

  app.listen(env.port, () => {
    console.log(`[api] listening on http://127.0.0.1:${env.port}`);
    console.log('[api] health check: GET /health');
    console.log('[api] auth: POST /auth/login, GET /auth/me');
    console.log('[api] settings: GET|PUT /settings');
  });
}

main().catch((error) => {
  console.error('[api] failed to start', error);
  process.exit(1);
});
