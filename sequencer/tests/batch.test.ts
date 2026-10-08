import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { approve as approveCard, batch, refuse as refuseCard } from '../../cli/batch.ts'
import type { Pr } from '../../cli/gh.ts'
import { close, settled } from '../../cli/session.ts'
import { approvalsOf, headApproved, headDigest, refusedPush, signedHead } from '../../store/approvals.ts'
import { deliverablesOf, newest } from '../../store/deliverables.ts'
import { classOf, dispositionsOf } from '../../store/dispositions.ts'
import type { Db } from '../../store/index.ts'
import { advance, pipeNamed, putPlan, rewind, titles } from '../../store/plans.ts'
import { bySubject, open as openProposals } from '../../store/proposals.ts'
import { latest } from '../../store/rulings.ts'
import { eventsOf, ofKind, pointers, runAt } from '../../store/events.ts'
import { graded, others, record, type SignalRow } from '../../store/signals.ts'
import { capture } from '../capture.ts'
import { approvedPlan } from '../approve.ts'
import { approve as approvePublish } from '../card.ts'
import type { Fired, Outcome } from '../kind.ts'
import { COMMIT, headOf, prBody, push, sent as next, type Wire } from '../push.ts'
import { started } from '../signals.ts'
import { unanswered } from '../ready.ts'
import { unread } from '../../cli/inbox.ts'
import { get, maybe, put, srcDir } from '../workspace.ts'
import { tick } from '../index.ts'
import { approve, CARRIED, internalPlan, plan, PR as URL, SEEDED, stub, tip, watched, world, type World } from './world.ts'

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

const QUIET = { autoReview: [], strictness: 1, customContext: { rules: [], files: [] } }

const pr = (over: Partial<Pr> = {}): Pr => ({
  number: 7, url: URL, state: 'OPEN', mergedAt: null, mergedBy: null, reviewDecision: null,
  comments: [], reviews: [], statusCheckRollup: [], ...over,
})

