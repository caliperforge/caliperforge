import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { inject } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Packet, Provider } from '../../providers/kind.ts'
import type { Gh } from '../../rails/ci-green/index.ts'
import type { Db } from '../../store/index.ts'
import { PlanRow, type PipeRow } from '../../store/plans.ts'
import { record } from '../../store/signals.ts'
import { STANDING } from '../brief.ts'
import { tick } from '../index.ts'
import type { Fired } from '../kind.ts'
import type { Wire } from '../push.ts'
import { targetDigest } from '../steps.ts'
import { put, SELF, srcDir } from '../workspace.ts'
import { git, key, TYPESCRIPT } from './bases.ts'

const repo = join(import.meta.dirname, '../..')

export interface World {
  db: Db
  root: string
  pipe: PipeRow
  plan: number
  target: number
}

export const CARRIED = 'built\n\n---\ndone:\n  - id: D1\n    status: done\n    pointer: src/hello.ts:1\n'
  + '  - id: D2\n    status: done\n    pointer: src/hello.ts:1\n---\n'

export const PASS = '---\noutcome: pass\n---\n'

/** CARRIED from a build that also wrote `paths`, each owned under `## Outside the files` (#87). */
export const owning = (paths: string[]): string =>
  CARRIED.replace('built\n\n', `built\n\n## Outside the files\n\n${paths.map((p) => `- \`${p}\` — the test writes it`).join('\n')}\n\n`)
/** CARRIED from a build that also named `paths` for removal under `## Deleted` (#64). */
export const dropping = (paths: string[]): string =>
  CARRIED.replace('built\n\n', `built\n\n## Deleted\n\n${paths.map((p) => `- ${p}`).join('\n')}\n\n`)
export const WORDS = '`hello()` takes no name, so the call the issue names as D2 cannot be refused at all.'
export const REFUSE = `${WORDS}\n\n---\noutcome: refuse\nclass: correctness\nspans:\n  - src/hello.ts:1\n---\n`

const BRIEF = (file: string): string => ['',
  '**What:** add `hello()`.', '**Why:** the ask asks for it.', '**When it ends:** it is exported.', '',
  '## Approach', '', `Write it in \`${file}\`.`, '',
  '## Settled facts', '', '- none: every name the change uses is in this checkout', '',
  '## Cases', '', `- D1 add \`hello()\` in \`${file}\``, '- D2 a call with no name is refused', '',
  '## Must not break', '', '- the exports already in the file', '',
  '## Files', '', `- ${file}`, '',
  '## Files to read', '', `- ${file} — what it exports today`, '',
  '## Who else reads what this changes', '', '- nobody else: the ask names one file', '',
  '## Tests', '', `- ${file} — a call with no name is refused`, '',
  '## Out of scope', '', '- everything the ask does not name', '',
  '## Standing', '', ...STANDING, ''].join('\n')

/** A brief the shape check passes, titled off the ask the packet carries under `# Issue` and named on a file the checkout holds. */
export function briefFor(prompt: string, cwd: string): string {
  const issue = prompt.split('\n# Issue\n').at(-1) ?? ''
  const file = existsSync(join(cwd, 'src/hello.ts')) ? 'src/hello.ts' : 'kotlin/build.gradle.kts'
  return `# ${/^#\s+(.*)$/m.exec(issue)?.[1] ?? 'no title'}\n${BRIEF(file)}`
}

/**
 * One provider standing in for three roles. A reviewer packet is the one with
 * no write tool — `runner/packet.ts:Review` refuses a reviewer that holds one —
 * so the stub answers those with a verdict fence, the brief writer with a brief
 * and the builder with `text`.
 */
export function stub(text: string, exit = 0, review = PASS, seen?: (packet: Packet) => void, brief?: string): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => {
      seen?.(packet)
      mkdirSync(dirname(packet.transcript), { recursive: true })
      writeFileSync(packet.transcript, '{"type":"result"}\n')
      return Promise.resolve({
      text: answer(packet, text, review, brief),
      transcript_path: packet.transcript,
      usage: { input: 10, cache: 20, output: 30 }, seconds: 0.5, ended: exit === 0 ? 'completed' : 'stopped', exit,
      stop_reason: exit === 0 ? 'end_turn' : 'hook_stopped', denials: exit,
      })
    },
  }
}

