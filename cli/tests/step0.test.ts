import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { stepped } from '../../sequencer/settle.ts'
import { measure as stepZero } from '../../sequencer/steps.ts'
import { CARRIED, plan, stub, world } from '../../sequencer/tests/world.ts'
import { eventsOf } from '../../store/events.ts'
import { take } from '../../store/leases.ts'
import { rewind, waiting } from '../../store/plans.ts'
import type { Issue, Read } from '../gh.ts'
import { foreign, implemented, WINDOW } from '../gh.ts'
import { measure } from '../measure.ts'

const root = join(import.meta.dirname, '../..')

const ISSUE: Issue = {
  number: 284,
  title: 'mpp: track the RFC 3339 `expires` divergences',
  body: '- D1 the vectors land\n',
  state: 'OPEN',
  assignees: [],
  comments: [],
  closedByPullRequestsReferences: [],
}

/**
 * The nine pull requests github returns for a search on the issue number on solana-foundation/pay-kit.
 * Eight are ours. The ninth is a stranger's; it surfaces in the search on a
 * comment *of ours* that cites the issue, while the pull request's own text names two other issues.
 */
const OURS = [320, 321, 317, 315, 318, 322].map((number) => ({
  number,
  title: 'fix(mpp): validate expires as RFC 3339',
  body: 'Closes #284\n',
  headRepositoryOwner: { login: 'caliperforge' },
}))

const OURS_UNLINKED = [313, 282].map((number) => ({
  number,
  title: 'test(mpp): RFC 3339 expires conformance vectors',
  body: 'Stacked on the harness work.\n',
  headRepositoryOwner: { login: 'caliperforge' },
}))

const STRANGER = {
  number: 228,
  title: 'fix(python): harden protocol validation',
  body: '- split the Python security work from #226 into a Python-owned PR\n\nTargets #219 as requested.\n',
  headRepositoryOwner: { login: 'solana-foundation' },
}

const REFERENCES = [...OURS, ...OURS_UNLINKED, STRANGER]

function reader(map: Record<string, unknown>): Read {
  return (args) => {
    const key = args.includes('view') ? `view:${String(args[2])}` : 'list'
    if (!(key in map)) throw new Error(`the fake gh was not given ${key}`)
    return map[key]
  }
}

it('counts one foreign PR among nine referencing pay-kit#284', () => {
  expect(REFERENCES).toHaveLength(9)
  expect(foreign('solana-foundation/pay-kit', 284, reader({ list: REFERENCES })).map((p) => p.number)).toEqual([228])
})

it('asks a page of referencing PRs, not the uncapped 30 rows', () => {
  let sent: string[] = []
  foreign('solana-foundation/pay-kit', 284, (args) => { sent = args; return [] })
  expect(sent.slice(sent.indexOf('--limit'), sent.indexOf('--limit') + 2)).toEqual(['--limit', String(WINDOW)])
})

it('the foreign PR is no implementation: it never names #284', () => {
  expect(implemented('solana-foundation/pay-kit', ISSUE, reader({ list: REFERENCES }))).toBeNull()
})

it('still refuses when a foreign PR names the issue in its text', () => {
  const claim = { ...STRANGER, body: 'Supersedes #284 for every SDK.\n' }
  expect(implemented('solana-foundation/pay-kit', ISSUE, reader({ list: [...OURS, claim] })))
    .toBe('open pull request #228 references it')
})

it('does not read #2840 as a reference to #284', () => {
  const near = { ...STRANGER, body: 'follows #2840\n' }
  expect(implemented('solana-foundation/pay-kit', ISSUE, reader({ list: [near] }))).toBeNull()
})

it('no implementation when every referencing PR is from our fork', () => {
  expect(implemented('solana-foundation/pay-kit', ISSUE, reader({ list: OURS }))).toBeNull()
})

it('reads a linked closer from our fork as an open loop only', () => {
  const row = { ...ISSUE, closedByPullRequestsReferences: [{ number: 322 }] }
  const read = reader({ 'view:322': { headRepositoryOwner: { login: 'caliperforge' } }, list: [] })
  expect(implemented('solana-foundation/pay-kit', row, read)).toBeNull()
})

it('reads a linked closer from anyone else as an implementation', () => {
  const row = { ...ISSUE, closedByPullRequestsReferences: [{ number: 277 }] }
  const read = reader({ 'view:277': { headRepositoryOwner: { login: 'solana-foundation' } } })
  expect(implemented('solana-foundation/pay-kit', row, read)).toBe('pull request #277 implements it')
})

