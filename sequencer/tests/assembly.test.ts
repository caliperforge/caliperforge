import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import { approve as approveCard } from '../../cli/batch.ts'
import type { Pr } from '../../cli/gh.ts'
import { record, type SignalRow } from '../../store/signals.ts'
import { approve as approvePublish } from '../card.ts'
import { tick } from '../index.ts'
import { kernelPlan } from '../home.ts'
import type { Wire } from '../push.ts'
import { repoOf } from '../ready.ts'
import { started } from '../signals.ts'
import { checkout, diffOf, fetchMain, FORK, get, maybe, put, SELF, srcDir } from '../workspace.ts'
import { built, CARRIED, plan, PR, REFUSE, stub, watched, world, type World } from './world.ts'

const ID = 2

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

interface Assembly { w: World; fork: string; upstream: string }

function part(w: World, id: number, n: number, state = 'queued'): void {
  const url = `https://github.com/${SELF}/issues/${String(899 + id)}`
  w.db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
    VALUES (?, 1, 1, 'pr_path', ?, '2026-09-18T00:00:00.000Z', 0, 0, 1, 'machine', 'typescript_specialist', ?)`).run(id, state, url)
  w.db.prepare("INSERT INTO parts (parent, n, url, title, body, plan) VALUES (1, ?, ?, 'part', '', ?)").run(n, url, id)
  put(w.root, id, 'ask.md', '# hello part\n\n- **D1** add `hello()` in `src/hello.ts`\n')
}

function assembling(): Assembly {
  const w = world()
  w.db.prepare("UPDATE plans SET state = 'done' WHERE id = 1").run()
  part(w, ID, 0)
  const fork = join(w.root, 'remotes', FORK, 'widget')
  git(fork, ['checkout', '-q', '-b', 'asm/1'])
  writeFileSync(join(fork, 'src/asm.ts'), 'export const asm = 1\n')
  git(fork, ['add', '-A'])
  git(fork, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'asm'])
  git(fork, ['checkout', '-q', 'main'])
  return { w, fork, upstream: join(w.root, 'remotes/acme/widget') }
}

/** The watched log with a real push, so a landing moves the fork's branch. */
function pushing(log: string[], a: Assembly, id = ID): Wire {
  return { ...watched(log, a.w.root, id), send: (dir, branch) => {
    log.push(`send ${basename(dir)} ${branch}`)
    git(dir, ['push', '-q', 'origin', branch])
  } }
}

async function laps(a: Assembly, n: number, wire: Wire, review?: string): Promise<void> {
  for (let at = 0; at < n; at += 1) await tick(a.w.db, a.w.root, stub(CARRIED, 0, review), undefined, undefined, wire)
}

test('a part lands on the fork\'s asm/1 and sends nothing upstream', async () => {
  const a = assembling()
  const log: string[] = []
  const wire = pushing(log, a)
  const tip = git(a.fork, ['rev-parse', 'asm/1'])
  const main = git(a.upstream, ['rev-parse', 'main'])

  await laps(a, 3, wire)
  expect(get(a.w.root, ID, 'base.sha').trim()).toBe(tip)
  built(a.w.root, ID, 'export const landed = true')
  await laps(a, 4, wire)
  expect(plan(a.w.db, ID).step).toBe(7)

  await laps(a, 2, wire)
  const head = git(srcDir(a.w.root, ID), ['rev-parse', 'HEAD'])
  expect(plan(a.w.db, ID).state).toBe('done')
  expect(git(a.fork, ['rev-parse', 'asm/1'])).toBe(head)
  expect(git(a.fork, ['rev-parse', 'main'])).toBe(main)
  expect(git(a.upstream, ['rev-parse', 'main'])).toBe(main)
  expect(git(a.upstream, ['branch', '--list', 'asm/1'])).toBe('')
  expect(log).toEqual(['send src main:refs/heads/asm/1', `close ${SELF}#901 ${head.slice(0, 7)}`])
  expect(a.w.db.prepare('SELECT evidence FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1').get(ID))
    .toEqual({ evidence: `https://github.com/${FORK}/widget/commit/${head}` })
})

test('MAIN comes from the fork with cf.base, else from upstream', async () => {
  const a = assembling()
  await laps(a, 2, watched([], a.w.root, ID))
  const src = srcDir(a.w.root, ID)
  expect(git(src, ['config', 'cf.base'])).toBe('asm/1')
  expect(fetchMain(src)).toBe(git(a.fork, ['rev-parse', 'asm/1']))

  const plain = checkout(a.w.root, 1, 'acme/widget', 'widget-12-a1')
  expect(() => git(plain.dir, ['config', 'cf.base'])).toThrow()
  expect(fetchMain(plain.dir)).toBe(git(a.upstream, ['rev-parse', 'main']))
})

