import { realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { Packet, Provider, Refusal } from '../providers/kind.ts'
import type { Db } from '../store/index.ts'
import { load, seat, tight, type Seat } from './rules.ts'

export function refuse(cwd: string, writePaths: string[], path: string): Refusal | null {
  const root = real(cwd)
  const rel = relative(root, real(resolve(root, path)))
  const inside = !rel.startsWith('..') && writePaths.some((p) => rel === p || rel.startsWith(`${p}/`))
  return inside ? null : { origin_kind: 'ruling', origin_ref: 'seat.write_paths', path: rel }
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function packet(manifest: Seat, prompt: string, spec: string, issue: string, cwd: string, transcript: string): Packet {
  return {
    prompt: `${spec}\n\n${prompt}\n\n# Issue\n\n${issue}`,
    cwd,
    transcript,
    model: manifest.model,
    effort: manifest.effort,
    tools: manifest.tools,
    refuse: (path) => refuse(cwd, manifest.write_paths, path),
  }
}

export async function fire(
  db: Db,
  root: string,
  name: string,
  cwd: string,
  issue: string,
  provider: Provider,
): Promise<{ id: number; text: string }> {
  load(db, root)
  const { manifest, prompt, hash } = seat(root, name)
  const plan = planRow(db)
  const transcript = join(root, '.cf/work', String(plan), 'step-2.transcript.jsonl')
  const fired = await provider.fire(packet(manifest, prompt, tight(root), issue, cwd, transcript))
  const row = db.prepare(`INSERT INTO runs
    (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path)
    VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(plan, name, hash, provider.name, manifest.model, manifest.effort,
      fired.usage.input, fired.usage.cache, fired.usage.output, fired.seconds, fired.exit, fired.transcript_path)
  return { id: Number(row.lastInsertRowid), text: fired.text }
}

export function planRow(db: Db): number {
  db.prepare("INSERT OR IGNORE INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES ('p3-slice', 0, '00:00', '23:59', 1)").run()
  const pipe = db.prepare("SELECT id FROM pipes WHERE name = 'p3-slice'").get() as { id: number }
  const row = db.prepare("INSERT INTO plans (pipe_id, template, state, queued_at) VALUES (?, 'research', 'running', ?)")
    .run(pipe.id, new Date().toISOString())
  return Number(row.lastInsertRowid)
}