async function atBatch(): Promise<World> {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 7; at += 1) {
    if (at === 2) writeFileSync(join(srcDir(w.root, 1), 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
    await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  }
  expect(plan(w.db, 1).step).toBe(7)
  return w
}

test('a card per ready plan and open proposal, with checks', async () => {
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

test('D1 newest is the plan\'s highest-id row, or null', async () => {
  const w = await atBatch()
  expect(newest(w.db, 99)).toBeNull()
  expect(newest(w.db, 1)).toMatchObject({ plan_id: 1, state: 'ready' })
})

test('push needs an approval row, then pushes and opens the pr', async () => {
  const w = await atBatch()
  const sent: string[] = []
  const wire = watched(sent, w.root, 1)
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'refuse' })
  expect(sent).toEqual([])
  approveCard(w.db, w.root, 'plan', 1, 'ceo')
  expect(published(w, wire)).toMatchObject({ outcome: 'pass' })
  expect(sent).toEqual(['send src widget-12-a1', 'unrehearse caliperforge/widget widget-12-a1-next', 'open acme/widget caliperforge:widget-12-a1'])
  expect(deliverablesOf(w.db, 1).at(-1)).toEqual({ state: 'pushed', evidence: URL })
})

test('outside branch: one commit, brief title, no upstream number', async () => {
  const w = await atBatch()
  const log = execFileSync('git', ['log', '--format=%B%x00', 'refs/remotes/upstream/main..HEAD'],
    { cwd: srcDir(w.root, 1), encoding: 'utf8' }).split('\0').map((m) => m.trim()).filter((m) => m !== '')
  expect(log).toEqual(['hello\n\nadd `hello()`.\n\nthe ask asks for it.'])
  expect(maybe(w.root, 1, COMMIT)).toBeNull()
})

test('a body the card set is the one the pull request opens with', async () => {
  const w = await atBatch()
  put(w.root, 1, 'pr.md', 'Addresses the defaults-table item in #12.\n')
  const bodies: string[] = []
  const wire = { ...watched([], w.root, 1), open: (...args: [string, string, string, string]) => {
    bodies.push(readFileSync(args[3], 'utf8'))
    return URL
  } }
  approveCard(w.db, w.root, 'plan', 1, 'ceo')
  expect(published(w, wire)).toMatchObject({ outcome: 'pass' })
  expect(bodies).toEqual(['Addresses the defaults-table item in #12.\n'])
})

test('pre-push hook checks ceo sign-off on main, not the fork', async () => {
  const w = await atBatch()
  const sha = headOf(w.root, 1).sha
  const onto = (ref: string): string[] => refusedPush(w.db, `refs/heads/x ${sha} ${ref} ${'0'.repeat(40)}\n`)
  expect(headApproved(w.db, sha)).toBe(false)
  expect(onto('refs/heads/main')).toEqual([sha])
  expect(onto('refs/heads/widget-12-a1')).toEqual([])
  approveCard(w.db, w.root, 'plan', 1, 'ceo')
  expect(headApproved(w.db, sha)).toBe(true)
  expect(onto('refs/heads/main')).toEqual([])
  expect(headApproved(w.db, 'f'.repeat(40))).toBe(false)
})

test('each comment, review, bot review and merge on our pr, once', async () => {
  const w = await pushed()
  const view = pr({
    comments: [{ id: 'c1', author: { login: 'maintainer' }, body: 'please split this', createdAt: '2026-09-17T10:00:00Z' }],
    reviews: [{ id: 'r1', author: { login: 'greptile-apps[bot]' }, body: `score 4/5\n\n${REVIEWED}`, submittedAt: '2026-09-17T11:00:00Z' }],
    statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE' }],
  })
  expect(capture(w.db, () => view).map((s) => s.kind)).toEqual(['comment', 'bot_review', 'ci_red'])
  expect(capture(w.db, () => view)).toEqual([])
  expect(others(w.db, SEEDED).map((s) => ({ kind: s.kind, author: s.author, score: s.score, pr: s.pr, plan: s.plan }))).toEqual([
    { kind: 'comment', author: 'maintainer', score: null, pr: 7, plan: 1 },
    { kind: 'bot_review', author: 'greptile-apps[bot]', score: 4, pr: 7, plan: 1 },
    { kind: 'ci_red', author: 'ci', score: null, pr: 7, plan: 1 },
  ])
})

/** A review bot's 5/5 summary comment does not rewind a finished job or ask a person. */
test('a review bot\'s summary is its score, not a person asking', async () => {
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

test('Greptile summary is kept with its head; old format is not', async () => {
  const w = await pushed()
  const at = new Date(Date.now() + 1000).toISOString()
  const view = pr({ comments: [
    { id: 'g1', author: { login: 'greptile-apps' }, body: `Confidence Score: 4/5\n\n${REVIEWED}`, createdAt: at },
    { id: 'g2', author: { login: 'greptile-apps' }, body: 'Confidence Score: 4/5', createdAt: at },
  ] })
  expect(capture(w.db, () => view).map((s) => s.external_id)).toEqual(['g1'])
  expect(others(w.db, SEEDED).map((s) => ({ external_id: s.external_id, score: s.score, head: s.head }))).toEqual([{ external_id: 'g1', score: 4, head: SHA }])
})

test('our words are no signal; theirs and review state are kept', async () => {
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

test('changes requested go to the builder; a comment to a person', async () => {
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

test('a round on an open pr pushes its branch, opening no other', async () => {
  const w = await pushed()
  const sent: string[] = []
  const wire = watched(sent, w.root, 1)
  rewind(w.db, 1, 4)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, () => pr(), wire)
  expect(sent).toEqual([`send src ${tip(w.root, 1)}:refs/heads/widget-12-a1-next`, 'rehearse caliperforge/widget widget-12-a1-next'])
  approveCard(w.db, w.root, 'plan', 1, 'ceo')
  advance(w.db, plan(w.db, 1), 8)
  expect(published(w, wire)).toMatchObject({ outcome: 'pass', note: `pushed widget-12-a1 onto ${URL}` })
  expect(sent.slice(2)).toEqual(['send src widget-12-a1', 'unrehearse caliperforge/widget widget-12-a1-next'])
})

test('D1 D2 an open pr round conflicting with main goes back', { timeout: 90_000 }, async () => {
  const w = await pushed()
  const sent: string[] = []
  const wire = watched(sent, w.root, 1)
  const upstream = join(w.root, 'remotes/acme/widget')
  rewind(w.db, 1, 4)
  writeFileSync(join(upstream, 'src/hello.ts'), 'export const hello = (): string => "upstream"\n')
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'main moves on'], { cwd: upstream })
  const fired: Fired[] = []
  for (let at = 0; at < 6 && !fired.some((f) => f.step === 6); at += 1) fired.push(...await tick(w.db, w.root, stub(CARRIED), undefined, () => pr(), wire))
  expect(fired.find((f) => f.step === 6)).toMatchObject({ outcome: 'pass', spans: ['base:conflict'] })
  expect(plan(w.db, 1).step).toBe(3)
  expect(sent).toEqual([])
  expect(await tick(w.db, w.root, stub(CARRIED), undefined, () => pr(), wire)).toMatchObject([{ step: 3, outcome: 'refuse', spans: ['src/hello.ts'] }])
  expect(plan(w.db, 1)).toMatchObject({ step: 2, state: 'running' })
})

test('a fork -next HEAD lacks is folded onto, never forced', { timeout: 90_000 }, async () => {
  const w = await pushed()
  const src = srcDir(w.root, 1)
  const git = (args: string[]): string => execFileSync('git', args, { cwd: src, encoding: 'utf8' }).trim()
  git(['push', '-q', 'origin', 'widget-12-a1'])
  const stale = git(['-c', 'user.email=cf@caliperforge.dev', '-c', 'user.name=caliperforge', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'stale'])
  git(['push', '-q', 'origin', `${stale}:refs/heads/widget-12-a1-next`])
  const sent: string[] = []
  const log = watched(sent, w.root, 1)
  const wire = { ...log, send: (dir: string, ref: string) => {
    log.send(dir, ref)
    execFileSync('git', ['push', '-q', 'origin', ref], { cwd: dir })
  } }
  rewind(w.db, 1, 4)
  writeFileSync(join(src, 'src/hello.ts'), 'export const hello = (): string => "hi"\n')
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, () => pr(), wire)
  expect(sent).toEqual([`send src ${tip(w.root, 1)}:refs/heads/widget-12-a1-next`, 'rehearse caliperforge/widget widget-12-a1-next'])
  git(['merge-base', '--is-ancestor', stale, 'HEAD'])
  approveCard(w.db, w.root, 'plan', 1, 'ceo')
  advance(w.db, plan(w.db, 1), 8)
  const head = git(['rev-parse', 'HEAD'])
  published(w, wire)
  expect(git(['rev-parse', 'HEAD'])).toBe(head)
  expect(sent.slice(2)).toEqual(['send src widget-12-a1', 'unrehearse caliperforge/widget widget-12-a1-next'])
  expect(sent.filter((l) => l.includes('--force') || l.includes('+refs'))).toEqual([])
})

/** `ticks` ticks, with `src/hello.ts` saying `said` from the review on, so senior passes the bytes ready reads. */
async function round(w: World, wire: Wire, said: string, ticks: number): Promise<void> {
  for (let at = 0; at < ticks; at += 1) {
    if (at === ticks - 3) writeFileSync(join(srcDir(w.root, 1), 'src/hello.ts'), `export const hello = (): string => "${said}"\n`)
    await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  }
}

test('D1 D2 D3 pre-pr rounds move -next; push sends the branch', async () => {
  const w = world()
  approve(w.db, w.target)
  const src = srcDir(w.root, 1)
  const git = (args: string[]): string => execFileSync('git', args, { cwd: src, encoding: 'utf8' }).trim()
  const sent: string[] = []
  const log = watched(sent, w.root, 1)
  const wire = { ...log, send: (dir: string, ref: string) => {
    log.send(dir, ref)
    execFileSync('git', ['push', '-q', 'origin', ref], { cwd: dir })
  } }
  await round(w, wire, 'hey', 7)
  expect(plan(w.db, 1).step).toBe(7)
  const first = git(['rev-parse', 'HEAD'])
  rewind(w.db, 1, 4)
  await round(w, wire, 'hi', 3)
  expect(plan(w.db, 1).step).toBe(7)
  git(['merge-base', '--is-ancestor', first, 'HEAD'])
  expect(git(['rev-parse', 'HEAD'])).not.toBe(first)
  expect(git(['ls-remote', 'origin', 'refs/heads/widget-12-a1-next']).split('\t')[0]).toBe(tip(w.root, 1))
  expect(git(['ls-remote', 'origin', 'refs/heads/widget-12-a1'])).toBe('')
  const tips = get(w.root, 1, 'next.tips').trim().split('\n').map((l) => l.slice(0, 40))
  expect(new Set(sent.filter((l) => l.startsWith('send ')))).toEqual(new Set(tips.map((t) => `send src ${t}:refs/heads/widget-12-a1-next`)))
  expect(tips.map((t) => JSON.parse(git(['show', `${t}:greptile.json`])) as unknown)).toEqual(tips.map(() => QUIET))
  tips.reduce((older, newer) => { git(['merge-base', '--is-ancestor', older, newer]); return newer })
  expect(git(['ls-tree', '-r', 'widget-12-a1', 'greptile.json'])).toBe('')
  expect(git(['log', '--format=%H', 'widget-12-a1']).split('\n').filter((h) => tips.includes(h))).toEqual([])
  const held = (): string => next(w.root, plan(w.db, 1), 'acme/widget', wire).tip
  expect([held(), held()]).toEqual([tip(w.root, 1), tip(w.root, 1)])
  approveCard(w.db, w.root, 'plan', 1, 'ceo')
  advance(w.db, plan(w.db, 1), 8)
  const before = sent.length
  published(w, wire)
  expect(sent.slice(before)).toEqual(['send src widget-12-a1', 'unrehearse caliperforge/widget widget-12-a1-next',
    'open acme/widget caliperforge:widget-12-a1'])
})

/** The checkout signs through `gpg`, and HEAD is amended to a head no tip carries yet. */
function signer(w: World, gpg: string): (args: string[]) => string {
  const src = srcDir(w.root, 1)
  const git = (args: string[]): string => execFileSync('git', args, { cwd: src, encoding: 'utf8' }).trim()
  const program = join(w.root, 'gpg.sh')
  writeFileSync(program, `#!/bin/sh\ncat >/dev/null\n${gpg}\n`, { mode: 0o755 })
  git(['config', 'commit.gpgsign', 'true'])
  git(['config', 'gpg.program', program])
  writeFileSync(join(src, 'src/hello.ts'), 'export const hello = (): string => "signed"\n')
  git(['-c', 'commit.gpgsign=false', '-c', 'user.email=cf@caliperforge.dev', '-c', 'user.name=caliperforge',
    'commit', '-qa', '--amend', '--no-edit'])
  return git
}

test('D1 a -next tip is signed where the checkout signs', async () => {
  const w = await atBatch()
  const git = signer(w, String.raw`printf '\n[GNUPG:] SIG_CREATED \n' >&2
printf -- '-----BEGIN PGP SIGNATURE-----\n\nc2ln\n-----END PGP SIGNATURE-----\n'`)
  const { tip: signed } = next(w.root, plan(w.db, 1), 'acme/widget', watched([], w.root, 1))
  expect(get(w.root, 1, 'next.tips')).toContain(`${signed} ${git(['rev-parse', 'HEAD'])}\n`)
  expect(git(['cat-file', 'commit', signed])).toMatch(/^gpgsig /m)
  expect(JSON.parse(git(['show', `${signed}:greptile.json`])) as unknown).toEqual(QUIET)
})

test('D4 a signature that fails sends no unsigned tip', async () => {
  const w = await atBatch()
  signer(w, 'exit 1')
  const tips = get(w.root, 1, 'next.tips')
  const sent: string[] = []
  expect(() => next(w.root, plan(w.db, 1), 'acme/widget', watched(sent, w.root, 1))).toThrow()
  expect([sent, get(w.root, 1, 'next.tips')]).toEqual([[], tips])
})

async function refollowed(handback: string): Promise<{ w: World; wire: Wire; git: (args: string[]) => string; again: () => void }> {
  const w = world()
  approve(w.db, w.target)
  const src = srcDir(w.root, 1)
  const git = (args: string[]): string => execFileSync('git', args, { cwd: src, encoding: 'utf8' }).trim()
  const log = watched([], w.root, 1)
  const wire = { ...log, send: (dir: string, ref: string) => {
    log.send(dir, ref)
    execFileSync('git', ['push', '-q', 'origin', ref], { cwd: dir })
  } }
  await round(w, wire, 'hey', 7)
  put(w.root, 1, 'step-2.handback.md', handback)
  rewind(w.db, 1, 4)
  await round(w, wire, 'hello', 3)
  return { w, wire, git, again: () => { next(w.root, plan(w.db, 1), 'acme/widget', wire) } }
}

/** Two rounds signed at step 8, then a first push whose `open` throws once, after the fold went out. */
async function folded(): Promise<{ w: World; wire: Wire; git: (args: string[]) => string; approval: number | null }> {
  const { w, wire, git } = await refollowed(CARRIED)
  approveCard(w.db, w.root, 'plan', 1, 'ceo')
  advance(w.db, plan(w.db, 1), 8)
  const approval = signedHead(w.db, 1, headDigest(git(['rev-parse', 'HEAD'])))
  let opens = 0
  const flaky = { ...wire, open: (...args: Parameters<Wire['open']>): string => {
    opens += 1
    if (opens === 1) throw new Error('HTTP 502')
    return wire.open(...args)
  } }
  expect(() => published(w, flaky)).toThrow('HTTP 502')
  return { w, wire: flaky, git, approval }
}

test('D1 the first push sends one commit titled as the pr', async () => {
  const { w, wire, git } = await refollowed(CARRIED)
  approveCard(w.db, w.root, 'plan', 1, 'ceo')
  advance(w.db, plan(w.db, 1), 8)
  const tree = git(['rev-parse', 'HEAD^{tree}'])
  expect(published(w, wire)).toMatchObject({ outcome: 'pass' })
  const sent = git(['ls-remote', 'origin', 'refs/heads/widget-12-a1']).split('\t')[0] ?? ''
  git(['merge-base', '--is-ancestor', 'refs/remotes/upstream/main', sent])
  const log = git(['log', '--format=%B%x00', `refs/remotes/upstream/main..${sent}`]).split('\0').map((m) => m.trim()).filter((m) => m !== '')
  expect(log).toEqual(['hello\n\nadd `hello()`.'])
  expect(git(['rev-parse', `${sent}^{tree}`])).toBe(tree)
})

test('D2 a push resumed after open threw opens on the fold', async () => {
  const { w, wire, git, approval } = await folded()
  const head = git(['rev-parse', 'HEAD'])
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'pass', note: `pushed widget-12-a1 as ${URL}` })
  expect(git(['rev-parse', 'HEAD'])).toBe(head)
  expect(git(['ls-remote', 'origin', 'refs/heads/widget-12-a1']).split('\t')[0]).toBe(head)
  expect(newest(w.db, 1)).toMatchObject({ state: 'pushed', approval_id: approval, evidence: URL })
})

test('D3 a head committed after the fold is refused', async () => {
  const { w, wire, git } = await folded()
  const before = git(['ls-remote', 'origin', 'refs/heads/widget-12-a1'])
  writeFileSync(join(srcDir(w.root, 1), 'src/hello.ts'), 'export const hello = (): string => "later"\n')
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'later'])
  const sent: string[] = []
  expect(push(w.db, w.root, plan(w.db, 1), { ...wire, send: (...[, ref]: Parameters<Wire['send']>) => void sent.push(ref) }))
    .toMatchObject({ outcome: 'refuse', spans: ['approvals'] })
  expect(sent).toEqual([])
  expect(git(['ls-remote', 'origin', 'refs/heads/widget-12-a1'])).toBe(before)
})