test('a part refused at review rebuilds alone, asm/1 untouched', async () => {
  const a = assembling()
  part(a.w, 3, 1, 'blocked_on_ceo')
  const sibling = a.w.db.prepare('SELECT * FROM plans WHERE id = 3').get()
  const tip = git(a.fork, ['rev-parse', 'asm/1'])
  const wire = pushing([], a)

  await laps(a, 3, wire)
  built(a.w.root, ID, 'export const landed = true')
  await laps(a, 2, wire, REFUSE)
  expect(plan(a.w.db, ID).step).toBe(2)
  expect(a.w.db.prepare('SELECT * FROM plans WHERE id = 3').get()).toEqual(sibling)
  expect(git(a.fork, ['rev-parse', 'asm/1'])).toBe(tip)
})

/** The part landed on asm/1, and the parent holding the `base.sha` its brief was written against. */
async function landed(): Promise<Assembly> {
  const a = assembling()
  put(a.w.root, 1, 'base.sha', `${git(a.upstream, ['rev-parse', 'main'])}\n`)
  const wire = pushing([], a)
  await laps(a, 3, wire)
  built(a.w.root, ID, 'export const landed = true')
  await laps(a, 5, wire)
  return a
}

test('landing the only part puts the parent at senior', async () => {
  const a = await landed()
  expect(plan(a.w.db, 1)).toMatchObject({ step: 5, state: expect.stringMatching(/^(queued|running)$/) as unknown, retries: 0 })
  expect(get(a.w.root, 1, 'issue.md')).toBe(['# hello', '', '- **D1** add `hello()` in `src/hello.ts`', '', '## Parts, joined on asm/1', '',
    '- part', '', '## Cases', '', '- D1 every part\'s cases hold together on asm/1',
    '- D2 a gap between parts is refused: a case no part answers, a name one part adds and no part uses, a change two parts make twice', ''].join('\n'))
})

test('the parent reviews asm/1 and opens one PR after approval', async () => {
  const a = await landed()
  const log: string[] = []
  const wire = watched(log, a.w.root, 1)
  await laps(a, 4, wire)
  expect(git(srcDir(a.w.root, 1), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('asm/1')
  expect(diffOf(a.w.root, 1)).toContain('src/asm.ts')
  expect(plan(a.w.db, 1)).toMatchObject({ step: 7, wait_reason: 'ceo_batch' })
  expect(log.filter((l) => l.startsWith('open '))).toEqual([])

  approveCard(a.w.db, a.w.root, 'plan', 1, 'ceo')
  await laps(a, 2, wire)
  approvePublish(a.w.db, a.w.root, 1, 'ceo')
  await laps(a, 1, wire)
  expect(log.filter((l) => l.startsWith('open '))).toEqual(['open acme/widget caliperforge:asm/1'])
})

test('a part last refused at pre_review holds the parent at ready', async () => {
  const a = await landed()
  a.w.db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds)
    VALUES ('pre_review', 'rail', ?, ?, 3, 'refuse', 'authority', 'rail', 'authority', 0, 0)`).run('0'.repeat(64), ID)
  await laps(a, 3, watched([], a.w.root, 1))
  expect(plan(a.w.db, 1)).toMatchObject({ step: 6, wait_reason: 'ready_proof' })
  expect(a.w.db.prepare('SELECT tests_pass FROM deliverables WHERE plan_id = 1 ORDER BY id DESC LIMIT 1').get()).toEqual({ tests_pass: 0 })
})

/** The parent done, its pull request from asm/1 open. */
function opened(a: Assembly): void {
  const digest = '0'.repeat(64)
  const approval = a.w.db.prepare(`INSERT INTO approvals (subject_kind, subject_id, subject_digest, who, decision, approved_at)
    VALUES ('plan', 1, ?, 'ceo', 'approved', '2026-09-17T00:00:00.000Z')`).run(digest).lastInsertRowid
  a.w.db.prepare(`INSERT INTO deliverables (plan_id, step, seat, diff_digest, state, tests_pass, byte_identical_elsewhere,
    fork_ci_green, bot_clean, target_warm, approval_id, evidence)
    VALUES (1, 8, 'typescript_specialist', ?, 'pushed', 1, 1, 1, 1, 1, ?, ?)`).run(digest, approval, PR)
  a.w.db.prepare("UPDATE plans SET state = 'done', step = 9, head_digest = ? WHERE id = 1").run(digest)
}

function said(a: Assembly, kind: 'review' | 'comment', state: string | null): SignalRow {
  const row = record(a.w.db, { repo: 'acme/widget', pr: 7, kind, author: 'maintainer', at: new Date().toISOString(),
    external_id: `${kind}-${String(state)}`, score: null, plan: 1, body: 'rename expires to expiry', state })
  if (row === null) throw new Error('recorded twice')
  return row
}

/** The fix part's issue is its own number, apart from part 1's. */
function filing(log: string[], a: Assembly, id = ID): Wire {
  return { ...pushing(log, a, id), file: (repo, title) => {
    log.push(`file ${repo} ${title}`)
    return `https://github.com/${repo}/issues/950`
  } }
}

