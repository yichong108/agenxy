/**
 * @openworker/cursor-agent 公共 API — 宿主入口为 CursorAgent（AG-UI）。
 *
 * 勿在宿主直接使用 @cursor/sdk；一律经 CursorAgent.runAgent / subscribe / abortRun。
 */

export {
  CursorAgent,
  type CursorAgentConfig,
  type CursorAgentMcp,
  type CursorAgentRunDefaults
} from './createCursorAGUIAgent.js'
