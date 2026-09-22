import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAPPED, type Packet, type Provider } from '../providers/kind.ts'
import { benchPacket, reviewManifest, type Review } from '../runner/packet.ts'
import type { Db } from '../store/index.ts'
import { observed, wall } from '../store/lanes.ts'
import { byRun } from '../store/transcript.ts'
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
  transcript: string,
): Promise<{ run: number | null; verdict: number; outcome: Verdict }> {
  const manifest = reviewManifest(root, name)
  const built = benchPacket(root, name, input, transcript)
  if ('refusal' in built) {
    const outcome = barred(built.refusal.path, input)
    return { run: null, verdict: record(db, root, name, plan, outcome, 0, 0), outcome }
  }
  if (builderRan(db, plan, name, manifest.step)) {
    const outcome = barredAsBuilder(`${name}:${String(manifest.step)}`, input)
    return { run: null, verdict: record(db, root, name, plan, outcome, 0, 0), outcome }
  }
  const first = await ran(db, root, name, plan, manifest, provider, built.packet)
  const refired = first.capped && first.outcome === null
    ? await ran(db, root, name, plan, manifest, provider, { ...built.packet, tools: [] })
    : null
  const last = refired ?? first
  if (last.outcome === null) throw new Error('reviewers.verdict_fence')
  const tokens = first.tokens + (refired?.tokens ?? 0)
  const seconds = first.seconds + (refired?.seconds ?? 0)
  return { run: last.run, verdict: record(db, root, name, plan, last.outcome, tokens, seconds), outcome: last.outcome }
}

interface Ran {
  run: number
  outcome: Verdict | null
  capped: boolean
  tokens: number
  seconds: number
}

async function ran(db: Db, root: string, name: string, plan: number, manifest: Review, provider: Provider,
  packet: Packet): Promise<Ran> {
  const fired = await provider.fire({ ...packet, wall: wall(db) })
  const outcome = read(fired.text, packet.prompt)
  const row = db.prepare(`INSERT INTO runs
    (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(plan, manifest.step, name, specHash(root, name), provider.name, manifest.model, manifest.effort,
      fired.usage.input, fired.usage.cache, fired.usage.output, fired.seconds,
      outcome === null ? 1 : fired.exit, fired.transcript_path)
  const run = Number(row.lastInsertRowid)
  byRun(db, run, fired.transcript_path)
  observed(db, fired.limits)
  return {
    run,
    outcome,
    capped: fired.stop_reason === CAPPED,
    tokens: fired.usage.input + fired.usage.cache + fired.usage.output,
    seconds: fired.seconds,
  }
}

function builderRan(db: Db, plan: number, seat: string, step: number): boolean {
  if (step !== 4 && step !== 5) return false
  return db.prepare('SELECT 1 FROM runs WHERE plan = ? AND seat = ? AND (step = 2 OR (? = 5 AND step = 4))')
    .get(plan, seat, step) !== undefined
}

function barred(span: string, input: unknown): Verdict {
  return {
    outcome: 'refuse',
    defect_class: 'scope',
    spans: [span],
    subject_digest: digest(input),
    origin_kind: 'ruling',
    origin_ref: 'reviewers.maintainers_view',
    message: `the reviewer packet is not a maintainer's view: ${span}`,
  }
}

function barredAsBuilder(span: string, input: unknown): Verdict {
  return {
    outcome: 'refuse',
    defect_class: 'scope',
    spans: [span],
    subject_digest: digest(input),
    origin_kind: 'ruling',
    origin_ref: 'runs.reviewer_not_builder',
    message: `${span} already ran as the builder on this plan`,
  }
}

function digest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function record(db: Db, root: string, name: string, plan: number, v: Verdict, tokens: number, seconds: number): number {
  const manifest = reviewManifest(root, name)
  const row = db.prepare(`INSERT INTO verdicts
    (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds)
    VALUES (?, 'review', ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
    .run(manifest.gate, v.subject_digest, plan, manifest.step, v.outcome, v.origin_kind, v.origin_ref, tokens, seconds)
  return Number(row.lastInsertRowid)
}
