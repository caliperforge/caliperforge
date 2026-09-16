import { join } from 'node:path'
import type { Db } from '../store/index.ts'
import type { Check, Finding } from './kind.ts'
import { fresh, rejects } from './sqlite.ts'

const TRIGGERS = ['runs_reviewer_not_builder', 'runs_reviewer_not_builder_update']

const PROBES = [
  { name: 'step 4 with the builder seat', sql: [run(1, 2, 'builder'), run(1, 4, 'builder')] },
  { name: 'step 5 with the step-4 seat', sql: [run(2, 4, 'reviewer'), run(2, 5, 'reviewer')] },
  { name: 'update into a collision', sql: [run(3, 2, 'builder'), run(3, 4, 'reviewer'), "UPDATE runs SET seat = 'builder' WHERE plan = 3 AND step = 4"] },
]

export const reviewerNotBuilder: Check = {
  name: 'reviewer-not-builder',
  run: (root: string) => Promise.resolve(findings(root)),
}

function findings(root: string): Finding[] {
  const db = fresh(join(root, 'schema'))
  db.pragma('foreign_keys = OFF')
  return [...missing(db), ...PROBES.flatMap((p) => probe(db, p))]
}

function missing(db: Db): Finding[] {
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[])
      .map((r) => r.name),
  )
  return TRIGGERS.filter((t) => !present.has(t)).map((t) => finding(`trigger ${t} is absent`))
}

function probe(db: Db, p: { name: string; sql: string[] }): Finding[] {
  const setup = p.sql.slice(0, -1)
  const last = p.sql.at(-1) ?? ''
  for (const sql of setup) db.exec(sql)
  return rejects(db, last) ? [] : [finding(`${p.name} was accepted`)]
}

function run(plan: number, step: number, seat: string): string {
  return `INSERT INTO runs (plan, step, seat, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit)
VALUES (${String(plan)}, ${String(step)}, '${seat}', 'anthropic-api', 'm', 'low', 0, 0, 0, 0, 0)`
}

function finding(message: string): Finding {
  return { check: 'reviewer-not-builder', path: 'schema/', line: 1, message }
}