/** The stub with a sleeping `fire`, and `peak()`: the most fires a lap ever held in flight at once. */
export function slow(ms: number, text: string): Provider & { peak: () => number } {
  const inner = stub(text)
  let live = 0
  let peak = 0
  return {
    ...inner,
    peak: () => peak,
    fire: async (packet) => {
      live += 1
      peak = Math.max(peak, live)
      await sleep(ms)
      live -= 1
      return inner.fire(packet)
    },
  }
}

/** A tick left mid-flight: its leases are taken and its seat is still running when this returns. */
export function inFlight(w: World, ms = 500): Promise<Fired[]> {
  return tick(w.db, w.root, slow(ms, CARRIED))
}

/** The stub with a builder that works: `edit` runs on every fire holding `Write`, and `exit` is that fire's alone. */
export function builds(edit: () => void, review = PASS, exit = 0): Provider {
  const inner = stub(CARRIED, 0, review)
  return {
    ...inner,
    fire: async (packet) => {
      if (!packet.tools.includes('Write')) return inner.fire(packet)
      edit()
      return { ...await inner.fire(packet), ended: exit === 0 ? 'completed' : 'stopped', exit }
    },
  }
}

function answer(packet: Packet, text: string, review: string, brief?: string): string {
  if (packet.tools.includes('Write')) return text
  if (!packet.prompt.includes('# brief_writer')) return review
  return brief ?? briefFor(packet.prompt, packet.cwd)
}

export { KOTLIN, TYPESCRIPT } from './bases.ts'

/**
 * The two repositories `checkout()` needs, standing in for github: the target's
 * own repo and our fork of it. `.cf/git-base` aims the sequencer at them, so it
 * clones, fetches upstream and branches for real, off the network.
 */
function remotes(root: string, files: Record<string, string>): void {
  const base = join(root, 'remotes')
  copy('world', files, false, base)
  mkdirSync(join(root, '.cf'), { recursive: true })
  writeFileSync(join(root, '.cf/git-base'), base)
}

/**
 * Our own repository, standing in for github the same way `remotes()` stands in for a
 * stranger's: an internal plan clones it, fetches its `main` and branches off that. It is
 * not bare, so it takes a landing push onto its checked-out `main` only under `denyCurrentBranch`.
 * It carries the rules an internal checkout holds, because step 3 fills their digests in one, and a
 * workflow as the kernel's own repo does; `ci = false` is Atelier's, which runs none (#206).
 */
export function ours(root: string, files: Record<string, string> = TYPESCRIPT, ci = true): void {
  copy('ours', files, ci, join(root, 'remotes', SELF))
}

function copy(kind: 'world' | 'ours', files: Record<string, string>, ci: boolean, to: string): void {
  const from = join(inject('bases'), key(kind, files, ci))
  if (!existsSync(from)) throw new Error(`no ${kind} base was built for ${Object.keys(files).join(', ')}`)
  cpSync(from, to, { recursive: true })
}

/** Bytes in the plan's checkout: the stub provider answers with text alone and writes no file. */
export function built(root: string, id: number, line: string): void {
  const path = join(srcDir(root, id), 'src/hello.ts')
  writeFileSync(path, `${readFileSync(path, 'utf8')}${line}\n`)
}

/** A commit landing on our own `main` while a plan is out on its branch. A `body` overwrites a file the branch also touched, which is the conflicting case. */
export function moveMain(root: string, name: string, body?: string): void {
  const dir = join(root, 'remotes', SELF)
  mkdirSync(dirname(join(dir, name)), { recursive: true })
  writeFileSync(join(dir, name), body ?? `export const ${name.replace('.ts', '')} = 1\n`)
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `main moves on ${name}`])
}

