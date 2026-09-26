import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { approve as approveCard, batch, refuse as refuseCard } from '../../cli/batch.ts'
import type { Pr } from '../../cli/gh.ts'
import { close, settled } from '../../cli/session.ts'
import { headApproved, headDigest, refusedPush } from '../../store/approvals.ts'
import type { Db } from '../../store/index.ts'
import { advance, rewind } from '../../store/plans.ts'
import { open as openProposals } from '../../store/proposals.ts'
import { SignalRow } from '../../store/signals.ts'
import { capture } from '../capture.ts'
import { classOf } from '../escapes.ts'
import { headOf, prBody, push } from '../push.ts'
import { started } from '../signals.ts'
import { unanswered } from '../steps.ts'
import { unread } from '../../cli/inbox.ts'
import { put, srcDir } from '../workspace.ts'
import { tick } from '../index.ts'
import { approve, CARRIED, plan, PR as URL, stub, watched, world, type World } from './world.ts'

const TRANSCRIPT = [
  'RULING push.digest = approval_matches_head_and_the_hook',
  'the ceo said a lot of other things here and none of them are written anywhere',
  'WORK batch.card = show_the_change_and_the_marks',
  'ORDERING p7.comms = after_p6',
  'WORLD fork.ci = green',
  'MEASUREMENT tick.interval = 300s',
].join('\n')

const SHA = 'a'.repeat(40)
const REVIEWED = `Last reviewed commit: [fix](https://github.com/acme/widget/commit/${SHA})`

const pr = (over: Partial<Pr> = {}): Pr => ({
  number: 7, url: URL, state: 'OPEN', mergedAt: null, mergedBy: null, reviewDecision: null,
  comments: [], reviews: [], statusCheckRollup: [], ...over,
})

async function atBatch(): Promise<World> {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  writeFileSync(join(srcDir(w.root, 1), 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  expect(plan(w.db, 1).step).toBe(7)
  return w
}

test('the batch is a card per plan at ready and per open proposal, with a green/red check list', async () => {
  const w = await atBatch()
  const card = batch(w.db, w.root)[0]
  expect(card).toMatchObject({ kind: 'plan', id: 1, title: 'acme/widget#12 widget-12-a1' })
  expect(card?.digest).toBe(headDigest(headOf(w.root, 1).sha))
  expect(card?.change).toBe('  1 file(s)\t+1\t-1')
  expect(card?.text).toBe('Addresses #12.\n\n## Summary\n\n- add `hello()`.\n- the ask asks for it.\n\n## Test Plan\n\n- CI green on our fork at this head.')
  expect(card?.marks).toEqual([
    { name: 'pre_review', ok: true }, { name: 'review', ok: true },
    { name: 'senior_review', ok: true }, { name: 'ready', ok: true },
  ])
})

test('a plan cannot leave ready without an approval row, and the store is what refuses', async () => {
  const w = await atBatch()
  expect(() => { advance(w.db, plan(w.db, 1), 8) }).toThrow(/no ceo approval row/)
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  const digest = approveCard(w.db, w.root, 'plan', 1)
  expect(w.db.prepare("SELECT who, decision, subject_digest FROM approvals WHERE subject_kind = 'plan'").get())
    .toEqual({ who: 'ceo', decision: 'approved', subject_digest: digest })
  advance(w.db, plan(w.db, 1), 8)
  expect(plan(w.db, 1).step).toBe(8)
})

test('push refuses without a matching row, then pushes the approved head and opens the pr', async () => {
  const w = await atBatch()
  const sent: string[] = []
  const wire = watched(sent, w.root, 1)
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'refuse' })
  expect(sent).toEqual([])
  approveCard(w.db, w.root, 'plan', 1)
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'pass' })
  expect(sent).toEqual(['send src widget-12-a1', 'unrehearse caliperforge/widget widget-12-a1', 'open acme/widget caliperforge:widget-12-a1'])
  expect(w.db.prepare('SELECT state, evidence FROM deliverables WHERE plan_id = 1 ORDER BY id DESC LIMIT 1').get())
    .toEqual({ state: 'pushed', evidence: URL })
})

