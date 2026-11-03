import { Socket } from 'node:net'
import { afterEach, expect } from 'vitest'

interface Target { host?: string | undefined; port?: unknown; path?: string }

const LOCAL = new Set<string | undefined>([undefined, 'localhost', '127.0.0.1', '::1'])

export const reached: string[] = []

export function swept(): void {
  const lines = reached.splice(0)
  if (lines.length > 0) throw new Error(lines.join('\n'))
}

function target(args: unknown[]): Target {
  const list: unknown[] = Array.isArray(args[0]) ? args[0] : args
  const [first, second] = list
  if (typeof first === 'object' && first !== null) return first
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { path: first }
  return { port: first, host: typeof second === 'string' ? second : undefined }
}

export function guard(env: NodeJS.ProcessEnv): void {
  if (env.CF_BENCH_LIVE === '1') return
  const connect = Reflect.get(Socket.prototype, 'connect') as (this: Socket, ...args: unknown[]) => Socket
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]): Socket {
    const { host, port, path } = target(args)
    if (path === undefined && !LOCAL.has(host)) {
      const line = `${String(expect.getState().currentTestName)} opened a socket to ${String(host)}:${String(port)}`
      reached.push(line)
      throw new Error(line)
    }
    return Reflect.apply(connect, this, args)
  }
  afterEach(swept)
}

guard(process.env)
