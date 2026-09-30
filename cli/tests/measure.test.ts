import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { measure, render, type Read } from '../measure.ts'

const schema = join(import.meta.dirname, '../../schema')

const TODAY = '2026-09-17'

interface Canned { merged?: unknown[]; open?: unknown[]; searches?: string[] }

/**
 * The three `gh` shapes `pulseOf()` parses, in the order it asks for them. Every
 * search is logged so a test can count the requests `elsewhere()` actually makes.
 */
function canned(rows: Canned, log: string[] = []): Read {
  return (args) => {
    if (args[0] === 'search') { log.push(String(args[3])); return [{ repository: { nameWithOwner: 'acme/other' } }] }
    if (args.includes('createdAt,headRepositoryOwner')) return rows.open ?? []
    return rows.merged ?? []
  }
}

const merge = (author: string | null, by: string, at: string | null): unknown =>
  ({ author: author === null ? null : { login: author }, mergedBy: { login: by }, mergedAt: at })

test('outsider merged in window by a door: warm, row passes CHECK', () => {
  const db = fresh(schema)
  const row = measure(db, 'acme/widget', TODAY, canned({
    merged: [merge('outsider', 'maintainer', '2026-09-10T00:00:00Z'), merge('maintainer', 'maintainer', '2026-09-01T00:00:00Z')],
    open: [{ createdAt: '2026-09-16T00:00:00Z', headRepositoryOwner: null },
      { createdAt: '2026-09-15T00:00:00Z', headRepositoryOwner: null }],
  }))
  expect(row).toMatchObject({ pulse: 'warm', maintainers: 1, doors: 1, last_outsider_merge: '2026-09-10',
    open_pr_age_p50_days: 1, cross_repo_activity: 1 })
  expect(db.prepare('SELECT pulse, measured_at FROM accounts WHERE repo = ?').get('acme/widget'))
    .toEqual({ pulse: 'warm', measured_at: TODAY })
  expect(render(row).endsWith('https://github.com/acme/widget/pulse\n')).toBe(true)
})

test('a repo merging no outsider is cold, whatever else it does', () => {
  const db = fresh(schema)
  expect(measure(db, 'acme/widget', TODAY, canned({ merged: [merge('maintainer', 'maintainer', '2026-09-16T00:00:00Z')] })))
    .toMatchObject({ pulse: 'cold', last_outsider_merge: null, maintainers: 1, doors: 0 })
})

test('outsider merge or p50 open pr over 21 days old is cold', () => {
  const db = fresh(schema)
  expect(measure(db, 'acme/widget', TODAY, canned({ merged: [merge('outsider', 'maintainer', '2026-08-01T00:00:00Z')] })))
    .toMatchObject({ pulse: 'cold', last_outsider_merge: '2026-08-01' })
  expect(measure(db, 'acme/other', TODAY, canned({
    merged: [merge('outsider', 'maintainer', '2026-09-16T00:00:00Z')],
    open: [{ createdAt: '2026-01-01T00:00:00Z', headRepositoryOwner: null }],
  }))).toMatchObject({ pulse: 'cold', open_pr_age_p50_days: 259 })
})

test('same-day re-measure rewrites its row; elsewhere() caps at 30', () => {
  const db = fresh(schema)
  const log: string[] = []
  const many = [...Array(40).keys()].map((n) => merge('outsider', `door${String(n)}`, '2026-09-16T00:00:00Z'))
  measure(db, 'acme/widget', TODAY, canned({ merged: many }, log))
  expect(log).toHaveLength(30)
  measure(db, 'acme/widget', TODAY, canned({ merged: [merge('outsider', 'maintainer', '2026-09-16T00:00:00Z')] }))
  expect(db.prepare('SELECT count(*) AS n, max(maintainers) AS m FROM accounts WHERE repo = ?').get('acme/widget'))
    .toEqual({ n: 1, m: 1 })
})
