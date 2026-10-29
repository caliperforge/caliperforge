import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const COMMENT = /\/\*[\s\S]*?\*\/|\/\/.*/g

const PROPERTY = /\bfunction\s+(?:invariant|property|echidna)_\w*\s*\(/

const CLAMPED = '_clamped'

const stripped = (path: string): string => readFileSync(path, 'utf8').replace(COMMENT, '')

const functions = (sol: string): { name: string, signature: string, body: string }[] =>
  sol.split(/\bfunction\s+/).slice(1).map((chunk) => {
    const open = chunk.indexOf('{')
    const signature = open < 0 ? chunk : chunk.slice(0, open)
    return { name: /^\w*/.exec(chunk)?.[0] ?? '', signature, body: chunk.slice(signature.length) }
  }).filter((f) => f.name !== '')

export function unclamped(suite: string): string[] {
  const properties = join(suite, 'Properties.sol')
  if (!existsSync(properties)) throw new Error(`${properties} is missing`)
  const dir = join(suite, 'handlers')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('Handler.sol')) : []
  if (files.length === 0) throw new Error(`${join(dir, '*Handler.sol')} is missing`)
  const declared = stripped(properties)
  const calls = functions(declared).map((f) => new RegExp(`\\b${f.name}\\s*\\(`))
  const handlers = files.flatMap((f) => functions(stripped(join(dir, f))))
    .filter((f) => /\b(?:public|external)\b/.test(f.signature) && !/\b(?:view|pure)\b/.test(f.signature))
  const names = handlers.map((h) => h.name)
  const clamped = new Set(names.filter((n) => n.endsWith(CLAMPED)).map((n) => n.slice(0, -CLAMPED.length)))
  const global = PROPERTY.test(declared)
  const targeted = handlers.filter((h) => !h.name.endsWith(CLAMPED) && !names.some((n) => h.name.startsWith(`${n}_`))
    && (global || calls.some((c) => c.test(h.body))))
  return [...new Set(targeted.map((h) => h.name).filter((n) => !clamped.has(n)))].sort()
}
