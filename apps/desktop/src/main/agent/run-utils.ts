/**
 * 判断异常是否由 AbortController 取消触发。
 *
 * @param e - 捕获的未知异常
 * @returns 是否为 abort 类错误
 */
export function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === 'AbortError' || e.message.toLowerCase().includes('abort'))
  )
}
