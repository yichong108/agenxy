/** 合并流式文本再 IPC，减少 renderer 压力 */

export class StreamBatcher {
  private buffer = ''
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly maxMs: number,
    private readonly maxChars: number,
    private readonly onFlush: (s: string) => void
  ) {}

  push(text: string): void {
    this.buffer += text
    if (this.buffer.length >= this.maxChars) {
      this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.maxMs)
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.buffer) return
    const t = this.buffer
    this.buffer = ''
    this.onFlush(t)
  }
}
