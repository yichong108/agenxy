/** 简单并发上限：超出则排队，获取 slot 后执行 */

export class ConcurrencyQueue {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly max: number) {}

  get waiting(): number {
    return this.waiters.length
  }

  get running(): number {
    return this.active
  }

  /** 下一次 run 若需等待，大致排队人数（MVP 近似） */
  willBlock(): boolean {
    return this.active >= this.max
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
      })
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      const next = this.waiters.shift()
      if (next) next()
    }
  }
}
