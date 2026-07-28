import { Router } from 'express';
import type { AppSettings } from '@agenxy/shared';

import { getAppSettings, patchAppSettings } from '../services/settings-service.js';

/**
 * 应用 Settings 路由
 *
 * - GET  /settings — 读取全局 settings
 * - PUT  /settings — 合并更新全局 settings（body 为 Partial AppSettings）
 *
 * 当前无用户鉴权，读写同一条 default 记录。
 */
export const settingsRouter = Router();

settingsRouter.get('/settings', async (_req, res) => {
  try {
    const data = await getAppSettings();
    res.json({ data });
  } catch (error) {
    console.error('[api] GET /settings failed', error);
    res.status(500).json({
      error: 'failed_to_get_settings',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

settingsRouter.put('/settings', async (req, res) => {
  try {
    const patch = (req.body ?? {}) as Partial<AppSettings>;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      res.status(400).json({
        error: 'invalid_body',
        message: 'Request body must be a JSON object (Partial<AppSettings>)'
      });
      return;
    }
    const data = await patchAppSettings(patch);
    res.json({ data });
  } catch (error) {
    console.error('[api] PUT /settings failed', error);
    res.status(500).json({
      error: 'failed_to_update_settings',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});