test('an outside branch reaches the batch as one commit, titled off the brief, naming no upstream number', async () => {
  const w = await atBatch()
  const log = execFileSync('git', ['log', '--format=%B%x00', 'refs/remotes/upstream/main..HEAD'],
    { cwd: srcDir(w.root, 1), encoding: 'utf8' }).split('\0').map((m) => m.trim()).filter((m) => m !== '')
  expect(log).toEqual(['hello\n\nadd `hello()`.\n\nthe ask asks for it.'])
})

test('a body the card set is the one the pull request opens with', async () => {
  const w = await atBatch()
  put(w.root, 1, 'pr.md', 'Addresses the defaults-table item in #12.\n')
  const bodies: string[] = []
  const wire = { ...watched([], w.root, 1), open: (...args: [string, string, string, string]) => {
    bodies.push(readFileSync(args[3], 'utf8'))
    return URL
  } }
  approveCard(w.db, w.root, 'plan', 1)
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'pass' })
  expect(bodies).toEqual(['Addresses the defaults-table item in #12.\n'])
})

test('the pre-push hook asks of what lands on main whether the ceo signed it, and lets the fork branch by', async () => {
  const w = await atBatch()
  const sha = headOf(w.root, 1).sha
  const onto = (ref: string): string[] => refusedPush(w.db, `refs/heads/x ${sha} ${ref} ${'0'.repeat(40)}\n`)
  expect(headApproved(w.db, sha)).toBe(false)
  expect(onto('refs/heads/main')).toEqual([sha])
  expect(onto('refs/heads/widget-12-a1')).toEqual([])
  approveCard(w.db, w.root, 'plan', 1)
  expect(headApproved(w.db, sha)).toBe(true)
  expect(onto('refs/heads/main')).toEqual([])
  expect(headApproved(w.db, 'f'.repeat(40))).toBe(false)
})

test('the tick records every comment, review, bot review and merge on our open pr, once', async () => {
  const w = await pushed()
  const view = pr({
    comments: [{ id: 'c1', author: { login: 'maintainer' }, body: 'please split this', createdAt: '2026-09-17T10:00:00Z' }],
    reviews: [{ id: 'r1', author: { login: 'greptile-apps[bot]' }, body: `score 4/5\n\n${REVIEWED}`, submittedAt: '2026-09-17T11:00:00Z' }],
    statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE' }],
  })
  expect(capture(w.db, () => view).map((s) => s.kind)).toEqual(['comment', 'bot_review', 'ci_red'])
  expect(capture(w.db, () => view)).toEqual([])
  expect(w.db.prepare('SELECT kind, author, score, pr, plan FROM signals ORDER BY id').all()).toEqual([
    { kind: 'comment', author: 'maintainer', score: null, pr: 7, plan: 1 },
    { kind: 'bot_review', author: 'greptile-apps[bot]', score: 4, pr: 7, plan: 1 },
    { kind: 'ci_red', author: 'ci', score: null, pr: 7, plan: 1 },
  ])
})

/** #103: on plan 65 Greptile's 5/5 summary comment rewound the finished job and told the CEO he was asked. */
test('a review bot\'s summary comment is its score, not a person asking', async () => {
  const w = await pushed()
  const summary = (n: number): string => `<h2><a href="https://app.greptile.com"><picture></picture></a>Confidence Score: ${String(n)}/5</h2>\n\n1 of 2 files\n\n${REVIEWED}`
  const view = pr({ comments: [
    { id: 'g1', author: { login: 'greptile-apps' }, body: summary(5), createdAt: new Date(Date.now() + 1000).toISOString() },
    { id: 'g2', author: { login: 'greptile-apps' }, body: summary(3), createdAt: new Date(Date.now() + 2000).toISOString() },
  ] })
  const [five, three] = capture(w.db, () => view)
  if (five === undefined || three === undefined) throw new Error('two signals expected')
  expect([five.kind, five.score, three.kind, three.score]).toEqual(['bot_review', 5, 'bot_review', 3])
  expect(started(w.db, five)).toBeNull()
  expect(started(w.db, three)).toMatchObject({ step: 4 })
})

