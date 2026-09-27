import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { askFor, cites } from '../proposal.ts'
import type { Row } from '../record.ts'

const schema = join(import.meta.dirname, '../../schema')
const REPO = 'acme/widget'
const MERGED = `https://github.com/${REPO}/pull/3`
const OPEN = `https://github.com/${REPO}/pull/4`

interface World { db: Db; ready: number; queued: number; plan: number }

function world(): World {
  const db = fresh(schema)
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, ?, '2026-09-01', 1, 1, '2026-08-01', 0, 0, 'cold', 'https://github.com/acme/widget/pulse')`).run(REPO)
  const pipe = Number(db.prepare(`INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent)
    VALUES ('scan', 1, '00:00', '23:59', 1)`).run().lastInsertRowid)
  const ready = Number(db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at,
    evidence, issue_opened_at, issue_active_at, open_pr, open_pr_draft, size_lines)
    VALUES (1, ?, 1, 'maintainer', 'ready', '2026-09-01', 'https://github.com/acme/widget/issues/1',
      '2026-09-01', '2026-09-20', NULL, NULL, 3)`).run(REPO).lastInsertRowid)
  const queued = Number(db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, ?, 50, 'maintainer', 'queued', '2026-09-01', 'https://github.com/acme/widget/issues/50')`).run(REPO).lastInsertRowid)
  const plan = Number(db.prepare(`INSERT INTO plans (pipe_id, target_id, template, state, queued_at, step, retries)
    VALUES (?, ?, 'pr_path', 'queued', '2026-09-20T00:00:00.000Z', 0, 0)`).run(pipe, queued).lastInsertRowid)
  const put = db.prepare(`INSERT INTO records (repo, pr, plan, url, state, merged_at, read_at)
    VALUES (?, ?, ?, ?, ?, ?, '2026-09-25T00:00:00Z')`)
  put.run(REPO, 3, plan, MERGED, 'MERGED', '2026-09-24T00:00:00Z')
  put.run(REPO, 4, plan, OPEN, 'OPEN', null)
  return { db, ready, queued, plan }
}

const rows = (db: Db): Row[] => db.prepare('SELECT * FROM records ORDER BY pr').all() as Row[]

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
