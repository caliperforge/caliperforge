import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Issue, Read } from '../gh.ts'
import { foreign, implemented } from '../gh.ts'
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
 * The nine pull requests github returns for `--search '#284'` on solana-foundation/pay-kit,
 * measured 2026-09-17. Eight are ours. The ninth is a stranger's; it surfaces in the search on a
 * comment *of ours* that cites #284, while the pull request's own text names #226 and #219.
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

it('counts one foreign pull request among the nine referencing pay-kit#284', () => {
  expect(REFERENCES).toHaveLength(9)
  expect(foreign('solana-foundation/pay-kit', 284, reader({ list: REFERENCES })).map((p) => p.number)).toEqual([228])
})

it('does not read the one foreign pull request as an implementation: it never names #284 itself', () => {
  expect(implemented('solana-foundation/pay-kit', ISSUE, reader({ list: REFERENCES }))).toBeNull()
})

it('still refuses when a foreign pull request names the issue in its own text', () => {
  const claim = { ...STRANGER, body: 'Supersedes #284 for every SDK.\n' }
  expect(implemented('solana-foundation/pay-kit', ISSUE, reader({ list: [...OURS, claim] })))
    .toBe('open pull request #228 references it')
})

it('does not read #2840 as a reference to #284', () => {
  const near = { ...STRANGER, body: 'follows #2840\n' }
  expect(implemented('solana-foundation/pay-kit', ISSUE, reader({ list: [near] }))).toBeNull()
})

it('reads no implementation when every referencing pull request is headed from our fork', () => {
  expect(implemented('solana-foundation/pay-kit', ISSUE, reader({ list: OURS }))).toBeNull()
})

it('reads a linked closer from our fork as an open loop, not as an implementation', () => {
  const row = { ...ISSUE, closedByPullRequestsReferences: [{ number: 322 }] }
  const read = reader({ 'view:322': { headRepositoryOwner: { login: 'caliperforge' } }, list: [] })
  expect(implemented('solana-foundation/pay-kit', row, read)).toBeNull()
})

it('still reads a linked closer from anyone else as an implementation', () => {
  const row = { ...ISSUE, closedByPullRequestsReferences: [{ number: 277 }] }
  const read = reader({ 'view:277': { headRepositoryOwner: { login: 'solana-foundation' } } })
  expect(implemented('solana-foundation/pay-kit', row, read)).toBe('pull request #277 implements it')
})

/** pay-kit as hand-measured on 2026-09-17: two maintainers, last outsider merge 2026-09-11, p50 46 days. */
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

it('keeps an account with an open pull request of ours off the p50 cold axis', () => {
  const db = fresh(join(root, 'schema'))
  const row = measure(db, 'solana-foundation/pay-kit', '2026-09-17', payKit(true))
  expect(row).toMatchObject({ maintainers: 2, last_outsider_merge: '2026-09-11', open_pr_age_p50_days: 46, open_loop: true, pulse: 'warm' })
  expect(db.prepare('SELECT open_loop, pulse FROM accounts WHERE repo = ?').get(row.repo)).toEqual({ open_loop: 1, pulse: 'warm' })
})

it('still calls the same row cold on the p50 axis with no open loop of ours', () => {
  const db = fresh(join(root, 'schema'))
  expect(measure(db, 'solana-foundation/pay-kit', '2026-09-17', payKit(false)))
    .toMatchObject({ maintainers: 2, last_outsider_merge: '2026-09-11', open_pr_age_p50_days: 46, open_loop: false, pulse: 'cold' })
})

it('leaves the no-outsider-merge-in-21-days axis cold even under an open loop of ours', () => {
  const db = fresh(join(root, 'schema'))
  expect(measure(db, 'solana-foundation/pay-kit', '2026-10-17', payKit(true)))
    .toMatchObject({ open_loop: true, pulse: 'cold' })
})

it('names a ruling that carries kernel issue 23 and the map line for each step-0 trip', () => {
  const db = fresh(join(root, 'schema'))
  expect(db.prepare("SELECT subject, origin_kind, origin_ref, issue_no FROM rulings WHERE origin_ref = 'buildmap-rev6-step0-must-not-trip' ORDER BY subject").all())
    .toEqual([
      { subject: 'queue.cold_pulse', origin_kind: 'ruling', origin_ref: 'buildmap-rev6-step0-must-not-trip', issue_no: 23 },
      { subject: 'queue.implemented', origin_kind: 'ruling', origin_ref: 'buildmap-rev6-step0-must-not-trip', issue_no: 23 },
    ])
})
