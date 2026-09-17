import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fresh } from '../../checks/sqlite.ts'
import type { Packet, Provider } from '../../providers/kind.ts'
import type { Db } from '../../store/index.ts'
import { PlanRow, type PipeRow } from '../../store/plans.ts'
import { targetDigest } from '../steps.ts'
import { put } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')

export interface World {
  db: Db
  root: string
  pipe: PipeRow
  plan: number
  target: number
}

export const CARRIED = 'built\n\n---\ndone:\n  - id: D1\n    status: done\n    pointer: src/hello.ts:1\n---\n'

export const PASS = '---\noutcome: pass\n---\n'
export const REFUSE = '---\noutcome: refuse\nclass: correctness\nspans:\n  - src/hello.ts:1\n---\n'

/**
 * One provider standing in for both roles. A reviewer packet is the one with
 * no write tool — `runner/packet.ts:Review` refuses a reviewer that holds one —
 * so the stub answers those with a verdict fence and the builder with `text`.
 */
export function stub(text: string, exit = 0, review = PASS, seen?: (packet: Packet) => void): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => {
      seen?.(packet)
      mkdirSync(dirname(packet.transcript), { recursive: true })
      writeFileSync(packet.transcript, '{"type":"result"}\n')
      return Promise.resolve({
      text: packet.tools.includes('Write') ? text : review,
      transcript_path: packet.transcript,
      usage: { input: 10, cache: 20, output: 30 }, seconds: 0.5, exit,
      stop_reason: exit === 0 ? 'end_turn' : 'hook_stopped', denials: exit,
      })
    },
  }
}

export const TYPESCRIPT = { 'src/hello.ts': 'export const hello = (): string => "hi"\n' }
export const KOTLIN = { 'kotlin/build.gradle.kts': 'plugins { kotlin("jvm") }\n' }

/**
 * The two repositories `checkout()` needs, standing in for github: the target's
 * own repo and our fork of it. `.cf/git-base` aims the sequencer at them, so it
 * clones, fetches upstream and branches for real, off the network.
 */
function remotes(root: string, files: Record<string, string>): void {
  const base = join(root, 'remotes')
  const upstream = join(base, 'acme/widget')
  mkdirSync(upstream, { recursive: true })
  git(upstream, ['init', '-q', '-b', 'main'])
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(upstream, path)), { recursive: true })
    writeFileSync(join(upstream, path), body)
  }
  git(upstream, ['add', '-A'])
  git(upstream, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'])
  git(base, ['clone', '-q', '--no-local', upstream, join(base, 'caliperforge/widget')])
  mkdirSync(join(root, '.cf'), { recursive: true })
  writeFileSync(join(root, '.cf/git-base'), base)
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

export function world(pulse: 'warm' | 'cold' = 'warm', day = new Date().toISOString().slice(0, 10),
  files: Record<string, string> = TYPESCRIPT): World {
  const root = mkdtempSync(join(tmpdir(), 'cf-seq-'))
  for (const dir of ['rules', 'seats', 'reviews', 'rails']) cpSync(join(repo, dir), join(root, dir), { recursive: true })
  remotes(root, files)
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

export function approve(db: Db, target: number): void {
  const t = db.prepare('SELECT repo, issue_no, evidence_measured_at FROM targets WHERE id = ?').get(target) as
    { repo: string; issue_no: number; evidence_measured_at: string }
  db.prepare(`INSERT INTO approvals (subject_kind, subject_id, subject_digest, who, decision, approved_at)
    VALUES ('target', ?, ?, 'ceo', 'approved', '2026-09-17T00:00:00.000Z')`).run(target, targetDigest(t))
}

/** The proof step 6 reads: a deliverable row and the ci-green verdict the rail would have left. */
export function ready(db: Db, id: number): void {
  db.prepare(`INSERT INTO deliverables (plan_id, step, seat, diff_digest, state, tests_pass,
    byte_identical_elsewhere, fork_ci_green, bot_clean, target_warm, evidence)
    VALUES (?, 2, 'typescript_specialist', ?, 'gated', 1, 1, 1, 1, 1, 'https://github.com/acme/widget/issues/12')`)
    .run(id, 'b'.repeat(64))
  forkCi(db, id)
}

/** The one ready proof no step in the tree writes: the verdict `rails/ci-green` would have left on the fork. */
export function forkCi(db: Db, id: number): void {
  db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, rail_id, tokens, seconds)
    VALUES ('ready', 'rail', ?, ?, 6, 'pass', 'ci-green', 0, 0)`).run('c'.repeat(64), id)
}

export function plan(db: Db, id: number): PlanRow {
  return PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(id))
}

function pipeRow(db: Db): PipeRow {
  return db.prepare('SELECT * FROM pipes WHERE id = 1').get() as PipeRow
}
