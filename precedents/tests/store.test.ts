import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from '../../store/index.ts'
import { keep, newestMerged, source, threads, type Source, type Thread } from '../store.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const fresh = () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  return db
}

const pr: Source = { repo: 'o/r', number: 7, title: 'Fix', merged_at: '2026-10-01T00:00:00Z', merger: null, files: ['a.ts'], issues: [3] }
const review: Thread = { kind: 'review', author: 'x', role: 'MEMBER', text: 'ok', path: null, line: null }
const inline: Thread = { kind: 'inline', author: 'y', role: 'NONE', text: 'nit', path: 'a.ts', line: 4 }

it('D1 a fresh migrate creates both tables', () => {
  const db = fresh()
  expect(source(db, 'o/r', 7)).toBeUndefined()
  expect(threads(db, 'o/r', 7)).toEqual([])
})

it('D2 a stored PR and its two threads read back as stored', () => {
  const db = fresh()
  keep(db, pr, [review, inline])
  expect(source(db, 'o/r', 7)).toEqual(pr)
  expect(threads(db, 'o/r', 7)).toEqual([review, inline])
})

it('D3 newestMerged reads one repo and is null for an empty one', () => {
  const db = fresh()
  keep(db, pr, [])
  keep(db, { ...pr, number: 8, merged_at: '2026-10-05T00:00:00Z' }, [])
  keep(db, { ...pr, repo: 'o/s', merged_at: '2026-10-09T00:00:00Z' }, [])
  expect(newestMerged(db, 'o/r')).toBe('2026-10-05T00:00:00Z')
  expect(newestMerged(db, 'o/t')).toBeNull()
})

it('D4 an unknown thread kind throws and stores nothing', () => {
  const db = fresh()
  expect(() => { keep(db, pr, [review, { ...inline, kind: 'emoji' }]) }).toThrow('unknown thread kind emoji')
  expect(source(db, 'o/r', 7)).toBeUndefined()
  expect(threads(db, 'o/r', 7)).toEqual([])
})

it('D5 storing a PR again leaves only the new threads', () => {
  const db = fresh()
  keep(db, pr, [review, inline])
  keep(db, { ...pr, title: 'Fix again' }, [inline])
  expect(source(db, 'o/r', 7)?.title).toBe('Fix again')
  expect(threads(db, 'o/r', 7)).toEqual([inline])
})
