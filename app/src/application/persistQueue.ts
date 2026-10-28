/**
 * Serializes persistence writes and keeps only the newest snapshot waiting to
 * be written. A slow write can never run concurrently with a newer write, and
 * a burst of edits does not make the storage port write every intermediate
 * snapshot.
 *
 * 失败语义：写入失败会通过 `flush()` 的 reject 上报给调用方，但**不会丢掉失败期间
 * 新排队的快照**——否则一次瞬时失败就会让后续编辑静默停留在内存里，
 * 界面还会继续显示“已保存”。
 */
export type PersistWriter<T> = (snapshot: T) => Promise<void>

/** Full save jobs cannot be coalesced: every log and purge must complete in order. */
export class OrderedPersistQueue {
  private steps: Array<() => Promise<void>> = []
  private running: Promise<void> | null = null

  enqueue(steps: Array<() => Promise<void>>): void {
    this.steps.push(...steps)
    this.start()
  }

  flush(): Promise<void> {
    this.start()
    return this.running ?? Promise.resolve()
  }

  private start(): void {
    if (this.running || this.steps.length === 0) return
    this.running = this.drain().finally(() => { this.running = null })
    // Autosave callers may attach their error handler later in the same turn.
    void this.running.catch(() => undefined)
  }

  private async drain(): Promise<void> {
    while (this.steps.length > 0) {
      await this.steps[0]()
      this.steps.shift()
    }
  }
}

export class SerialPersistQueue<T> {
  private pending: { value: T } | null = null
  private running = false
  private idlePromise: Promise<void> = Promise.resolve()
  private resolveIdle: (() => void) | null = null
  private rejectIdle: ((reason?: unknown) => void) | null = null

  constructor(private readonly writer: PersistWriter<T>) {}

  /** Replaces any snapshot that has not started writing yet. */
  enqueue(value: T): void {
    this.pending = { value }
    this.startIfIdle()
  }

  /** Resolves after all currently queued writes have completed；任何一次写入失败都会 reject。 */
  flush(): Promise<void> {
    return this.idlePromise
  }

  private startIfIdle(): void {
    if (this.running) return
    this.running = true
    this.idlePromise = new Promise<void>((resolve, reject) => {
      this.resolveIdle = resolve
      this.rejectIdle = reject
    })
    void this.drain()
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const next = this.pending
      this.pending = null
      try {
        await this.writer(next.value)
      } catch (error) {
        this.running = false
        const reject = this.rejectIdle
        this.resolveIdle = null
        this.rejectIdle = null
        reject?.(error)
        // 失败期间可能又排了新的快照：立刻继续写，而不是把它留在队列里。
        if (this.pending) this.startIfIdle()
        return
      }
    }
    this.running = false
    const resolve = this.resolveIdle
    this.resolveIdle = null
    this.rejectIdle = null
    resolve?.()
  }
}
