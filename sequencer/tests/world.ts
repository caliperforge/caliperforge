import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fresh } from '../../checks/sqlite.ts'
import type { Provider } from '../../providers/kind.ts'
import type { Db } from '../../store/index.ts'
import { PlanRow, type PipeRow } from '../../store/plans.ts'
import { put } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')

const BENCH = `export function judge() {
  return Promise.resolve({ outcome: { outcome: 'pass', spans: [] } })
}
`

export interface World {
  db: Db
  root: string
  pipe: PipeRow
  plan: number
  target: number
}

export function stub(text: string, exit = 0): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: () => Promise.resolve({
      text, usage: { input: 10, cache: 20, output: 30 }, seconds: 0.5, exit,
      stop_reason: exit === 0 ? 'end_turn' : 'hook_stopped', denials: exit,
    }),
  }
}

export function world(pulse: 'warm' | 'cold' = 'warm', day = new Date().toISOString().slice(0, 10)): World {
  const root = mkdtempSync(join(tmpdir(), 'cf-seq-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(root, dir), { recursive: true })
  const db = fresh(join(repo, 'schema'))
  const merge = pulse === 'warm' ? day : '2000-01-01'
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, 'acme/widget', ?, 2, 1, ?, 3, 4, ?, 'https://github.com/acme/widget')`).run(day, merge, pulse)
  db.prepare(`INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/widget', 12, 'maintainer', ?, ?, 'https://github.com/acme/widget/issues/12')`)
    .run(pulse === 'warm' ? 'ready' : 'parked', day)
  db.prepare("INSERT INTO pipes (id, name, enabled, window_start, window_end, max_concurrent) VALUES (1, 'pr-path', 1, '00:00', '23:59', 1)").run()
  db.prepare("INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries) VALUES (1, 1, 1, 'pr_path', 'queued', ?, 0, 0)")
    .run(`${day}T00:00:00.000Z`)
  put(root, 1, 'issue.md', '# hello\n\n- **D1** add `hello()` in `src/hello.ts`\n')
  return { db, root, pipe: pipeRow(db), plan: 1, target: 1 }
}

export function bench(root: string): void {
  for (const name of ['code_quality', 'senior_review']) {
    mkdirSync(join(root, 'reviews', name), { recursive: true })
    writeFileSync(join(root, 'reviews', name, 'manifest.yaml'), `review: ${name}\n`)
  }
  writeFileSync(join(root, 'reviews/bench.ts'), BENCH)
}

export function approve(db: Db, target: number): void {
  db.prepare(`INSERT INTO approvals (subject_kind, subject_id, subject_digest, who, approved_at)
    VALUES ('target', ?, ?, 'ceo', '2026-09-17T00:00:00.000Z')`).run(target, 'a'.repeat(64))
}

export function plan(db: Db, id: number): PlanRow {
  return PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(id))
}

function pipeRow(db: Db): PipeRow {
  return db.prepare('SELECT * FROM pipes WHERE id = 1').get() as PipeRow
}
