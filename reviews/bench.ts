import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '../providers/kind.ts'
import { benchPacket, reviewManifest } from '../runner/packet.ts'
import type { Db } from '../store/index.ts'
import { subdirs } from '../checks/tree.ts'
import { read, type Verdict } from './verdict.ts'

export function loadReviews(db: Db, root: string): string[] {
  const names = subdirs(join(root, 'reviews'))
  const put = db.prepare('INSERT OR REPLACE INTO rules (id, kind, path, content_hash, loaded_at) VALUES (?, ?, ?, ?, ?)')
  const at = new Date().toISOString()
  for (const name of names) put.run(name, 'card', `reviews/${name}/spec.md`, specHash(root, name), at)
  return names
}

export function specHash(root: string, name: string): string {
  return createHash('sha256').update(readFileSync(join(root, 'reviews', name, 'spec.md'))).digest('hex')
}

export async function judge(
  db: Db,
  root: string,
  name: string,
  plan: number,
  input: unknown,
  provider: Provider,
): Promise<{ run: number | null; verdict: number; outcome: Verdict }> {
  const manifest = reviewManifest(root, name)
  const built = benchPacket(root, name, input)
  if ('refusal' in built) {
    const outcome = barred(built.refusal.path, input)
    return { run: null, verdict: record(db, root, name, plan, outcome, 0, 0), outcome }
  }
  const fired = await provider.fire(built.packet)
  const run = db.prepare(`INSERT INTO runs
    (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(plan, manifest.step, name, specHash(root, name), provider.name, manifest.model, manifest.effort,
      fired.usage.input, fired.usage.cache, fired.usage.output, fired.seconds, fired.exit)
  const outcome = read(fired.text, built.packet.prompt)
  const tokens = fired.usage.input + fired.usage.cache + fired.usage.output
  return { run: Number(run.lastInsertRowid), verdict: record(db, root, name, plan, outcome, tokens, fired.seconds), outcome }
}

function barred(span: string, input: unknown): Verdict {
  return {
    outcome: 'refuse',
    defect_class: 'scope',
    spans: [span],
    subject_digest: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    origin_kind: 'ruling',
    origin_ref: 'reviewers.maintainers_view',
  }
}

function record(db: Db, root: string, name: string, plan: number, v: Verdict, tokens: number, seconds: number): number {
  const manifest = reviewManifest(root, name)
  const row = db.prepare(`INSERT INTO verdicts
    (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds)
    VALUES (?, 'review', ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
    .run(manifest.gate, v.subject_digest, plan, manifest.step, v.outcome, v.origin_kind, v.origin_ref, tokens, seconds)
  return Number(row.lastInsertRowid)
}