test('D1 D3 D4 follow-up is the summary, no upstream #, kept', async () => {
  const { git, again } = await refollowed('Renamed.\n\n---\nsummary: rename hello for #12\ndone:\n  - id: D1\n---\n')
  const message = git(['log', '-1', '--format=%B'])
  expect(message).toBe('fix: rename hello for')
  expect(message).not.toMatch(/#\d/)
  const head = git(['rev-parse', 'HEAD'])
  again()
  expect(git(['rev-parse', 'HEAD'])).toBe(head)
})

test('D2 a follow-up with no summary says it addresses review', async () => {
  const { git } = await refollowed('Renamed.\n\n---\ndone:\n  - id: D1\n---\n')
  expect(git(['log', '-1', '--format=%B'])).toBe('fix: address review')
})

test('D1 D2 D3 D4 a moved main stays the fold\'s second parent', { timeout: 90_000 }, async () => {
  const w = world()
  approve(w.db, w.target)
  const src = srcDir(w.root, 1)
  const upstream = join(w.root, 'remotes/acme/widget')
  const git = (args: string[], cwd = src): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const refs: string[] = []
  const log = watched([], w.root, 1)
  const wire = { ...log, send: (dir: string, ref: string) => {
    refs.push(ref)
    execFileSync('git', ['push', '-q', 'origin', ref], { cwd: dir })
  } }
  const until = async (step: number): Promise<void> => {
    for (let at = 0; at < 20 && plan(w.db, 1).step !== step; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  }
  await until(6)
  writeFileSync(join(src, 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
  expect(git(['ls-remote', 'origin', 'refs/heads/widget-12-a1-next'])).not.toBe('')
  writeFileSync(join(upstream, 'moved.ts'), 'export const moved = 1\n')
  git(['add', '-A'], upstream)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'main moves on'], upstream)
  const main = git(['rev-parse', 'HEAD'], upstream)
  await until(7)
  expect(plan(w.db, 1).step).toBe(7)
  expect(maybe(w.root, 1, 'base.laps')).toBeNull()
  expect(git(['merge-base', 'HEAD', 'refs/remotes/upstream/main'])).toBe(main)
  expect(git(['rev-parse', 'HEAD^2'])).toBe(main)
  expect(git(['diff', '--name-only', 'refs/remotes/upstream/main...HEAD'])).toBe('src/hello.ts')
  expect(git(['log', '--no-merges', '--format=%s', 'refs/remotes/upstream/main..HEAD'])).not.toContain('main moves on')
  const head = git(['rev-parse', 'HEAD'])
  const shown = git(['ls-remote', 'origin', 'refs/heads/widget-12-a1-next'])
  next(w.root, plan(w.db, 1), 'acme/widget', wire)
  expect([git(['rev-parse', 'HEAD']), git(['ls-remote', 'origin', 'refs/heads/widget-12-a1-next'])]).toEqual([head, shown])
  expect(refs.filter((r) => r.startsWith('+') || r.includes('--force'))).toEqual([])
})

test('merged-code finding is an escape on the step that owns it', async () => {
  const w = await pushed()
  const merged = pr({
    mergedAt: '2026-09-18T09:00:00Z', mergedBy: { login: 'maintainer' },
    reviews: [{ id: 'r9', author: { login: 'maintainer' }, body: 'this is a scope problem', submittedAt: '2026-09-18T08:00:00Z' }],
  })
  capture(w.db, () => merged)
  expect(dispositionsOf(w.db)[0]).toEqual({ kind: 'escaped', defect_class: 'scope', owner: 'review', evidence: URL })
  expect(classOf('tight.comment on line 3')).toBe('tight.comment')
  expect(classOf('no class named here')).toBe('correctness')
})

test('a pr read that throws leaves a swallowed event, no signal', async () => {
  const w = await pushed()
  expect(capture(w.db, () => { throw new Error('HTTP 502\nbody') })).toEqual([])
  expect(ofKind(w.db, 'swallowed'))
    .toEqual([{ plan: 1, kind: 'swallowed', actor: 'reachable', outcome: 'pass', message: 'HTTP 502' }])
})

const counted = (view: () => Pr): { read: () => Pr; reads: () => number } => {
  let reads = 0
  return { read: () => { reads += 1; return view() }, reads: () => reads }
}

test('D1 a closed pr is read once across two captures', async () => {
  const w = await pushed()
  const { read, reads } = counted(() => pr({ state: 'CLOSED' }))
  capture(w.db, read)
  capture(w.db, read)
  expect(reads()).toBe(1)
  expect(pointers(w.db, 'gone')).toEqual([URL])
})

test('D2 a not-found pr is gone, not swallowed, and read once', async () => {
  const w = await pushed()
  const { read, reads } = counted(() => { throw new Error('GraphQL: Could not resolve to a PullRequest with the number of 7.\nbody') })
  capture(w.db, read)
  capture(w.db, read)
  expect(reads()).toBe(1)
  expect(ofKind(w.db, 'gone', 'swallowed').map((e) => e.kind)).toEqual(['gone'])
})

test('D3 a merged pr gives its merge once, then is not read', async () => {
  const w = await pushed()
  const { read, reads } = counted(() => pr({ state: 'MERGED', mergedAt: '2026-09-18T09:00:00Z', mergedBy: { login: 'maintainer' } }))
  expect(capture(w.db, read).map((s) => s.kind)).toEqual(['merge'])
  expect(capture(w.db, read)).toEqual([])
  expect(reads()).toBe(1)
})

const FORKED = pr({
  number: 3, url: 'https://github.com/caliperforge/widget/pull/3',
  comments: [{ id: 'c3', author: { login: 'maintainer' }, body: 'why this?', createdAt: '2026-09-17T10:00:00Z' }],
  reviews: [{ id: 'g3', author: { login: 'greptile-apps[bot]' }, body: `Confidence Score: 4/5\n\n${REVIEWED}`, submittedAt: '2026-09-17T11:00:00Z' }],
  statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE' }],
})

const SECOND = { id: 2, pipe_id: 1, target_id: 1, template: 'pr_path', state: 'running', queued_at: '2026-09-17T00:00:00.000Z', step: 7, retries: 0 } as const

const forked = (repo: string): Pr => (repo === 'caliperforge/widget' ? FORKED : pr())

const INLINE = [
  { id: 11, commit_id: SHA, original_commit_id: SHA, path: 'src/hello.ts', line: 1, original_line: 1, body: 'a mint change is lost', user: { login: 'greptile-apps[bot]' } },
  { id: 12, commit_id: SHA, original_commit_id: SHA, path: 'src/hello.ts', line: 2, original_line: 2, body: 'rename it', user: { login: 'maintainer' } },
  { id: 13, commit_id: 'b'.repeat(40), original_commit_id: 'b'.repeat(40), path:'src/hello.ts', line: 3, original_line: 3, body: 'old', user: { login: 'greptile-apps[bot]' } },
]

const listing = (heads: string[]) => (args: string[]): unknown => {
  if (args[0] === 'api') return INLINE
  const head = args[args.indexOf('--head') + 1] ?? ''
  heads.push(head)
  return head === 'widget-12-a1-next' ? [{ number: 3 }] : []
}

test('only the rehearsal bot review is kept; it takes no escape', async () => {
  const w = await pushed()
  expect(capture(w.db, forked, w.root, listing([]))).toEqual([])
  expect(others(w.db, SEEDED).map((s) => ({ repo: s.repo, pr: s.pr, kind: s.kind, score: s.score, head: s.head, plan: s.plan })))
    .toEqual([{ repo: 'caliperforge/widget', pr: 3, kind: 'bot_review', score: 4, head: SHA, plan: 1 }])
  capture(w.db, () => pr({ mergedAt: '2026-09-18T09:00:00Z', mergedBy: { login: 'maintainer' } }))
  expect(dispositionsOf(w.db)).toEqual([])
})

test('D5 a rehearsal review at -next is stored at its plan HEAD', async () => {
  const w = await pushed()
  const head = headOf(w.root, 1).sha
  put(w.root, 1, 'next.tips', `${SHA} ${head}\n`)
  capture(w.db, forked, w.root, listing([]))
  expect(others(w.db, SEEDED).map((s) => ({ head: s.head }))).toEqual([{ head }])
  expect(graded(w.db, 1, head)).toMatchObject({ external_id: `g3@${SHA}`, score: 4 })
})

test('D3 one summary comment at two reviewed heads is two rows', async () => {
  const w = await pushed()
  const later = 'c'.repeat(40)
  const moved = pr({ ...FORKED, reviews: FORKED.reviews.map((r) => ({ ...r, body: r.body.replace(SHA, later) })) })
  capture(w.db, forked, w.root, listing([]))
  capture(w.db, (repo) => (repo === 'caliperforge/widget' ? moved : pr()), w.root, listing([]))
  capture(w.db, forked, w.root, listing([]))
  expect(others(w.db, SEEDED).map((s) => s.external_id)).toEqual([`g3@${SHA}`, `g3@${later}`])
})

test('D1 rehearsal inline findings land under the plan HEAD', async () => {
  const w = await pushed()
  const head = headOf(w.root, 1).sha
  put(w.root, 1, 'next.tips', `${SHA} ${head}\n`)
  capture(w.db, forked, w.root, listing([]))
  expect(maybe(w.root, 1, `findings-${head}.md`)).toBe('- G11 src/hello.ts:1 a mint change is lost\n')
})

test('a plan with no checkout is asked about no rehearsal', async () => {
  const w = await pushed()
  putPlan(w.db, SECOND)
  const heads: string[] = []
  capture(w.db, forked, w.root, listing(heads))
  expect(heads).toEqual(['widget-12-a1-next'])
})

test('an unreadable pr does not stop the pipes behind it', async () => {
  const w = await pushed()
  expect(capture(w.db, () => { throw new Error('gh: could not resolve host') })).toEqual([])
  expect(capture(w.db, () => pr({ comments: [{ id: 'c1', author: { login: 'maintainer' }, body: 'hi', createdAt: '2026-09-17T10:00:00Z' }] })))
    .toHaveLength(1)
})

test('a vague bot finding does not take a named one\'s slot', async () => {
  const w = await pushed()
  const merged = pr({
    mergedAt: '2026-09-18T09:00:00Z', mergedBy: { login: 'maintainer' },
    reviews: [
      { id: 'r1', author: { login: 'greptile[bot]' }, body: `looks fine 4/5\n\n${REVIEWED}`, submittedAt: '2026-09-18T07:00:00Z' },
      { id: 'r2', author: { login: 'maintainer' }, body: 'this is a scope problem', submittedAt: '2026-09-18T08:00:00Z' },
    ],
  })
  capture(w.db, () => merged)
  expect(dispositionsOf(w.db).map((d) => d.defect_class)).toEqual(['scope'])
})

test('an approval that cannot settle its row records nothing', async () => {
  const w = await atBatch()
  const path = `${w.root}/one.md`
  writeFileSync(path, 'RULING batch.card = change_text_and_marks\n')
  close(w.db, path, () => null)
  const id = Number(openProposals(w.db)[0]?.id)
  expect(() => approveCard(w.db, w.root, 'proposal', id, 'ceo')).toThrow(/names no issue/)
  expect(approvalsOf(w.db, 'proposal')).toEqual([])
  expect(openProposals(w.db)).toHaveLength(1)
})

test('D3 signing a plan logs one signoff event with who signed', async () => {
  const w = await atBatch()
  refuseCard(w.db, w.root, 'plan', 1, 'not_yet', 'ceo')
  approveCard(w.db, w.root, 'plan', 1, 'coo')
  expect(eventsOf(w.db, 1, 'signoff')).toEqual([
    { actor: 'ceo', outcome: 'refuse', message: 'not_yet' },
    { actor: 'coo', outcome: 'pass', message: headDigest(headOf(w.root, 1).sha).slice(0, 12) },
  ])
  expect(approvalsOf(w.db, 'plan')).toEqual([{ decision: 'refused', reason: 'not_yet' }, { decision: 'approved', reason: null }])
})

test('a ready plan with no checkout stays listed, unsignable', async () => {
  const w = await atBatch()
  putPlan(w.db, SECOND)
  const blind = batch(w.db, w.root).find((c) => c.id === 2)
  expect(blind).toMatchObject({ kind: 'plan', digest: '', marks: [{ name: 'bytes on the branch', ok: false }] })
  expect(() => approveCard(w.db, w.root, 'plan', 2, 'ceo')).toThrow(/no bytes on its branch/)
  expect(eventsOf(w.db, 2, 'signoff')).toEqual([])
  expect(() => headOf(w.root, 2)).toThrow(/has no checkout/)
  expect(push(w.db, w.root, plan(w.db, 2), watched([], w.root, 2))).toMatchObject({ outcome: 'refuse' })
})

test('a signal starts the plan the map says it starts', async () => {
  const w = await pushed()
  const bot = (score: number): SignalRow => signal(w.db, 'bot_review', 'greptile[bot]', score)
  expect(started(w.db, bot(5))).toBeNull()
  expect(started(w.db, bot(4))).toMatchObject({ template: 'pr_path', plan: 1, step: 4 })
  expect(plan(w.db, 1)).toMatchObject({ step: 4, state: 'running' })
  expect(started(w.db, signal(w.db, 'ci_red', 'ci', null))).toMatchObject({ template: 'pr_path', step: 2 })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, state: 'running' })
  const comms = started(w.db, signal(w.db, 'merge', 'maintainer', null))
  expect(comms).toMatchObject({ template: 'comms', step: 0 })
  expect(plan(w.db, Number(comms?.plan))).toMatchObject({ template: 'comms', state: 'queued' })
  expect(ofKind(w.db, 'filed').map((e) => ({ plan: e.plan, actor: e.actor })))
    .toEqual([{ plan: comms?.plan, actor: 'merge signal' }])
  expect(pipeNamed(w.db, 'comms')?.enabled).toBe(1)
})

