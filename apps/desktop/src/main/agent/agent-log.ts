import { setAgentLogger } from '@agenxy/agent'

import { logScope } from '@/main/logger'

const scope = logScope('agent')
setAgentLogger(scope)

export const agentLog = scope
