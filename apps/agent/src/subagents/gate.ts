/**
 * Lets a fixed number of callers through at once and queues the rest in
 * order. A waiter whose signal aborts leaves the queue with an error.
 */
export class Gate {
  private free: number
  private readonly waiting: (() => void)[] = []

  constructor(size: number) {
    this.free = size
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', cancel)
        this.free -= 1
        resolve(() => {
          this.free += 1
          this.waiting.shift()?.()
        })
      }
      const cancel = () => {
        const index = this.waiting.indexOf(grant)
        if (index !== -1) this.waiting.splice(index, 1)
        reject(new Error('Cancelled before it could start.'))
      }
      if (signal?.aborted === true) {
        cancel()
        return
      }
      if (this.free > 0) {
        grant()
        return
      }
      signal?.addEventListener('abort', cancel, { once: true })
      this.waiting.push(grant)
    })
  }
}
