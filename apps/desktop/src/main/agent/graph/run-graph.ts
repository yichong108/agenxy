import {
  runAgenxyPipeline,
  type RunAgenxyPipelineInput,
  type RunAgenxyPipelineResult
} from '@/main/agent/run-pipeline'

export type RunAgenxyGraphInput = RunAgenxyPipelineInput
export type RunAgenxyGraphResult = RunAgenxyPipelineResult

/**
 * 通过 pipeline 执行一次用户消息处理（完整流水线）。
 *
 * @param input - 初始状态与 runContext（含 reactBridge）
 * @returns 运行结束后的 messages 与 toolEvents
 */
export async function runAgenxyGraph(input: RunAgenxyGraphInput): Promise<RunAgenxyGraphResult> {
  return runAgenxyPipeline(input)
}