/** pay-kit as hand-measured: two maintainers, last outsider merge six days before, p50 46 days. */
function payKit(mine: boolean): Read {
  const merged = [
    { author: { login: 'a-maintainer' }, mergedBy: { login: 'a-maintainer' }, mergedAt: '2026-09-15T00:00:00Z' },
    { author: { login: 'another' }, mergedBy: { login: 'another' }, mergedAt: '2026-09-14T00:00:00Z' },
    { author: { login: 'an-outsider' }, mergedBy: { login: 'a-maintainer' }, mergedAt: '2026-09-11T00:00:00Z' },
  ]
  const open = [
    { createdAt: '2026-08-02T00:00:00Z', headRepositoryOwner: { login: 'somebody' } },
    { createdAt: '2026-08-02T00:00:00Z', headRepositoryOwner: { login: 'somebody-else' } },
    { createdAt: '2026-08-02T00:00:00Z', headRepositoryOwner: { login: 'a-third' } },
  ]
  return (args) => {
    if (args[0] === 'search') return []
    if (args.includes('merged') && args[0] === 'pr') return merged
    return mine ? [...open, { createdAt: '2026-09-16T00:00:00Z', headRepositoryOwner: { login: 'caliperforge' } }] : open
  }
}

it('keeps an account with our open PR off the p50 cold axis', () => {
  const db = fresh(join(root, 'schema'))
  const row = measure(db, 'solana-foundation/pay-kit', '2026-09-17', payKit(true))
  expect(row).toMatchObject({ maintainers: 2, last_outsider_merge: '2026-09-11', open_pr_age_p50_days: 46, open_loop: true, pulse: 'warm' })
  expect(db.prepare('SELECT open_loop, pulse FROM accounts WHERE repo = ?').get(row.repo)).toEqual({ open_loop: 1, pulse: 'warm' })
})

it('still calls the row cold on p50 with no open loop of ours', () => {
  const db = fresh(join(root, 'schema'))
  expect(measure(db, 'solana-foundation/pay-kit', '2026-09-17', payKit(false)))
    .toMatchObject({ maintainers: 2, last_outsider_merge: '2026-09-11', open_pr_age_p50_days: 46, open_loop: false, pulse: 'cold' })
})

it('21-day outsider-merge axis stays cold under our open loop', () => {
  const db = fresh(join(root, 'schema'))
  expect(measure(db, 'solana-foundation/pay-kit', '2026-10-17', payKit(true)))
    .toMatchObject({ open_loop: true, pulse: 'cold' })
})

it('step-0 trip ruling carries kernel issue 23 and the map line', () => {
  const db = fresh(join(root, 'schema'))
  expect(db.prepare("SELECT subject, origin_kind, origin_ref, issue_no FROM rulings WHERE origin_ref = 'buildmap-rev6-step0-must-not-trip' ORDER BY subject").all())
    .toEqual([
      { subject: 'queue.cold_pulse', origin_kind: 'ruling', origin_ref: 'buildmap-rev6-step0-must-not-trip', issue_no: 23 },
      { subject: 'queue.implemented', origin_kind: 'ruling', origin_ref: 'buildmap-rev6-step0-must-not-trip', issue_no: 23 },
    ])
})

const WIDGET = 'https://github.com/acme/widget/issues/12'
const DAY = 86400000

function intake(yml: string): ReturnType<typeof world> {
  const w = world()
  mkdirSync(join(w.root, 'profiles/acme'), { recursive: true })
  writeFileSync(join(w.root, 'profiles/acme/widget.yml'), `intake: ${yml}\n`)
  return w
}

/** `find` passes on everything but the `@me` lists, which answer `open` numbered rows and one row per day in `created`. */
function ours(open: number, created: number[] = [], sent: string[][] = []): Read {
  return (args) => {
    if (args.includes('@me')) {
      sent.push(args)
      return args.includes('open') ? [...Array(open).keys()].map((number) => ({ number }))
        : created.map((ago) => ({ createdAt: new Date(Date.now() - ago * DAY).toISOString() }))
    }
    if (args[0] === 'issue') {
      return { number: 12, title: 'hello', body: 'b', state: 'OPEN', url: WIDGET, author: { login: 'keeper' },
        assignees: [], comments: [], closedByPullRequestsReferences: [], projectItems: [] }
    }
    if (args[0] === 'search' || !args.includes('merged')) return []
    return [{ url: 'https://github.com/acme/widget/pull/2', author: { login: 'outsider' }, mergedBy: { login: 'keeper' },
      body: 'b', additions: 1, deletions: 0, files: [{ path: 'src/a.ts' }] }]
  }
}

