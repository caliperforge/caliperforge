import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Read } from '../../cli/gh.ts'
import type { Db } from '../../store/index.ts'
import { precedentsFor } from '../lookup.ts'
import { distilled, keep, type Precedent, type Source } from '../store.ts'

const root = join(import.meta.dirname, '../..')

const pr = (number: number, files: string[], merged_at = '2026-10-01T00:00:00Z'): Source =>
  ({ repo: 'o/r', number, title: 'T', merged_at, merger: null, files, issues: [] })

const at = (area: string, role: Precedent['role'] = 'maintainer', decision = 'd'): Precedent =>
  ({ area, decision, why: 'w', said_by: 'm', role, source: 'https://github.com/o/r/pull/1#discussion_r1' })

const tree = (paths: string[], truncated = false): Read => (args) => {
  if (args[1] === 'repos/o/r') return { default_branch: 'main' }
  if (args[1] === 'repos/o/r/git/trees/main?recursive=1') return { tree: paths.map((path) => ({ path })), truncated }
  throw new Error(`unread ${args.join(' ')}`)
}

function seeded(...stored: [Source, Precedent[]][]): Db {
  const db = fresh(join(root, 'schema'))
  for (const [source, rows] of stored) {
    keep(db, source, [])
    distilled(db, source, rows, 0)
  }
  return db
}

it('D1 a lookup returns only the record on the looked-up file', () => {
  const db = seeded([pr(1, ['src/a.rs']), [at('src/a.rs')]], [pr(2, ['src/b.rs']), [at('src/b.rs')]])
  expect(precedentsFor(db, 'o/r', ['src/a.rs'], tree(['src/a.rs', 'src/b.rs']))).toEqual([at('src/a.rs')])
})

it('D2 seven matches return the top 5 by role, scope, then date', () => {
  const db = seeded(
    [pr(1, ['src/a.rs']), [at('src/a.rs', 'maintainer', 'mb-old'), at('src/a.rs', 'contributor', 'cb-old'), at('src/a.rs:parse', 'maintainer', 'mf-old')]],
    [pr(2, ['src/a.rs'], '2026-10-05T00:00:00Z'), [at('src/a.rs', 'contributor', 'cb-new'), at('src/a.rs:parse', 'contributor', 'cf-new'),
      at('src/a.rs', 'maintainer', 'mb-new'), at('src/a.rs:parse', 'maintainer', 'mf-new')]])
  expect(precedentsFor(db, 'o/r', ['src/a.rs'], tree(['src/a.rs'])).map((p) => p.decision))
    .toEqual(['mf-new', 'mf-old', 'mb-new', 'mb-old', 'cf-new'])
})

it('D3 a record on a file gone from the tree is left out', () => {
  const db = seeded([pr(1, ['src/a.rs', 'src/gone.rs']), [at('src/gone.rs'), at('src/a.rs')]])
  expect(precedentsFor(db, 'o/r', ['src/a.rs'], tree(['src/a.rs']))).toEqual([at('src/a.rs')])
})

it('D4 a record on another file matches through its PR files', () => {
  const db = seeded([pr(1, ['src/a.rs', 'src/c.rs']), [at('src/c.rs')]])
  expect(precedentsFor(db, 'o/r', ['src/a.rs'], tree(['src/a.rs', 'src/c.rs']))).toEqual([at('src/c.rs')])
})

it('D5 a truncated tree throws', () => {
  const db = seeded([pr(1, ['src/a.rs']), [at('src/a.rs')]])
  expect(() => precedentsFor(db, 'o/r', ['src/a.rs'], tree(['src/a.rs'], true))).toThrow('tree is truncated')
})
