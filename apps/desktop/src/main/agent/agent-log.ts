import { logScope } from '@/main/logger'

/** Agent 主流程日志 scope，供 agent-service、graph 节点与 intent-classifier 共用。 */
export const agentLog = logScope('agent')
