import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { manifest } from '../checks/manifest.ts'
import type { Db } from '../store/index.ts'

const Roster = z.object({
  seats: z.array(z.string()).min(1),
  digests: z.record(
    z.string(),
    z.object({ manifest: z.string().length(64), prompt: z.string().length(64) }),
  ),
})

export const Seat = z.object({
  seat: z.string(),
  model: z.string(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  tools: z.array(z.string()).min(1),
  write_paths: z.array(z.string()).min(1),
})

export type Seat = z.infer<typeof Seat>

export interface Rule {
  id: string
  kind: 'roster' | 'rail' | 'card'
  path: string
  content_hash: string
}

export function rules(root: string): Rule[] {
  const rails = digest(join(root, 'rules/rails.yaml'))
  const roster = digest(join(root, 'rules/roster.yaml'))
  const tight = digest(join(root, 'rules/tight.md'))
  return [
    { id: 'rules/rails.yaml', kind: 'rail', path: 'rules/rails.yaml', content_hash: rails },
    { id: 'rules/tight.md', kind: 'card', path: 'rules/tight.md', content_hash: tight },
    ...manifest(root).rails.map((id) => ({ id, kind: 'rail' as const, path: 'rules/rails.yaml', content_hash: rails })),
    ...listed(root).seats.map((id) => ({ id, kind: 'card' as const, path: 'rules/roster.yaml', content_hash: roster })),
  ]
}

export function load(db: Db, root: string): Rule[] {
  const rows = rules(root)
  const put = db.prepare('INSERT OR REPLACE INTO rules (id, kind, path, content_hash, loaded_at) VALUES (?, ?, ?, ?, ?)')
  const at = new Date().toISOString()
  for (const rule of rows) put.run(rule.id, rule.kind, rule.path, rule.content_hash, at)
  return rows
}

export function seat(root: string, name: string): { manifest: Seat; prompt: string; hash: string } {
  const want = listed(root).digests[name]
  if (want === undefined) throw new Error(`seat "${name}" is absent from rules/roster.yaml`)
  const paths = { manifest: join(root, 'seats', name, 'manifest.yaml'), prompt: join(root, 'seats', name, 'prompt.md') }
  for (const key of ['manifest', 'prompt'] as const) {
    if (digest(paths[key]) !== want[key]) throw new Error(`seat "${name}" ${key} does not match its digest in rules/roster.yaml`)
  }
  return {
    manifest: Seat.parse(parse(readFileSync(paths.manifest, 'utf8'))),
    prompt: readFileSync(paths.prompt, 'utf8'),
    hash: digest(join(root, 'rules/roster.yaml')),
  }
}

export function tight(root: string): string {
  return readFileSync(join(root, 'rules/tight.md'), 'utf8')
}

function listed(root: string): z.infer<typeof Roster> {
  return Roster.parse(parse(readFileSync(join(root, 'rules/roster.yaml'), 'utf8')))
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
