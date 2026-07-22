import { createApp } from './app.js';
import { env } from './config/env.js';

/**
 * 启动 API HTTP 服务
 *
 * 绑定配置端口并输出启动日志。启动失败时以非零退出码结束进程，
 * 方便进程管理器识别并重启。
 */
async function main() {
  const app = createApp();

  app.listen(env.port, () => {
    console.log(`[api] listening on http://127.0.0.1:${env.port}`);
    console.log(`[api] health check: GET /health`);
  });
}

main().catch((error) => {
  console.error('[api] failed to start', error);
  process.exit(1);
});
