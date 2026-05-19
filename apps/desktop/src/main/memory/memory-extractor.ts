import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'

import { createLangfuseCallbackHandler } from '@/main/langfuse'
import { logScope } from '@/main/logger'
import {
  applyMemoryExtractionActions,
  type MemoryExtractionAction
} from '@/main/memory/memory-service'
import { getSettings, getUserMemories } from '@/main/store'
import { getActiveProviderProfile, type AppSettings } from '@/shared/ipc'

const memLog = logScope('memory')

const MemoryExtractionSchema = z.object({
  actions: z
    .array(
      z.object({
        op: z.enum(['add', 'update', 'delete']),
        id: z.string().optional(),
        content: z.string().optional()
      })
    )
    .describe('Memory mutations to apply; empty if nothing durable to remember')
})

const MIN_ASSISTANT_CHARS_FOR_EXTRACT = 24
const MAX_TURN_TEXT_CHARS = 2000

function ensureOpenAiV1BaseUrl(baseUrl: string, fallback: string): string {
  const u = baseUrl.trim() || fallback
  if (!u) return fallback
  if (/\/v1\/?$/i.test(u)) return u.replace(/\/+$/, '')
  return `${u.replace(/\/+$/, '')}/v1`
}

function createLanguageModel(settings: AppSettings) {
  const profile = getActiveProviderProfile(settings)
  const apiKey = profile.apiKey?.trim() || ''
  const baseURL = ensureOpenAiV1BaseUrl(profile.baseUrl, 'https://api.deepseek.com/v1')
  return new ChatOpenAI({
    apiKey,
    model: profile.model,
    configuration: { baseURL },
    streaming: false,
    temperature: 0
  })
}

function truncateTurnText(text: string): string {
  const t = text.trim()
  if (t.length <= MAX_TURN_TEXT_CHARS) return t
  return `${t.slice(0, MAX_TURN_TEXT_CHARS)}…`
}

/**
 * After a successful agent run, extract durable user facts into global memory.
 */
export async function extractMemoriesAfterRun(opts: {
  sessionId: string
  userText: string
  assistantText: string
}): Promise<void> {
  const settings = getSettings()
  if (!settings.memoryEnabled || !settings.autoExtractMemory) return

  const userText = opts.userText.trim()
  const assistantText = opts.assistantText.trim()
  if (!userText || assistantText.length < MIN_ASSISTANT_CHARS_FOR_EXTRACT) return

  const profile = getActiveProviderProfile(settings)
  if (!profile.apiKey?.trim()) {
    memLog.warn('[extractMemoriesAfterRun] skipped: no API key')
    return
  }

  const existing = getUserMemories().items
  const existingBlock =
    existing.length > 0
      ? existing.map((m) => `- id=${m.id} | ${m.content}`).join('\n')
      : '(none)'

  const systemPrompt = `You maintain a small global memory about the user for a desktop coding agent.

Only output durable facts useful across future sessions:
- Preferences (languages, frameworks, package managers, editor habits)
- Stable identity or role context the user explicitly shared
- Long-term communication preferences

Do NOT store:
- API keys, passwords, tokens, secrets
- One-off task instructions, file paths, bug states, or temporary plans
- Anything only relevant to the current message

Compare with existing memories:
- If a new fact refines an existing one, use op "update" with the same id
- If a fact is obsolete or contradicted, use op "delete"
- If genuinely new, use op "add"
- If nothing durable changed, return actions: []

Each add/update content must be a single concise sentence (under 200 characters).`

  const humanPrompt = [
    '## Existing memories',
    existingBlock,
    '',
    '## Latest conversation turn',
    'User:',
    truncateTurnText(userText),
    '',
    'Assistant:',
    truncateTurnText(assistantText)
  ].join('\n')

  const langfuseHandler = createLangfuseCallbackHandler({
    sessionId: opts.sessionId,
    tags: ['agenxy', 'memory-extract'],
    traceMetadata: { session_id: opts.sessionId }
  })

  try {
    const model = createLanguageModel(settings).withStructuredOutput(MemoryExtractionSchema, {
      name: 'extract_user_memories',
      strict: true
    })

    const result = await model.invoke(
      [new SystemMessage(systemPrompt), new HumanMessage(humanPrompt)],
      langfuseHandler ? { callbacks: [langfuseHandler] } : {}
    )

    const actions = (result.actions ?? []) as MemoryExtractionAction[]
    if (!actions.length) return

    const { delta } = applyMemoryExtractionActions(actions, {
      sourceSessionId: opts.sessionId
    })
    memLog.info(
      `[extractMemoriesAfterRun] applied delta added=${delta.added} updated=${delta.updated} deleted=${delta.deleted}`
    )
  } catch (error) {
    memLog.warn(
      '[extractMemoriesAfterRun] failed:',
      error instanceof Error ? error.message : error
    )
  }
}