test('an outside merge signal replayed files one ship-post plan', async () => {
  const w = await pushed()
  const merge = signal(w.db, 'merge', 'maintainer', null)
  expect(started(w.db, merge)).toMatchObject({ template: 'comms' })
  expect(started(w.db, merge)).toBeNull()
  expect(titles(w.db, 'comms')).toEqual(['ship post acme/widget#7'])
  expect(ofKind(w.db, 'filed').map((e) => e.message)).toEqual(['acme/widget#7'])
})

test('a merge signal on an internal plan files nothing', () => {
  const w = world()
  internalPlan(w.db, w.root, 2)
  const merge = record(w.db, { repo: 'acme/widget', pr: 7, kind: 'merge', author: 'maintainer', at: new Date().toISOString(),
    external_id: 'merge-7', score: null, plan: 2 })
  expect(merge === null ? 'unrecorded' : started(w.db, merge)).toBeNull()
  expect(titles(w.db, 'comms')).toEqual([])
})

test('answered bot score stops holding', async () => {
  const w = await pushed()
  const build = (at: string): void => void runAt(w.db, 1, 2, 'typescript_specialist', at)
  build('2000-01-01 00:00:00')
  signal(w.db, 'bot_review', 'greptile[bot]', 1)
  expect(unanswered(w.db, 1)).toBeDefined()
  build('2999-01-01 00:00:00')
  expect(unanswered(w.db, 1)).toBeUndefined()
})

