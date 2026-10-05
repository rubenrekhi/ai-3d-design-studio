import { describe, expect, it } from 'vitest'
import { Gate } from './gate'

async function settled<T>(promise: Promise<T>): Promise<boolean> {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  return done
}

describe('Gate', () => {
  it('lets the first two through and queues the third until one releases', async () => {
    const gate = new Gate(2)
    const first = await gate.acquire()
    await gate.acquire()
    const third = gate.acquire()
    expect(await settled(third)).toBe(false)
    first()
    expect(await settled(third)).toBe(true)
  })

  it('rejects a waiter whose signal aborts and lets the next one in', async () => {
    const gate = new Gate(1)
    const release = await gate.acquire()
    const controller = new AbortController()
    const cancelled = gate.acquire(controller.signal)
    const next = gate.acquire()
    controller.abort()
    await expect(cancelled).rejects.toThrow('Cancelled')
    release()
    expect(await settled(next)).toBe(true)
  })

  it('refuses a signal that is already aborted', async () => {
    const gate = new Gate(1)
    const controller = new AbortController()
    controller.abort()
    await expect(gate.acquire(controller.signal)).rejects.toThrow('Cancelled')
  })
})
