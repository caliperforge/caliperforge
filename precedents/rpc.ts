import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Reply = { result: unknown } | { error: { code: number; message: string; data?: unknown } }

export type Compared = { verdict: 'same' } | { verdict: 'mainnet-disabled' }
  | { verdict: 'differs'; on: 'code' | 'message' | 'shape'; mainnet: string; surfpool: string }

export interface Param { name: string; type: string; optional?: true }

export interface Method { name: string; params: Param[] }

type Shape = string | Shape[] | { [key: string]: Shape }

const COMMENT = /\/\*[\s\S]*?\*\/|\/\/.*/g

const ATTRIBUTE = /#\[rpc\(([^\]]*)\)\]/g

const FN = /\bfn\b[^(]*\(/g

const WRAPPER = /^(?:Option|RpcEncodingConfigWrapper)<(.*)>$/

export const masked = (message: string): string =>
  message.replace(/([1-9A-HJ-NP-Za-km-z]{32,88})|\d+/g, (...run: (string | undefined)[]) => run[1] === undefined ? '<n>' : '<b58>')

export function compared(mainnet: Reply, surfpool: Reply): Compared {
  if ('error' in mainnet && /disabled/i.test(mainnet.error.message)) return { verdict: 'mainnet-disabled' }
  const [m, s] = [code(mainnet), code(surfpool)]
  if (m !== s) return differs('code', m, s)
  if ('error' in mainnet && 'error' in surfpool) return differs('message', masked(mainnet.error.message), masked(surfpool.error.message))
  const a = shape((mainnet as { result: unknown }).result)
  const b = shape((surfpool as { result: unknown }).result)
  return differs('shape', JSON.stringify(a), JSON.stringify(b), alike(a, b))
}

const code = (reply: Reply): string => 'error' in reply ? String(reply.error.code) : 'result'

function differs(on: 'code' | 'message' | 'shape', mainnet: string, surfpool: string, same = mainnet === surfpool): Compared {
  return same ? { verdict: 'same' } : { verdict: 'differs', on, mainnet, surfpool }
}

function shape(value: unknown): Shape {
  if (value === null) return 'null'
  if (Array.isArray(value)) return [...new Set(value.map((v) => JSON.stringify(shape(v))))].sort().map((s) => JSON.parse(s) as Shape)
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape((value as Record<string, unknown>)[k])]))
  return typeof value
}

function alike(a: Shape | undefined, b: Shape | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === 0 || b.length === 0 || (a.every((x) => b.some((y) => alike(x, y))) && b.every((y) => a.some((x) => alike(x, y))))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return a === b
  const keys = Object.keys(a)
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b)) && keys.every((k) => alike(a[k], b[k]))
}

function args(source: string, from: number): string[] {
  FN.lastIndex = from
  const open = FN.exec(source)
  if (open === null) throw new Error(`no fn after the #[rpc] attribute at offset ${String(from)}`)
  const split: string[] = []
  let depth = 0
  let arg = ''
  for (const c of source.slice(open.index + open[0].length)) {
    if (depth === 0 && (c === ',' || c === ')')) split.push(arg)
    if (depth === 0 && c === ')') break
    depth += '<('.includes(c) ? 1 : '>)'.includes(c) ? -1 : 0
    arg = depth === 0 && c === ',' ? '' : arg + c
  }
  return split
}

const typed = (name: string, type: string): Param => {
  const inner = WRAPPER.exec(type)?.[1]
  return inner === undefined ? { name, type } : { ...typed(name, inner), optional: true }
}

const params = (list: string[]): Param[] => list.map((a) => a.replace(/\s/g, ''))
  .filter((a) => a.includes(':') && !a.endsWith(':Self::Metadata'))
  .map((a) => typed(a.slice(0, a.indexOf(':')), a.slice(a.indexOf(':') + 1)))

const read = (source: string): Method[] => [...source.matchAll(ATTRIBUTE)].flatMap((m) => {
  const name = /\bname\s*=\s*"([^"]+)"/.exec(m[1] ?? '')?.[1]
  return name === undefined ? [] : [{ name, params: params(args(source, m.index + m[0].length)) }]
})

export function methods(checkout: string): Method[] {
  const dir = join(checkout, 'crates', 'core', 'src', 'rpc')
  if (!existsSync(dir)) throw new Error(`${dir} is missing`)
  const found = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.rs'))
    .map((e) => e.name).sort()
    .flatMap((file) => read(readFileSync(join(dir, file), 'utf8').replace(COMMENT, '')))
    .filter((m) => !m.name.startsWith('surfnet_'))
  if (found.length === 0) throw new Error(`no #[rpc] methods in ${dir}`)
  return found
}