test('D5 a fork score leaves unanswered; below 5 upstream holds', async () => {
  const w = await pushed()
  const bot = (repo: string, score: number): void => void record(w.db, {
    repo, pr: 7, kind: 'bot_review', author: 'greptile', at: new Date(Date.now() + 1000).toISOString(), external_id: repo, score, plan: 1,
  })
  bot('caliperforge/widget', 4)
  expect(unanswered(w.db, 1)).toBeUndefined()
  bot('acme/widget', 4)
  expect(unanswered(w.db, 1)).toBeDefined()
})

test('D3 D4 a low upstream score holds only at its own head', async () => {
  const w = await pushed()
  const bot = (head: string | null): void => void record(w.db, {
    repo: 'acme/widget', pr: 7, kind: 'bot_review', author: 'greptile', at: new Date(Date.now() + 1000).toISOString(),
    external_id: String(head), score: 3, plan: 1, head,
  })
  bot('f'.repeat(40))
  expect(unanswered(w.db, 1, SHA)).toBeUndefined()
  expect(unanswered(w.db, 1, 'f'.repeat(40))).toBeDefined()
  expect(unanswered(w.db, 1)).toBeDefined()
  bot(null)
  expect(unanswered(w.db, 1, SHA)).toBeDefined()
})

test('session close writes only proposals; approval makes a row', async () => {
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

  approveCard(w.db, w.root, 'proposal', Number(rows[0]?.id), 'ceo')
  expect(latest(w.db, 'push.digest')).toEqual({ value: 'approval_matches_head_and_the_hook', issue_no: 42 })
  refuseCard(w.db, w.root, 'proposal', Number(rows[1]?.id), 'not_now', 'ceo')
  expect(openProposals(w.db).map((r) => r.class)).toEqual(['ordering', 'world_fact', 'measurement'])
  expect(approvalsOf(w.db, 'proposal')).toEqual([{ decision: 'approved', reason: null }, { decision: 'refused', reason: 'not_now' }])
  expect(w.db.prepare("SELECT plan, actor, outcome, pointer FROM events WHERE kind = 'signoff' ORDER BY id").all()).toEqual([
    { plan: null, actor: 'ceo', outcome: 'pass', pointer: `proposal:${String(rows[0]?.id)}` },
    { plan: null, actor: 'ceo', outcome: 'refuse', pointer: `proposal:${String(rows[1]?.id)}` },
  ])
})