const quiet = (): Pr => ({ number: 7, url: PR, state: 'OPEN', mergedAt: null, mergedBy: null, reviewDecision: null,
  comments: [], reviews: [], statusCheckRollup: [] })

test('a requested change on the assembled PR files and queues p1b', async () => {
  const a = await landed()
  opened(a)
  const parent = plan(a.w.db, 1)
  const log: string[] = []
  const fix = started(a.w.db, said(a, 'review', 'CHANGES_REQUESTED'), a.w.root, filing(log, a))
  const id = Number(fix?.plan)
  expect(fix).toMatchObject({ template: 'pr_path', step: 0 })
  expect(log).toEqual([`file ${SELF} p1b: address maintainer's review on acme/widget#7`])
  expect(a.w.db.prepare('SELECT n, after, plan FROM parts WHERE parent = 1 AND n = 1').get()).toEqual({ n: 1, after: null, plan: id })
  expect(plan(a.w.db, id)).toMatchObject({ step: 0, state: 'queued' })
  expect(get(a.w.root, id, 'ask.md')).toContain('rename expires to expiry')
  expect(plan(a.w.db, 1)).toEqual(parent)
  expect(maybe(a.w.root, 1, 'refusal.md')).toBeNull()
})

test('the fix part lands on asm/1; the parent returns to senior', async () => {
  const a = await landed()
  opened(a)
  const log: string[] = []
  const id = Number(started(a.w.db, said(a, 'review', 'CHANGES_REQUESTED'), a.w.root, filing(log, a))?.plan)
  const wire = filing(log, a, id)
  const main = git(a.upstream, ['rev-parse', 'main'])
  const branches = git(a.upstream, ['branch', '--list'])
  const lap = (): Promise<unknown> => tick(a.w.db, a.w.root, stub(CARRIED), undefined, quiet, wire)

  for (let at = 0; at < 3; at += 1) await lap()
  built(a.w.root, id, 'export const fixed = true')
  for (let at = 0; at < 8 && plan(a.w.db, 1).step !== 5; at += 1) await lap()
  expect(plan(a.w.db, 1).step).toBe(5)
  expect(git(a.fork, ['rev-parse', 'asm/1'])).toBe(git(srcDir(a.w.root, id), ['rev-parse', 'HEAD']))
  expect(git(a.upstream, ['rev-parse', 'main'])).toBe(main)
  expect(git(a.upstream, ['branch', '--list'])).toBe(branches)
  expect(log.filter((l) => /^(send|open) /.test(l))).toEqual(['send src main:refs/heads/asm/1'])
  expect(a.w.db.prepare("SELECT evidence FROM deliverables WHERE plan_id = 1 AND state = 'pushed' ORDER BY id DESC LIMIT 1").get())
    .toEqual({ evidence: PR })
})

test('a plain comment rewinds; a failed filing leaves no part', async () => {
  const a = await landed()
  opened(a)
  const wire = { ...watched([], a.w.root, 1), file: (): string => { throw new Error('gh is down') } }
  const parts = (): unknown => a.w.db.prepare('SELECT count(*) AS n FROM parts WHERE parent = 1').get()

  started(a.w.db, said(a, 'comment', null), a.w.root, wire)
  expect(plan(a.w.db, 1)).toMatchObject({ step: 2, state: 'blocked_on_ceo' })

  a.w.db.prepare("UPDATE plans SET state = 'done', step = 9, head_digest = ? WHERE id = 1").run('0'.repeat(64))
  started(a.w.db, said(a, 'review', 'CHANGES_REQUESTED'), a.w.root, wire)
  expect(plan(a.w.db, 1)).toMatchObject({ step: 2, state: 'blocked_on_ceo' })
  expect(parts()).toEqual({ n: 1 })
  expect(get(a.w.root, 1, 'refusal.md')).toContain('rename expires to expiry')
})

test('a part plan is not the kernel\'s; its repo is the target\'s', () => {
  const a = assembling()
  expect(kernelPlan(plan(a.w.db, ID))).toBe(false)
  expect(repoOf(a.w.db, plan(a.w.db, ID))).toBe('acme/widget')
})
