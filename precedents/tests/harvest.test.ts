import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { ofKind } from '../../store/events.ts'
import { migrate, open } from '../../store/index.ts'
import { harvest, LIMIT } from '../harvest.ts'
import { source, threads } from '../store.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const fresh = () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  return db
}

const login = (name: string) => ({ login: name })

const said = (who: string, body: string, id = 1) => ({ author: login(who), body, url: `https://github.com/o/r/pull/7#issuecomment-${String(id)}` })

const review = (who: string, body: string, id = 80) => ({ user: login(who), body,
  html_url: `https://github.com/o/r/pull/7#pullrequestreview-${String(id)}` })

const pr = (number: number, over: object = {}) => ({ number, title: `PR ${String(number)}`, mergedAt: `2026-10-0${String(number % 10)}T00:00:00Z`,
  mergedBy: login('boss'), files: [{ path: 'a.ts' }], closingIssuesReferences: [{ number: 3 }], comments: [], ...over })

const line = (body: string, at: number | null, id = 1) => ({ id, commit_id: 'c', original_commit_id: 'c', path: 'a.ts', line: at,
  original_line: null, body, user: login('dev') })

function stub(prs: ReturnType<typeof pr>[], reviews: Record<number, ReturnType<typeof review>[]> = {},
  lines: Record<number, ReturnType<typeof line>[]> = {}, fails: Record<string, number> = {}) {
  const calls: string[][] = []
  const read = (args: string[]): unknown => {
    calls.push(args)
    if (args[0] === 'api') {
      const no = Number(/pulls\/(\d+)\//.exec(args[1] ?? '')?.[1])
      const key = `${String(no)}/${args[1]?.includes('/reviews?') === true ? 'reviews' : 'comments'}`
      if ((fails[key] ?? 0) > 0) {
        fails[key] = (fails[key] ?? 0) - 1
        throw new Error('HTTP 502')
      }
      return (key.endsWith('reviews') ? reviews[no] : lines[no]) ?? []
    }
    if (args.includes('mergedBy')) return [{ mergedBy: login('boss') }]
    const bound = args[args.indexOf('--search') + 1]?.replace('merged:>', '') ?? ''
    return prs.filter((p) => !args.includes('--search') || p.mergedAt > bound)
  }
  return { read, calls }
}

it('D1 a PR with review discussion is stored with its threads', () => {
  const db = fresh()
  const { read } = stub([pr(7, { comments: [said('boss', 'We chose this on purpose', 11), said('dev', '', 12)] })],
    { 7: [review('rev', 'Keep the old name', 80), review('rev', ' ', 81)] }, { 7: [line('nit', 4, 21), line('gone', null, 22)] })
  expect(harvest(db, 'o/r', null, read)).toBe(1)
  expect(source(db, 'o/r', 7)).toEqual({ repo: 'o/r', number: 7, title: 'PR 7', merged_at: '2026-10-07T00:00:00Z', merger: 'boss',
    files: ['a.ts'], issues: [3] })
  expect(threads(db, 'o/r', 7)).toEqual([
    { kind: 'review', author: 'rev', role: 'contributor', text: 'Keep the old name', path: null, line: null,
      url: 'https://github.com/o/r/pull/7#pullrequestreview-80' },
    { kind: 'inline', author: 'dev', role: 'contributor', text: 'nit', path: 'a.ts', line: 4, url: 'https://github.com/o/r/pull/7#discussion_r21' },
    { kind: 'inline', author: 'dev', role: 'contributor', text: 'gone', path: null, line: null, url: 'https://github.com/o/r/pull/7#discussion_r22' },
    { kind: 'comment', author: 'boss', role: 'maintainer', text: 'We chose this on purpose', path: null, line: null,
      url: 'https://github.com/o/r/pull/7#issuecomment-11' },
  ])
})

it('D2 a PR without discussion is skipped; three inline keep it', () => {
  const db = fresh()
  const { read } = stub([pr(7, { comments: [said('dev', 'thanks')] }), pr(9)], { 7: [review('rev', '')] },
    { 7: [line('a', 1), line('b', 2)], 9: [line('a', 1), line('b', 2), line('c', 3)] })
  expect(harvest(db, 'o/r', null, read)).toBe(1)
  expect(source(db, 'o/r', 7)).toBeUndefined()
  expect(source(db, 'o/r', 9)?.number).toBe(9)
})

it('D3 a second run with nothing new reads no PR', () => {
  const db = fresh()
  const { read, calls } = stub([pr(7)], { 7: [review('rev', 'why')] })
  harvest(db, 'o/r', null, read)
  calls.length = 0
  expect(harvest(db, 'o/r', '2026-09-01', read)).toBe(0)
  expect(calls).toEqual([['pr', 'list', '--repo', 'o/r', '--state', 'merged', '--limit', String(LIMIT), '--search',
    'merged:>2026-10-07T00:00:00Z', '--json', 'number,title,mergedAt,mergedBy,files,closingIssuesReferences,comments']])
})

it('D4 an inline read that fails once is retried and stored', () => {
  const db = fresh()
  const { read, calls } = stub([pr(7)], { 7: [review('rev', 'why')] }, {}, { '7/comments': 1 })
  expect(harvest(db, 'o/r', null, read)).toBe(1)
  expect(calls.filter((c) => c[0] === 'api')).toHaveLength(3)
  expect(source(db, 'o/r', 7)?.number).toBe(7)
})

it('D4 an inline read failing twice is logged; the next PR kept', () => {
  const db = fresh()
  const { read } = stub([pr(8), pr(9)], { 8: [review('rev', 'why')], 9: [review('rev', 'why')] }, {}, { '8/comments': 2 })
  expect(harvest(db, 'o/r', null, read)).toBe(1)
  expect(source(db, 'o/r', 8)).toBeUndefined()
  expect(ofKind(db, 'precedent_unread').map((e) => e.message)).toEqual(['o/r#8: HTTP 502'])
  expect(source(db, 'o/r', 9)?.number).toBe(9)
})

it('D5 a reviews read failing twice is logged; the next PR kept', () => {
  const db = fresh()
  const { read, calls } = stub([pr(8), pr(9)], { 8: [review('rev', 'why')], 9: [review('rev', 'why')] }, {}, { '8/reviews': 2 })
  expect(harvest(db, 'o/r', null, read)).toBe(1)
  expect(calls.filter((c) => c[0] === 'api')).toHaveLength(5)
  expect(source(db, 'o/r', 8)).toBeUndefined()
  expect(ofKind(db, 'precedent_unread').map((e) => e.message)).toEqual(['o/r#8: HTTP 502'])
  expect(source(db, 'o/r', 9)?.number).toBe(9)
})

it('D5 reviews at the cap are logged and the PR is not stored', () => {
  const db = fresh()
  const { read } = stub([pr(7)], { 7: Array.from({ length: 100 }, () => review('rev', 'why')) })
  expect(harvest(db, 'o/r', null, read)).toBe(0)
  expect(ofKind(db, 'precedent_unread').map((e) => e.message)).toEqual(['o/r#7: reviews reach the cap of 100; the rest are unread'])
  expect(source(db, 'o/r', 7)).toBeUndefined()
})

it('D5 a list at the limit throws and stores nothing', () => {
  const db = fresh()
  const { read } = stub([...Array(LIMIT).keys()].map((i) => pr(i + 1)))
  expect(() => harvest(db, 'o/r', null, read)).toThrow('o/r lists 1000 merged PRs, the limit; the rest are unread')
  expect(source(db, 'o/r', 1)).toBeUndefined()
})