test('a ruled item proposes nothing; pr body under twenty lines', async () => {
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

test('a rewound lap needs a fresh card, not the first approval', async () => {
  const w = await pushed()
  rewind(w.db, 1, 4)
  expect(plan(w.db, 1).head_digest).toBeNull()
  for (let at = 0; at < 3; at += 1) await lap(w)
  expect(plan(w.db, 1).step).toBe(7)
  expect(deliverablesOf(w.db, 1).map((d) => d.state)).toEqual(['built', 'pushed', 'ready'])
  expect(() => { advance(w.db, plan(w.db, 1), 8) }).toThrow(/no ceo approval row/)
  expect(await lap(w)).toEqual([])
  expect(batch(w.db, w.root).map((c) => c.id)).toEqual([1])
  expect(approvedPlan(w.db, plan(w.db, 1))).toBe(false)

  approveCard(w.db, w.root, 'plan', 1, 'ceo')
  expect(approvedPlan(w.db, plan(w.db, 1))).toBe(true)
  expect(approvalsOf(w.db, 'plan')).toHaveLength(2)
  expect(deliverablesOf(w.db, 1).at(-1)?.state).toBe('approved')
  advance(w.db, plan(w.db, 1), 8)
  expect(plan(w.db, 1).step).toBe(8)
})

test('an approved item said again later changes nothing', async () => {
  const w = await atBatch()
  const first = `${w.root}/first.md`
  writeFileSync(first, 'WORK batch.card = show_the_change_and_the_marks\n')
  const made = close(w.db, first, () => 42)
  approveCard(w.db, w.root, 'proposal', Number(made[0]), 'ceo')
  const again = `${w.root}/again-later.md`
  writeFileSync(again, '\n\nWORK batch.card = show_the_change_and_the_marks\n')
  expect(close(w.db, again, () => 42)).toEqual([])
  expect(bySubject(w.db, 'batch.card')).toMatchObject({ state: 'approved', evidence: `${first}:1` })
  expect(openProposals(w.db)).toHaveLength(0)
})

test('review then merge on a later tick is still one escape', async () => {
  const w = await pushed()
  const review = { id: 'r9', author: { login: 'maintainer' }, body: 'this is a scope problem', submittedAt: '2026-09-18T08:00:00Z' }
  capture(w.db, () => pr({ reviews: [review] }))
  expect(dispositionsOf(w.db)).toEqual([])
  capture(w.db, () => pr({ reviews: [review], mergedAt: '2026-09-19T09:00:00Z', mergedBy: { login: 'maintainer' } }))
  expect(dispositionsOf(w.db).map(({ kind, defect_class, owner }) => ({ kind, defect_class, owner })))
    .toEqual([{ kind: 'escaped', defect_class: 'scope', owner: 'review' }])
})

async function pushed(): Promise<World> {
  const w = await atBatch()
  approveCard(w.db, w.root, 'plan', 1, 'ceo')
  published(w, watched([], w.root, 1))
  return w
}

function published(w: World, wire: Wire): Outcome {
  push(w.db, w.root, plan(w.db, 1), wire)
  approvePublish(w.db, w.root, 1, 'ceo')
  return push(w.db, w.root, plan(w.db, 1), wire)
}

function signal(db: Db, kind: SignalRow['kind'], author: string, score: number | null): SignalRow {
  const written = record(db, {
    repo: 'acme/widget', pr: 7, kind, author, at: new Date().toISOString(), external_id: `${kind}-${String(score)}-${author}`, score, plan: 1,
  })
  if (written === null) throw new Error(`signal ${kind} by ${author} was already recorded`)
  return written
}
