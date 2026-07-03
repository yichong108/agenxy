/**
 * Desktop 流水线桥接 — 注入 Electron 侧工具组装、Langfuse 与记忆提取。
 */
import {
  type PipelineDeps,
  runAgenxyPipeline,
  type RunAgenxyPipelineInput,
  type RunAgenxyPipelineResult
} from '@agenxy/agent'

import { buildAgentRunPrompt, prepareAgentTooling } from '@/main/agent/agent-tooling'
import { runLangfuseReactObservation } from '@/main/langfuse'
import { extractMemoriesAfterRun } from '@/main/memory/memory-extractor'

const desktopPipelineDeps: PipelineDeps = {
  prepareTooling: async ({ composerMode, sessionId, root, settings, runCtx, filterIntents }) => {
    const bundle = await prepareAgentTooling(
      composerMode,
      sessionId,
      root,
      settings,
      runCtx,
      filterIntents !== undefined ? { filterIntents } : undefined
    )
    return {
      tools: bundle.tools,
      runPrompt: buildAgentRunPrompt(composerMode, root, settings, bundle)
    }
  },
  wrapReactRun: runLangfuseReactObservation as PipelineDeps['wrapReactRun'],
  extractMemory: extractMemoriesAfterRun
}

export type RunAgenxyGraphInput = RunAgenxyPipelineInput
export type RunAgenxyGraphResult = RunAgenxyPipelineResult

/**
 * 在 desktop 宿主环境中执行 agent 流水线。
 *
 * @param input - pipeline 输入
 * @returns 运行结果
 */
export async function runAgenxyGraph(input: RunAgenxyGraphInput): Promise<RunAgenxyGraphResult> {
  return runAgenxyPipeline(input, desktopPipelineDeps)
}
