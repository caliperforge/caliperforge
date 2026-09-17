import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Db } from '../store/index.ts'
import type { Verdict } from '../store/verdict.ts'

export type { Verdict }

const Manifest = z.object({
  rail: z.string().min(1),
  gate: z.enum(['premise', 'target', 'pre_review', 'review', 'senior_review', 'ready']),
  step: z.int().min(0).max(9),
  defect_class: z.string().min(1),
})

export function record(db: Db, dir: string, plan: number, verdict: Verdict, seconds: number): number {
  const manifest = Manifest.parse(parse(readFileSync(join(dir, 'manifest.yaml'), 'utf8')))
  const row = db.prepare(`INSERT INTO verdicts
    (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds)
    VALUES (?, 'rail', ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(manifest.gate, verdict.subject_digest, plan, manifest.step, verdict.outcome,
      manifest.rail, verdict.origin_kind, verdict.origin_ref, seconds)
  return Number(row.lastInsertRowid)
}