function rule(w: ReturnType<typeof world>, value: string): void {
  w.db.prepare(`INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no)
    VALUES ('claim.acme/widget#12', ?, 'ruling', 'test', 'ceo', '2026-09-27', 12)`).run(value)
}

const PASS = { outcome: 'pass', note: 'acme/widget#12 warm' }

it('holds a claim_first target at step 0 on target_parked, ready', () => {
  const w = intake('{ claim_first: true }')
  expect(stepZero(w.db, w.root, plan(w.db, 1), ours(0))).toMatchObject({ outcome: 'refuse', held: true,
    note: 'target_parked: claim_first: no ruling claim.acme/widget#12 = confirmed' })
  expect(w.db.prepare('SELECT wait_reason FROM plans WHERE id = 1').pluck().get()).toBe('target_parked')
  expect(w.db.prepare('SELECT state FROM targets WHERE id = 1').pluck().get()).toBe('ready')
})

it('any other ruling holds it; a confirmed one lets step 0 pass', () => {
  const w = intake('{ claim_first: true }')
  rule(w, 'asked')
  expect(stepZero(w.db, w.root, plan(w.db, 1), ours(0))).toMatchObject({ outcome: 'refuse', held: true })
  rule(w, 'confirmed')
  expect(stepZero(w.db, w.root, plan(w.db, 1), ours(0))).toMatchObject(PASS)
})

it('open PRs at max_open_prs hold the target; below it passes', () => {
  const w = intake('{ max_open_prs: 2 }')
  expect(stepZero(w.db, w.root, plan(w.db, 1), ours(2))).toMatchObject({ outcome: 'refuse', held: true,
    note: 'target_parked: max_open_prs: 2 of ours open in acme/widget, cap 2' })
  expect(stepZero(w.db, w.root, plan(w.db, 1), ours(1))).toMatchObject(PASS)
})

it('PRs opened in pace.days at pace.prs hold; older do not count', () => {
  const w = intake('{ pace: { prs: 1, days: 7 } }')
  expect(stepZero(w.db, w.root, plan(w.db, 1), ours(0, [1, 30]))).toMatchObject({ outcome: 'refuse', held: true,
    note: 'target_parked: pace: 1 opened in acme/widget in the last 7 days, cap 1' })
  expect(stepZero(w.db, w.root, plan(w.db, 1), ours(0, [8, 30]))).toMatchObject(PASS)
})

it('a pace park logs once per park and rule text, not per tick', async () => {
  const w = intake('{ pace: { prs: 1, days: 7 } }')
  const lease = take(w.db, 1)
  if (lease === null) throw new Error('plan 1 is leased')
  const tick = (read: Read): Promise<unknown> => stepped(w.db, w.root, w.pipe, plan(w.db, 1), lease, stub(CARRIED), undefined, read)
  const parks = (): string[] => eventsOf(w.db, 1, 'measure').map((e) => e.message).filter((m) => m.startsWith('target_parked:'))
  for (let n = 0; n < 5; n += 1) {
    waiting(w.db, [{ plan: 1, why: null }])
    await tick(ours(0, [1]))
    expect(parks()).toHaveLength(1)
    expect(plan(w.db, 1).wait_reason).toBe('target_parked')
    expect(stepZero(w.db, w.root, plan(w.db, 1), ours(0, [1]))).toMatchObject({ outcome: 'refuse', held: true,
      note: 'target_parked: pace: 1 opened in acme/widget in the last 7 days, cap 1' })
  }
  await tick(ours(0, [1, 2]))
  await tick(ours(0, [1, 2]))
  expect(parks()).toEqual(['target_parked: pace: 1 opened in acme/widget in the last 7 days, cap 1',
    'target_parked: pace: 2 opened in acme/widget in the last 7 days, cap 1'])
  await tick(ours(0, [8, 30]))
  expect(eventsOf(w.db, 1, 'measure').at(-1)).toMatchObject({ outcome: 'pass', message: PASS.note })
  expect(plan(w.db, 1).step).toBe(1)
  rewind(w.db, 1, 0)
  await tick(ours(0, [1]))
  expect(parks()).toHaveLength(3)
})

it('D5: with neither key set, no --author @me read is made', () => {
  const w = intake('{ claim_first: false }')
  const sent: string[][] = []
  expect(stepZero(w.db, w.root, plan(w.db, 1), ours(5, [1], sent))).toMatchObject(PASS)
  expect(sent).toEqual([])
})