test('a Greptile summary is stored with the head it reviewed; one in the older format stores nothing', async () => {
  const w = await pushed()
  const at = new Date(Date.now() + 1000).toISOString()
  const view = pr({ comments: [
    { id: 'g1', author: { login: 'greptile-apps' }, body: `Confidence Score: 4/5\n\n${REVIEWED}`, createdAt: at },
    { id: 'g2', author: { login: 'greptile-apps' }, body: 'Confidence Score: 4/5', createdAt: at },
  ] })
  expect(capture(w.db, () => view).map((s) => s.external_id)).toEqual(['g1'])
  expect(w.db.prepare('SELECT external_id, score, head FROM signals').all()).toEqual([{ external_id: 'g1', score: 4, head: SHA }])
})

test('what we said on our own pull request is not a signal; their words and the review state are kept', async () => {
  const w = await pushed()
  const view = pr({
    author: { login: 'michael-moffett' },
    comments: [
      { id: 'c1', author: { login: 'michael-moffett' }, body: '@efe this rounds out the languages', createdAt: '2026-09-17T09:00:00Z' },
      { id: 'c2', author: { login: 'maintainer' }, body: 'can you add PHP too?', createdAt: '2026-09-17T10:00:00Z' },
    ],
    reviews: [{ id: 'r1', author: { login: 'maintainer' }, body: 'rename this', submittedAt: '2026-09-17T11:00:00Z', state: 'CHANGES_REQUESTED' }],
  })
  expect(capture(w.db, () => view).map((s) => [s.kind, s.author, s.body, s.state])).toEqual([
    ['comment', 'maintainer', 'can you add PHP too?', null],
    ['review', 'maintainer', 'rename this', 'CHANGES_REQUESTED'],
  ])
})

test('a changes-requested review goes to the builder with the words; a plain comment waits there for a person', async () => {
  const w = await pushed()
  const said = (id: string, state: string | undefined, body: string): SignalRow[] => capture(w.db, () => pr({
    reviews: [{ id, author: { login: 'maintainer' }, body, submittedAt: new Date(Date.now() + 60_000).toISOString(),
      ...(state === undefined ? {} : { state }) }],
  }))
  const [asked] = said('r1', 'CHANGES_REQUESTED', 'rename expires to expiry')
  expect(asked === undefined ? null : started(w.db, asked, w.root)).toMatchObject({ plan: 1, step: 2 })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, state: 'running' })
  expect(readFileSync(join(w.root, '.cf/work/1/refusal.md'), 'utf8')).toContain('rename expires to expiry')
  expect(unread(w.root).map((e) => e.kind)).toEqual(['asked'])

  const [plain] = said('r2', 'COMMENTED', 'why 120 and not 60?')
  if (plain !== undefined) started(w.db, plain, w.root)
  expect(plan(w.db, 1)).toMatchObject({ step: 2, state: 'blocked_on_ceo' })
})

test('a round on an open pull request pushes its branch without opening another', async () => {
  const w = await pushed()
  const sent: string[] = []
  const wire = watched(sent, w.root, 1)
  rewind(w.db, 1, 4)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, () => pr(), wire)
  expect(sent).toEqual(['send src HEAD:refs/heads/widget-12-a1-next', 'rehearse caliperforge/widget widget-12-a1-next'])
  approveCard(w.db, w.root, 'plan', 1)
  advance(w.db, plan(w.db, 1), 8)
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'pass', note: `pushed widget-12-a1 onto ${URL}` })
  expect(sent.slice(2)).toEqual(['send src widget-12-a1', 'unrehearse caliperforge/widget widget-12-a1-next'])
})

