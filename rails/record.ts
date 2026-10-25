import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Db } from '../store/index.ts'
import { addRail, type Verdict } from '../store/verdict.ts'

export type { Verdict }

const Manifest = z.object({
  rail: z.string().min(1),
  gate: z.enum(['premise', 'target', 'pre_review', 'review', 'senior_review', 'ready']),
  step: z.int().min(0).max(9),
  defect_class: z.string().min(1),
})

export function record(db: Db, dir: string, plan: number, verdict: Verdict, seconds: number): number {
  const manifest = Manifest.parse(parse(readFileSync(join(dir, 'manifest.yaml'), 'utf8')))
  return addRail(db, manifest.gate, manifest.step, plan, manifest.rail, verdict, seconds)
}
