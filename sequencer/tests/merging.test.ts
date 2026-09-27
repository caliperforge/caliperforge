import { expect, test } from 'vitest'
import { open } from '../../store/index.ts'
import { merging } from '../merging.ts'

const NOW = new Date('2026-09-27T12:00:00Z')

const TARGET = { repo: 'acme/widget', issue_no: 12, named_merger: 'maintainer' }

const ago = (days: number): string => new Date(NOW.getTime() - days * 86400000).toISOString()

const pr = (author: string | null, merger: string, opened: number, merged: number | null) => ({
  author: author === null ? null : { login: author },
  mergedBy: { login: merger },
  createdAt: ago(opened),
  mergedAt: merged === null ? null : ago(merged),
})

const MISSED = [
  pr('lead', 'owner', 12, 10),
  pr('owner', 'lead', 4, 3),
  pr(null, 'owner', 6, 5),
  pr('stranger', 'owner', 8, null),
  pr('late', 'owner', 33, 31),
]

const row = (prs: unknown[]) => merging(TARGET.repo, () => prs, NOW)(open(':memory:'), '', 1, TARGET)

test('D1 no outsider merge in the 30 days before now is a flag', () => {
  expect(row([])).toEqual({ check: 'outside merges', ok: false, says: 'none in 30 days' })
})

test('D2 two outsider merges give their count and median days to merge', () => {
  expect(row([pr('ann', 'owner', 3, 2), pr('bo', 'owner', 10, 5)]))
    .toEqual({ check: 'outside merges', ok: true, says: '2 in 30 days, median 1d to merge' })
})

test('D3 a merger\'s own pr, a null author, an unmerged pr and a merge 31 days back do not count', () => {
  expect(row(MISSED)).toMatchObject({ ok: false, says: 'none in 30 days' })
  expect(row([...MISSED, pr('ann', 'owner', 3, 2)])).toMatchObject({ ok: true, says: '1 in 30 days, median 1d to merge' })
})