test('a round whose -next the fork holds at a commit HEAD lacks goes out under the next free name, forcing nothing', async () => {
  const w = await pushed()
  const src = srcDir(w.root, 1)
  const git = (args: string[]): string => execFileSync('git', args, { cwd: src, encoding: 'utf8' }).trim()
  const stale = git(['-c', 'user.email=cf@caliperforge.dev', '-c', 'user.name=caliperforge', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'stale'])
  git(['push', '-q', 'origin', `${stale}:refs/heads/widget-12-a1-next`])
  const sent: string[] = []
  const wire = watched(sent, w.root, 1)
  rewind(w.db, 1, 4)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, () => pr(), wire)
  expect(sent).toEqual(['unrehearse caliperforge/widget widget-12-a1-next', 'send src HEAD:refs/heads/widget-12-a1-next2',
    'rehearse caliperforge/widget widget-12-a1-next2'])
  approveCard(w.db, w.root, 'plan', 1)
  advance(w.db, plan(w.db, 1), 8)
  push(w.db, w.root, plan(w.db, 1), wire)
  expect(sent.slice(3)).toEqual(['send src widget-12-a1', 'unrehearse caliperforge/widget widget-12-a1-next2'])
  expect(sent.filter((l) => l.includes('--force') || l.includes('+refs'))).toEqual([])
})

test('a counterparty finding on merged code is an escape against the step the map says owns it', async () => {
  const w = await pushed()
  const merged = pr({
    mergedAt: '2026-09-18T09:00:00Z', mergedBy: { login: 'maintainer' },
    reviews: [{ id: 'r9', author: { login: 'maintainer' }, body: 'this is a scope problem', submittedAt: '2026-09-18T08:00:00Z' }],
  })
  capture(w.db, () => merged)
  expect(w.db.prepare('SELECT kind, defect_class, owner, evidence FROM dispositions').get())
    .toEqual({ kind: 'escaped', defect_class: 'scope', owner: 'review', evidence: URL })
  expect(classOf('tight.comment on line 3')).toBe('tight.comment')
  expect(classOf('no class named here')).toBe('correctness')
})

const FORKED = pr({
  number: 3, url: 'https://github.com/caliperforge/widget/pull/3',
  comments: [{ id: 'c3', author: { login: 'maintainer' }, body: 'why this?', createdAt: '2026-09-17T10:00:00Z' }],
  reviews: [{ id: 'g3', author: { login: 'greptile-apps[bot]' }, body: `Confidence Score: 4/5\n\n${REVIEWED}`, submittedAt: '2026-09-17T11:00:00Z' }],
  statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE' }],
})

const forked = (repo: string): Pr => (repo === 'caliperforge/widget' ? FORKED : pr())

const listing = (heads: string[]) => (args: string[]): unknown => {
  const head = args[args.indexOf('--head') + 1] ?? ''
  heads.push(head)
  return head === 'widget-12-a1-next' ? [{ number: 3 }] : []
}

test('only the bot review on the rehearsal is kept, on the plan, and a merge upstream takes no escape from it', async () => {
  const w = await pushed()
  expect(capture(w.db, forked, w.root, listing([]))).toEqual([])
  expect(w.db.prepare('SELECT repo, pr, kind, score, head, plan FROM signals').all())
    .toEqual([{ repo: 'caliperforge/widget', pr: 3, kind: 'bot_review', score: 4, head: SHA, plan: 1 }])
  capture(w.db, () => pr({ mergedAt: '2026-09-18T09:00:00Z', mergedBy: { login: 'maintainer' } }))
  expect(w.db.prepare('SELECT count(*) AS n FROM dispositions').get()).toEqual({ n: 0 })
})

