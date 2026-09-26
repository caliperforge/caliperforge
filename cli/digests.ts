import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expected, rules, written } from '../runner/rules.ts'
import { map } from './map.ts'

export const ROSTER = 'rules/roster.yaml'
export const SEED = 'rules.seed.sql'
export const MAP = 'MAP.md'
const KEYS = ['manifest', 'prompt'] as const
const ROW = /^ {2}\('(.+?)', '.+?', '.+?', '.+?', '(.+?)'\)/gm
const BLOCK = /^digests:\n(?:[ \t].*\n|\n)*/m

export interface Stale {
  path: string
  digests: Record<string, string>
}

export function fill(root: string, today: string): string[] {
  const files = stale(root, today)
  for (const { path, body } of files) writeFileSync(join(root, path), body)
  return files.map(({ path }) => path)
}

export function check(root: string, today: string): Stale[] {
  return stale(root, today).map(({ path }): Stale => ({ path, digests: path === ROSTER ? wrong(root) : {} }))
}

function stale(root: string, today: string): { path: string; body: string }[] {
  const roster = filled(root)
  return [{ path: ROSTER, body: roster }, { path: SEED, body: seeded(root, roster, today) }, { path: MAP, body: map(root) }]
    .filter(({ path, body }) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : '') !== body)
}

function wrong(root: string): Record<string, string> {
  const have = written(root).digests
  return Object.fromEntries(Object.entries(expected(root)).flatMap(([name, want]) =>
    KEYS.filter((key) => have[name]?.[key] !== want[key]).map((key): [string, string] => [`${name}.${key}`, want[key]])))
}

/** Only the block moves: the rest of the roster is the builder's, and a roster that lost its block gets one appended. */
function filled(root: string): string {
  const text = readFileSync(join(root, ROSTER), 'utf8')
  const block = `digests:\n${Object.entries(expected(root))
    .map(([name, d]) => `  ${name}:\n    manifest: ${d.manifest}\n    prompt: ${d.prompt}\n`).join('')}`
  return BLOCK.test(text) ? text.replace(BLOCK, () => block) : `${text.replace(/\n*$/, '\n')}${block}`
}

/** The roster's own hash is one of the rows, so the seed is rendered from the roster a fill writes, not the one on disk. */
function seeded(root: string, roster: string, today: string): string {
  const hash = createHash('sha256').update(roster).digest('hex')
  const at = dated(root)
  const values = rules(root).map((row) =>
    `  ('${row.id}', '${row.kind}', '${row.path}', '${row.path === ROSTER ? hash : row.content_hash}', '${at.get(row.id) ?? today}')`)
  return `INSERT INTO rules (id, kind, path, content_hash, loaded_at)\nVALUES\n${values.join(',\n')};\n`
}

function dated(root: string): Map<string, string> {
  const rows = readFileSync(join(root, SEED), 'utf8').matchAll(ROW)
  return new Map([...rows].map((m): [string, string] => [m[1] ?? '', m[2] ?? '']))
}
