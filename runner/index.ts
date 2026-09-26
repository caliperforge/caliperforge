import { realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { Packet, Provider, Refusal } from '../providers/kind.ts'
import type { Db } from '../store/index.ts'
import { observed, wall } from '../store/lanes.ts'
import { load, seat, tight, type Seat } from './rules.ts'

/** The tick's own state inside a plan checkout. A seat writes the repository, never the machine's notes about it. */
const CF = '.cf'

/**
 * #38: a seat building our own kernel writes anywhere in its checkout except `.cf/` -- the tree is
 * ours, and a fence that lets `src/` through but not `cli/` refuses the work the issue asked for.
 * A seat working a stranger's repository keeps the manifest's `write_paths`, which is the narrow
 * fence a counterparty never agreed to widen.
 */
export function refuse(cwd: string, writePaths: string[], path: string, ours = false): Refusal | null {
  const root = real(cwd)
  const rel = relative(root, real(resolve(root, path)))
  const fenced = ours ? [CF] : writePaths
  const under = fenced.some((p) => rel === p || rel.startsWith(`${p}/`))
  const inside = !rel.startsWith('..') && (ours ? !under : under)
  return inside ? null : { origin_kind: 'ruling', origin_ref: 'seat.write_paths', path: rel }
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** A stranger's npm scripts never run on this host (sequencer/rails.ts); their fork CI is their check. */
const OURS_ONLY = 'Bash(npm '

export function packet(manifest: Seat, prompt: string, spec: string, issue: string, cwd: string,
  transcript: string, ours = false, fence: string[] = manifest.write_paths): Packet {
  return {
    prompt: `${spec}\n\n${prompt}\n\n# Issue\n\n${issue}`,
    cwd,
    transcript,
    model: manifest.model,
    effort: manifest.effort,
    tools: ours ? manifest.tools : manifest.tools.filter((t) => !t.startsWith(OURS_ONLY)),
    refuse: (path) => refuse(cwd, fence, path, ours),
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
  const fired = await provider.fire({ ...packet(manifest, prompt, tight(root), issue, cwd, transcript), wall: wall(db) })
  const row = db.prepare(`INSERT INTO runs
    (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path, cost_usd)
    VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(plan, name, hash, provider.name, manifest.model, manifest.effort,
      fired.usage.input, fired.usage.cache, fired.usage.output, fired.seconds, fired.exit, fired.transcript_path, fired.usage.cost ?? null)
  observed(db, fired.limits)
  return { id: Number(row.lastInsertRowid), text: fired.text }
}

export function planRow(db: Db): number {
  db.prepare("INSERT OR IGNORE INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES ('p3-slice', 0, '00:00', '23:59', 1)").run()
  const pipe = db.prepare("SELECT id FROM pipes WHERE name = 'p3-slice'").get() as { id: number }
  const row = db.prepare("INSERT INTO plans (pipe_id, template, state, queued_at) VALUES (?, 'research', 'running', ?)")
    .run(pipe.id, new Date().toISOString())
  return Number(row.lastInsertRowid)
}