test('a plan with no checkout is asked about no rehearsal', async () => {
  const w = await pushed()
  w.db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries)
    VALUES (2, 1, 1, 'pr_path', 'running', ?, 7, 0)`).run('2026-09-17T00:00:00.000Z')
  const heads: string[] = []
  capture(w.db, forked, w.root, listing(heads))
  expect(heads).toEqual(['widget-12-a1-next'])
})

test('a pr the tick cannot read this time does not stop the pipes behind it', async () => {
  const w = await pushed()
  expect(capture(w.db, () => { throw new Error('gh: could not resolve host') })).toEqual([])
  expect(capture(w.db, () => pr({ comments: [{ id: 'c1', author: { login: 'maintainer' }, body: 'hi', createdAt: '2026-09-17T10:00:00Z' }] })))
    .toHaveLength(1)
})

test('a vague bot finding does not take the disposition slot a named one earned', async () => {
  const w = await pushed()
  const merged = pr({
    mergedAt: '2026-09-18T09:00:00Z', mergedBy: { login: 'maintainer' },
    reviews: [
      { id: 'r1', author: { login: 'greptile[bot]' }, body: `looks fine 4/5\n\n${REVIEWED}`, submittedAt: '2026-09-18T07:00:00Z' },
      { id: 'r2', author: { login: 'maintainer' }, body: 'this is a scope problem', submittedAt: '2026-09-18T08:00:00Z' },
    ],
  })
  capture(w.db, () => merged)
  expect(w.db.prepare('SELECT defect_class FROM dispositions').all()).toEqual([{ defect_class: 'scope' }])
})

test('an approval that cannot settle its row writes no approval row either', async () => {
  const w = await atBatch()
  const path = `${w.root}/one.md`
  writeFileSync(path, 'RULING batch.card = change_text_and_marks\n')
  close(w.db, path, () => null)
  const id = Number(openProposals(w.db)[0]?.id)
  expect(() => approveCard(w.db, w.root, 'proposal', id)).toThrow(/names no issue/)
  expect(w.db.prepare("SELECT count(*) AS n FROM approvals WHERE subject_kind = 'proposal'").get()).toEqual({ n: 0 })
  expect(openProposals(w.db)).toHaveLength(1)
})

test('a plan at ready with no checkout stays on the card list and cannot be signed', async () => {
  const w = await atBatch()
  w.db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries)
    VALUES (2, 1, 1, 'pr_path', 'running', ?, 7, 0)`).run('2026-09-17T00:00:00.000Z')
  const blind = batch(w.db, w.root).find((c) => c.id === 2)
  expect(blind).toMatchObject({ kind: 'plan', digest: '', marks: [{ name: 'bytes on the branch', ok: false }] })
  expect(() => approveCard(w.db, w.root, 'plan', 2)).toThrow(/no bytes on its branch/)
  expect(() => headOf(w.root, 2)).toThrow(/has no checkout/)
  expect(push(w.db, w.root, plan(w.db, 2), watched([], w.root, 2))).toMatchObject({ outcome: 'refuse' })
})

test('a signal starts the plan the map says it starts', async () => {
  const w = await pushed()
  const bot = (score: number): number => signal(w.db, 'bot_review', 'greptile[bot]', score)
  expect(started(w.db, row(w.db, bot(5)))).toBeNull()
  expect(started(w.db, row(w.db, bot(4)))).toMatchObject({ template: 'pr_path', plan: 1, step: 4 })
  expect(plan(w.db, 1)).toMatchObject({ step: 4, state: 'running' })
  expect(started(w.db, row(w.db, signal(w.db, 'ci_red', 'ci', null)))).toMatchObject({ template: 'pr_path', step: 2 })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, state: 'running' })
  const comms = started(w.db, row(w.db, signal(w.db, 'merge', 'maintainer', null)))
  expect(comms).toMatchObject({ template: 'comms', step: 0 })
  expect(w.db.prepare('SELECT template, state FROM plans WHERE id = ?').get(comms?.plan))
    .toEqual({ template: 'comms', state: 'queued' })
  expect(w.db.prepare("SELECT plan, actor FROM events WHERE kind = 'filed'").all())
    .toEqual([{ plan: comms?.plan, actor: 'merge signal' }])
  expect(w.db.prepare("SELECT enabled FROM pipes WHERE name = 'comms'").get()).toEqual({ enabled: 1 })
})

