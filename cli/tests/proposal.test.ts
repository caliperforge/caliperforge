import { expect, test } from 'vitest'
import type { Db } from '../../store/index.ts'
import { askFor, cites } from '../proposal.ts'
import { MERGED, OPEN, REPO, rows, world } from './proposal-world.ts'

const count = (db: Db, table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

test('D1, D6: a ready target with a merged row gets its scan line and record, and nothing is written', () => {
  const { db, ready, plan } = world()
  const before = ['plans', 'targets', 'records'].map((t) => count(db, t))
  const p = String(plan)
  expect(askFor(db, ready)).toBe('# Target\n\n' +
    `${REPO}#1\tmerger maintainer\topened 2026-09-01\tactive 2026-09-20\tno open pr\t3 lines\thttps://github.com/acme/widget/issues/1\n\n` +
    `# Record\n\n${REPO}\topen 1\n#3\tMERGED\tplan ${p}\t-\t${MERGED}\n#4\tOPEN\tplan ${p}\t-\t${OPEN}\n`)
  expect(['plans', 'targets', 'records'].map((t) => count(db, t))).toEqual(before)
})

test('D2: a queued target and a missing id are not ready', () => {
  const { db, queued } = world()
  expect(() => askFor(db, queued)).toThrow(`target ${String(queued)} is not ready`)
  expect(() => askFor(db, 999)).toThrow('target 999 is not ready')
})

test('D3: a repo with only open rows, or none, has no merged pull request on record', () => {
  const { db, ready } = world()
  db.prepare('DELETE FROM records WHERE pr = 3').run()
  expect(() => askFor(db, ready)).toThrow(`${REPO} has no merged pull request on record`)
  db.prepare('DELETE FROM records').run()
  expect(() => askFor(db, ready)).toThrow(`${REPO} has no merged pull request on record`)
})

test('D4: a card whose Shape line cites the merged row returns its url', () => {
  const { db } = world()
  expect(cites(`# Card\n**Shape:** like ${MERGED} but smaller\n`, rows(db))).toBe(MERGED)
})

test('D5: an open url, a foreign url and a missing Shape line are refused', () => {
  const { db } = world()
  const refused = 'the card cites no merged pull request on record'
  expect(() => cites(`**Shape:** ${OPEN}`, rows(db))).toThrow(refused)
  expect(() => cites('**Shape:** https://github.com/other/repo/pull/3', rows(db))).toThrow(refused)
  expect(() => cites(`# Card\nsee ${MERGED}\n`, rows(db))).toThrow(refused)
})
