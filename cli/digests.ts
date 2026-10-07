import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expected, rosterOf, rules, written } from '../runner/rules.ts'

export const ROSTER = 'rules/roster'
export const SEED = 'rules.seed.sql'
const KEYS = ['manifest', 'prompt'] as const
const ROW = /^ {2}\('(.+?)', '.+?', '.+?', '.+?', '(.+?)'\)/gm

interface Stale {
  path: string
  digests: Record<string, string>
}

interface Body {
  path: string
  body: string
}

export function fill(root: string, today: string): string[] {
  const files = stale(root, today)
  for (const { path, body } of files) writeFileSync(join(root, path), body)
  return files.map(({ path }) => path)
}

export function check(root: string, today: string): Stale[] {
  return stale(root, today).map(({ path }): Stale => ({ path, digests: path === SEED ? {} : wrong(root, basename(path, '.yaml')) }))
}

function stale(root: string, today: string): Body[] {
  const seats = filled(root)
  return [...seats, { path: SEED, body: seeded(root, seats, today) }]
    .filter(({ path, body }) => readFileSync(join(root, path), 'utf8') !== body)
}

function wrong(root: string, seat: string): Record<string, string> {
  const have = written(root).digests[seat]
  return Object.fromEntries(Object.entries(expected(root)).filter(([name]) => name === seat).flatMap(([name, want]) =>
    KEYS.filter((key) => have?.[key] !== want[key]).map((key): [string, string] => [`${name}.${key}`, want[key]])))
}

function filled(root: string): Body[] {
  return Object.entries(expected(root)).map(([name, d]) => ({ path: rosterOf(name), body: `manifest: ${d.manifest}\nprompt: ${d.prompt}\n` }))
}

/** A seat file's own hash is its row's, so the seed is rendered from the files a fill writes, not the ones on disk. */
function seeded(root: string, seats: Body[], today: string): string {
  const hashes = new Map(seats.map(({ path, body }) => [path, createHash('sha256').update(body).digest('hex')]))
  const at = dated(root)
  const values = rules(root).map((row) =>
    `  ('${row.id}', '${row.kind}', '${row.path}', '${hashes.get(row.path) ?? row.content_hash}', '${at.get(row.id) ?? today}')`)
  return `INSERT INTO rules (id, kind, path, content_hash, loaded_at)\nVALUES\n${values.join(',\n')};\n`
}

function dated(root: string): Map<string, string> {
  const rows = readFileSync(join(root, SEED), 'utf8').matchAll(ROW)
  return new Map([...rows].map((m): [string, string] => [m[1] ?? '', m[2] ?? '']))
}