test('answered bot score stops holding', async () => {
  const w = await pushed()
  const build = (at: string): void => void w.db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model,
    effort, input_tokens, cache_tokens, output_tokens, seconds, exit, at, transcript_path)
    VALUES (1, 2, 'typescript_specialist', ?, 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, ?, 'x.transcript.jsonl')`)
    .run('0'.repeat(64), at)
  build('2000-01-01 00:00:00')
  signal(w.db, 'bot_review', 'greptile[bot]', 1)
  expect(unanswered(w.db, 1)).toBeDefined()
  build('2999-01-01 00:00:00')
  expect(unanswered(w.db, 1)).toBeUndefined()
})

test('session close writes typed proposals and nothing else, and approval turns a ruling into a row', async () => {
  const w = await atBatch()
  const path = `${w.root}/session.md`
  writeFileSync(path, TRANSCRIPT)
  expect(settled(readFileSync(path, 'utf8')).map((s) => s.class)).toEqual(['ruling', 'work', 'ordering', 'world_fact', 'measurement'])
  expect(close(w.db, path, () => 42)).toHaveLength(5)
  const rows = openProposals(w.db)
  expect(rows.map((r) => r.class)).toEqual(['ruling', 'work', 'ordering', 'world_fact', 'measurement'])
  expect(rows[0]).toMatchObject({ subject: 'push.digest', match_issue_no: 42 })
  expect(rows[0]?.evidence).toBe(`${path}:1`)
  expect(rows[0]?.match_ruling_id).not.toBeNull()

  approveCard(w.db, w.root, 'proposal', Number(rows[0]?.id))
  expect(w.db.prepare("SELECT value, issue_no FROM rulings WHERE subject = 'push.digest' ORDER BY id DESC LIMIT 1").get())
    .toEqual({ value: 'approval_matches_head_and_the_hook', issue_no: 42 })
  refuseCard(w.db, w.root, 'proposal', Number(rows[1]?.id), 'not_now')
  expect(openProposals(w.db).map((r) => r.class)).toEqual(['ordering', 'world_fact', 'measurement'])
  expect(w.db.prepare("SELECT decision, reason FROM approvals WHERE subject_kind = 'proposal' ORDER BY id").all())
    .toEqual([{ decision: 'approved', reason: null }, { decision: 'refused', reason: 'not_now' }])
})

test('a settled item already in rulings proposes nothing, and the pr body stays under twenty lines', async () => {
  const w = await atBatch()
  const path = `${w.root}/again.md`
  writeFileSync(path, 'RULING push.digest = approval_matches_branch_head_digest\n')
  expect(close(w.db, path, () => 42)).toEqual([])
  expect(prBody(12, w.root, 1).split('\n').length).toBeLessThanOrEqual(20)
})

/**
 * The lap-1 push left a `pushed` deliverable, so every tick from here polls it.
 * The reader is injected: an open pr with nothing on it, read off no network.
 */
const lap = (w: World) => tick(w.db, w.root, stub(CARRIED), new Date(), () => pr(), watched([], w.root, 1))

test('a second lap after a rewind puts a fresh card in the batch and cannot leave on the first lap approval', async () => {
  const w = await pushed()
  rewind(w.db, 1, 4)
  expect(plan(w.db, 1).head_digest).toBeNull()
  for (let at = 0; at < 3; at += 1) await lap(w)
  expect(plan(w.db, 1).step).toBe(7)
  expect(w.db.prepare('SELECT state FROM deliverables WHERE plan_id = 1 ORDER BY id').all())
    .toEqual([{ state: 'built' }, { state: 'pushed' }, { state: 'ready' }])
  expect(() => { advance(w.db, plan(w.db, 1), 8) }).toThrow(/no ceo approval row/)
  expect(await lap(w)).toEqual([])
  expect(batch(w.db, w.root).map((c) => c.id)).toEqual([1])

  approveCard(w.db, w.root, 'plan', 1)
  expect(w.db.prepare("SELECT count(*) AS n FROM approvals WHERE subject_kind = 'plan'").get()).toEqual({ n: 1 })
  expect(w.db.prepare('SELECT state FROM deliverables WHERE plan_id = 1 ORDER BY id DESC LIMIT 1').get())
    .toEqual({ state: 'approved' })
  advance(w.db, plan(w.db, 1), 8)
  expect(plan(w.db, 1).step).toBe(8)
})

test('an approved non-ruling item said again in a later session leaves its evidence and the batch alone', async () => {
  const w = await atBatch()
  const first = `${w.root}/first.md`
  writeFileSync(first, 'WORK batch.card = show_the_change_and_the_marks\n')
  const made = close(w.db, first, () => 42)
  approveCard(w.db, w.root, 'proposal', Number(made[0]))
  const again = `${w.root}/again-later.md`
  writeFileSync(again, '\n\nWORK batch.card = show_the_change_and_the_marks\n')
  expect(close(w.db, again, () => 42)).toEqual([])
  expect(w.db.prepare("SELECT state, evidence FROM proposals WHERE subject = 'batch.card'").get())
    .toEqual({ state: 'approved', evidence: `${first}:1` })
  expect(openProposals(w.db)).toHaveLength(0)
})

test('a review read on one tick and the merge on a later one is still one escape', async () => {
  const w = await pushed()
  const review = { id: 'r9', author: { login: 'maintainer' }, body: 'this is a scope problem', submittedAt: '2026-09-18T08:00:00Z' }
  capture(w.db, () => pr({ reviews: [review] }))
  expect(w.db.prepare('SELECT count(*) AS n FROM dispositions').get()).toEqual({ n: 0 })
  capture(w.db, () => pr({ reviews: [review], mergedAt: '2026-09-19T09:00:00Z', mergedBy: { login: 'maintainer' } }))
  expect(w.db.prepare('SELECT kind, defect_class, owner FROM dispositions').all())
    .toEqual([{ kind: 'escaped', defect_class: 'scope', owner: 'review' }])
})

test('the steps write the deliverable themselves, and a plan reaches the batch with no fixture row', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 7; at += 1) {
    await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  }
  expect(plan(w.db, 1).step).toBe(7)
  expect(w.db.prepare('SELECT step, seat, state FROM deliverables WHERE plan_id = 1 ORDER BY id').all()).toEqual([
    { step: 2, seat: 'outside_specialist', state: 'built' },
    { step: 5, seat: 'outside_specialist', state: 'ready' },
  ])
  expect(plan(w.db, 1).head_digest).toBe(headDigest(headOf(w.root, 1).sha))
})

async function pushed(): Promise<World> {
  const w = await atBatch()
  approveCard(w.db, w.root, 'plan', 1)
  push(w.db, w.root, plan(w.db, 1), watched([], w.root, 1))
  return w
}

function row(db: Db, id: number): SignalRow {
  return SignalRow.parse(db.prepare('SELECT * FROM signals WHERE id = ?').get(id))
}

function signal(db: Db, kind: string, author: string, score: number | null): number {
  const written = db.prepare(`INSERT INTO signals (repo, pr, kind, author, at, external_id, score, plan)
    VALUES ('acme/widget', 7, ?, ?, ?, ?, ?, 1)`)
    .run(kind, author, new Date().toISOString(), `${kind}-${String(score)}-${author}`, score)
  return Number(written.lastInsertRowid)
}
