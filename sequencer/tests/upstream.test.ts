import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrate, open } from '../../store/index.ts'
import { CAP, pinned } from '../upstream.ts'

const repo = join(import.meta.dirname, '../..')

const SHA = 'a'.repeat(40)

const README = 'hello\n'

function seeded() {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  return db
}

function reader(answer: unknown) {
  const asked: string[][] = []
  return { asked, read: (args: string[]) => { asked.push(args); return answer } }
}

const rows = (db: ReturnType<typeof seeded>): unknown[] =>
  db.prepare("SELECT kind, actor, outcome, run, message, pointer FROM events WHERE kind = 'github_read'").all()

const hex = (text: string): string => createHash('sha256').update(text).digest('hex')

test('a pinned file comes back decoded and logs one row', () => {
  const db = seeded()
  const file = { type: 'file', encoding: 'base64', size: 6, path: 'README.md', content: `${Buffer.from(README).toString('base64')}\n` }
  const { asked, read } = reader(file)
  expect(pinned(db, 7, { repo: 'github.com/o/r', sha: SHA, path: 'README.md' }, read)).toEqual({ content: [{ type: 'text', text: README }] })
  expect(asked).toEqual([['api', `repos/o/r/contents/README.md?ref=${SHA}`]])
  expect(rows(db)).toEqual([{ kind: 'github_read', actor: 'brief_writer', outcome: 'pass', run: null,
    message: `o/r@${SHA} README.md 6 bytes sha256 ${hex(README)}`, pointer: `https://github.com/o/r/blob/${SHA}/README.md` }])
})

test('a read made for coo_lite logs actor coo_lite', () => {
  const db = seeded()
  const { read } = reader({ type: 'file', encoding: 'base64', size: 6, path: 'README.md', content: Buffer.from(README).toString('base64') })
  pinned(db, 7, { repo: 'github.com/o/r', sha: SHA, path: 'README.md' }, read, 'coo_lite')
  expect(rows(db)).toMatchObject([{ actor: 'coo_lite' }])
})

test('a directory lists one line per entry and logs the listing', () => {
  const db = seeded()
  const { read } = reader([{ type: 'file', name: 'a.ts', path: 'src/a.ts', size: 3, sha: 'x' }, { type: 'dir', name: 'b', path: 'src/b', size: 0, sha: 'y' }])
  const listing = 'file\tsrc/a.ts\t3\ndir\tsrc/b\t0'
  expect(pinned(db, 7, { repo: 'https://github.com/o/r.git', sha: SHA, path: 'src' }, read).content[0]?.text).toBe(listing)
  expect(rows(db)).toMatchObject([{ message: `o/r@${SHA} src ${String(listing.length)} bytes sha256 ${hex(listing)}` }])
})

test.each(['main', 'v1.0.0', 'aaaaaaa'])('ref %s is refused before any read', (sha) => {
  const db = seeded()
  const { asked, read } = reader({})
  expect(pinned(db, 7, { repo: 'github.com/o/r', sha, path: 'a' }, read).isError).toBe(true)
  expect(asked).toEqual([])
  expect(rows(db)).toEqual([])
})

test.each(['gitlab.com/o/r', 'https://example.com/o/r', 'o/r'])('repo %s is refused before any read', (at) => {
  const db = seeded()
  const { asked, read } = reader({})
  expect(pinned(db, 7, { repo: at, sha: SHA, path: 'a' }, read).isError).toBe(true)
  expect(asked).toEqual([])
  expect(rows(db)).toEqual([])
})

test('a file over the cap is refused, and a ref inside the path cannot move the pin', () => {
  const db = seeded()
  const { asked, read } = reader({ type: 'file', encoding: 'base64', size: CAP + 1, path: 'a?ref=main', content: '' })
  expect(pinned(db, 7, { repo: 'github.com/o/r', sha: SHA, path: 'a?ref=main' }, read).isError).toBe(true)
  expect(asked).toEqual([['api', `repos/o/r/contents/a%3Fref%3Dmain?ref=${SHA}`]])
  expect(rows(db)).toEqual([])
})
