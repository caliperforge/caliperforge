import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The plan the current `cf lap` runs. */
export const lapping = new AsyncLocalStorage<number>()

export const LOCKED = 'database is locked'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export function timed(fn: (...args: unknown[]) => unknown, frame: string): (...args: unknown[]) => unknown {
  return (...args) => {
    const at = performance.now()
    try {
      return fn(...args)
    } finally {
      const ms = performance.now() - at
      if (ms > 1000) process.stderr.write(`cf: transaction held ${(ms / 1000).toFixed(1)} s at ${site(frame)} plan ${String(lapping.getStore() ?? 'none')}\n`)
    }
  }
}

const BACKOFF = [100, 200, 400, 800]

export function retried(call: () => unknown, ran: () => boolean, frame: string): unknown {
  for (const [n, ms] of BACKOFF.entries()) {
    try {
      return call()
    } catch (e) {
      if (ran() || !(e instanceof Error) || !e.message.includes(LOCKED)) throw e
      process.stderr.write(`cf: store busy at ${site(frame)} plan ${String(lapping.getStore() ?? 'none')}, retry ${String(n + 1)} in ${String(ms)} ms\n`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    }
  }
  return call()
}

/** `path:line` of a V8 stack frame, `at f (path:line:col)` or `at path:line:col`, relative to the repo. */
function site(frame: string): string {
  const [, path, line] = /([^\s(]+):(\d+):\d+\)?$/.exec(frame) ?? []
  if (path === undefined || line === undefined) return frame.trim()
  return `${relative(ROOT, path.replace(/^file:\/\//, ''))}:${line}`
}