/** A plan filed from one of our own issues: an origin, a lane, a seat, and no target row. `plans_one_per_issue` holds one plan per url, so a second plan names a second issue. */
export function internalPlan(db: Db, root: string, id: number, title = 'let an internal plan run', issue = 34,
  priority = 1): number {
  db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
    VALUES (?, 1, NULL, 'pr_path', 'queued', '2026-09-18T00:00:00.000Z', 0, 0, ?, 'machine', 'typescript_specialist', ?)`)
    .run(id, priority, `https://github.com/${SELF}/issues/${String(issue)}`)
  put(root, id, 'ask.md', `# ${title}\n\n- **D1** add \`hello()\` in \`src/hello.ts\`\n`)
  return id
}

const opened = new Map<string, Db>()

export function world(pulse: 'warm' | 'cold' = 'warm', day = new Date().toISOString().slice(0, 10),
  files: Record<string, string> = TYPESCRIPT): World {
  const root = mkdtempSync(join(tmpdir(), 'cf-seq-'))
  for (const dir of ['rules', 'seats', 'reviews', 'rails']) cpSync(join(repo, dir), join(root, dir), { recursive: true })
  remotes(root, files)
  const db = fresh(join(repo, 'schema'))
  opened.set(root, db)
  const merge = pulse === 'warm' ? day : '2000-01-01'
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, 'acme/widget', ?, 2, 1, ?, 3, 4, ?, 'https://github.com/acme/widget')`).run(day, merge, pulse)
  db.prepare(`INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/widget', 12, 'maintainer', ?, ?, 'https://github.com/acme/widget/issues/12')`)
    .run(pulse === 'warm' ? 'ready' : 'parked', day)
  onePipe(db)
  reads(db, 0)
  db.prepare("INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries) VALUES (1, 1, 1, 'pr_path', 'queued', ?, 0, 0)")
    .run(`${day}T00:00:00.000Z`)
  put(root, 1, 'ask.md', '# hello\n\n- **D1** add `hello()` in `src/hello.ts`\n')
  return { db, root, pipe: pipeRow(db), plan: 1, target: 1 }
}

/**
 * The store ships three lanes on, over a window with a wall clock in it. A sequencer test is one
 * lane wide and runs at whatever hour the suite runs at, so the world opens the pr-path pipe all
 * day and drops the two lanes it does not drive; a test that wants a second names it itself.
 */
function onePipe(db: Db): void {
  db.prepare("UPDATE pipes SET window_start = '00:00', window_end = '23:59' WHERE name = 'pr-path'").run()
  db.prepare("DELETE FROM pipes WHERE name IN ('comms', 'research')").run()
}

/** The COO's reads of the first ten briefs (`store/holds.ts`): spent in a world that is not driving them. */
export function reads(db: Db, n: number): void {
  db.prepare("UPDATE settings SET value = ? WHERE key = 'brief.reads_left'").run(String(n))
}

export function approve(db: Db, target: number): void {
  const t = db.prepare('SELECT repo, issue_no, evidence_measured_at FROM targets WHERE id = ?').get(target) as
    { repo: string; issue_no: number; evidence_measured_at: string }
  db.prepare(`INSERT INTO approvals (subject_kind, subject_id, subject_digest, who, decision, approved_at)
    VALUES ('target', ?, ?, 'ceo', 'approved', '2026-09-17T00:00:00.000Z')`).run(target, targetDigest(t))
}

export const RUN = 'https://github.com/caliperforge/widget/actions/runs/1'
export const PR = 'https://github.com/acme/widget/pull/7'

/** The fork's CI as step 6 reads it: one run, read against whatever head the branch is on by then. */
export function runsOn(root: string, id: number, status = 'completed', conclusion = 'success'): Gh {
  return () => JSON.stringify([runAt(root, id, status, conclusion)])
}

/** A lap carrying more than one plan: a run at each plan's head, and `ci-green` keeps the one at its own. */
export function runsAll(root: string, ids: number[]): Gh {
  return () => JSON.stringify(ids.map((id) => runAt(root, id)))
}

function runAt(root: string, id: number, status = 'completed', conclusion = 'success'): object {
  return {
    headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: srcDir(root, id), encoding: 'utf8' }).trim(),
    status, conclusion, url: RUN, workflowName: 'CI',
  }
}

/** The window a live push lands in: github lists no run at the new head until `misses` reads later. */
export function runsAfter(root: string, id: number, misses: number): Gh {
  const listed = runsOn(root, id)
  let read = 0
  return (args) => {
    read += 1
    return read <= misses ? '[]' : listed(args)
  }
}

/** A fork that stays red, read as a live lap reads it: the push's runs miss the API once, then fail. */
export function redLaps(root: string, id: number): Gh {
  const red = runsOn(root, id, 'completed', 'failure')
  let read = 0
  return (args) => {
    read += 1
    return read % 2 === 1 ? '[]' : red(args)
  }
}

/**
 * A head red on Validate, listed on every branch but `base.branch`, where only its last green head's run lists, as `g`
 * says; a `run rerun` goes in `log` and sets it going. Both runs' failed logs name the same job.
 */
export function rerunning(log: string[], root: string, id: number, base: { branch: string; sha: string }, g: { status: string; conclusion: string }): Gh {
  return (args) => {
    if (args[1] === 'rerun') {
      log.push(args.join(' '))
      g.status = 'in_progress'
      return ''
    }
    if (args.includes('--log-failed')) return 'validate\tInstall\t2026-09-24T18:47:03Z lockfile needs updating\n'
    if (args[1] === 'view') return JSON.stringify({ workflowName: 'Validate' })
    return JSON.stringify(args[args.indexOf('--branch') + 1] === base.branch
      ? [{ headSha: base.sha, ...g, url: RUN, workflowName: 'Validate' }]
      : [{ ...runAt(root, id, 'completed', 'failure'), url: RUN.replace(/1$/, '2'), workflowName: 'Validate' }])
  }
}

/** The author of the score every `watched` rehearsal records: a test that counts signals leaves it out. */
export const SEEDED = 'seeded'

/** Greptile's score on the rehearsal at the checkout's HEAD, in the db `world()` opened for `root`. */
export function scored(root: string, id: number, score: number, body: string | null = null, author = SEEDED): void {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: srcDir(root, id), encoding: 'utf8' }).trim()
  const db = opened.get(root)
  if (db !== undefined) {
    record(db, { repo: 'caliperforge/widget', pr: 1, kind: 'bot_review', author, at: new Date().toISOString(),
      external_id: `${author}-${head}`, score, plan: id, body, head })
  }
}

/** The transport a test drives a lap through: every send, pull request and close is a line in `log`. */
export function watched(log: string[], root: string, id: number, runs = runsOn(root, id)): Wire {
  return {
    send: (dir, branch) => void log.push(`send ${basename(dir)} ${branch}`),
    open: (repo, head) => { log.push(`open ${repo} ${head}`); return PR },
    close: (repo, no, sha) => void log.push(`close ${repo}#${String(no)} ${sha.slice(0, 7)}`),
    runs,
    rehearse: (fork, branch) => {
      scored(root, id, 5)
      const line = `rehearse ${fork} ${branch}`
      if (log.findLast((l) => l === line || l === `un${line}`) !== line) log.push(line)
    },
    unrehearse: (fork, branch) => void log.push(`unrehearse ${fork} ${branch}`),
    file: (repo, title) => {
      log.push(`file ${repo} ${title}`)
      return `https://github.com/${repo}/issues/${String(900 + log.filter((l) => l.startsWith('file ')).length)}`
    },
    comment: (repo, no) => void log.push(`comment ${repo}#${String(no)}`),
    install: () => void log.push('install'),
  }
}

/** The same transport with a real landing: a `main` send moves our remote, so a second lander in the lap meets it. */
export function landing(wire: Wire): Wire {
  return {
    ...wire,
    send: (dir, branch) => { wire.send(dir, branch); if (branch === 'main') git(dir, ['push', 'origin', 'main']) },
  }
}

export function plan(db: Db, id: number): PlanRow {
  return PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(id))
}

function pipeRow(db: Db): PipeRow {
  return db.prepare('SELECT * FROM pipes WHERE id = 1').get() as PipeRow
}
