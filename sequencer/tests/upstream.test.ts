import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Read } from '../../cli/gh.ts'
import { migrate, open } from '../../store/index.ts'
import { CAP, pinned, vendored } from '../upstream.ts'
import { put, srcDir } from '../workspace.ts'

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

const hex = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')

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

test('a file over the cap is refused; a path ref leaves the pin', () => {
  const db = seeded()
  const { asked, read } = reader({ type: 'file', encoding: 'base64', size: CAP + 1, path: 'a?ref=main', content: '' })
  expect(pinned(db, 7, { repo: 'github.com/o/r', sha: SHA, path: 'a?ref=main' }, read).isError).toBe(true)
  expect(asked).toEqual([['api', `repos/o/r/contents/a%3Fref%3Dmain?ref=${SHA}`]])
  expect(rows(db)).toEqual([])
})

const PIN = '4120d171a397c153ced2e1d7e683d5a8c7f84b98'

const BYTES = Buffer.from([0xff, 0x00, 0x0a])

const GOOD = `- \`tests/fixtures/sky-schema/object.json\` — github.com/caliperforge/sky-schema@${PIN} schema/object.json`

const at = (path: string): string => `repos/caliperforge/sky-schema/contents/${path}?ref=${PIN}`

function upstream(): { asked: string[][]; read: Read } {
  const asked: string[][] = []
  const answers: Record<string, unknown> = {
    [at('schema/object.json')]: { type: 'file', size: 3, content: BYTES.toString('base64') },
    [at('schema')]: [{ type: 'file', path: 'schema/object.json', size: 3 }],
    [at('big.json')]: { type: 'file', size: CAP + 1, content: '' },
  }
  return { asked, read: (args) => {
    asked.push(args)
    const got = answers[args[1] ?? '']
    if (got === undefined) throw new Error('HTTP 404')
    return got
  } }
}

function briefed(vendor: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-vendor-'))
  put(root, 7, 'issue.md', `# Ask\n\n## Files\n\n- \`a.ts\`\n\n${vendor}## Tests\n\n- \`b.ts\`\n`)
  return root
}

test('a vendored row lands its exact bytes in a new folder', () => {
  const db = seeded()
  const root = briefed(`## Vendored\n\n${GOOD}\n\n`)
  const { asked, read } = upstream()
  expect(vendored(db, root, 7, read)).toBeNull()
  expect(readFileSync(join(srcDir(root, 7), 'tests/fixtures/sky-schema/object.json'))).toEqual(BYTES)
  expect(asked).toEqual([['api', at('schema/object.json')]])
  expect(rows(db)).toEqual([{ kind: 'github_read', actor: 'machine', outcome: 'pass', run: null,
    message: `caliperforge/sky-schema@${PIN} schema/object.json 3 bytes sha256 ${hex(BYTES)}`,
    pointer: `https://github.com/caliperforge/sky-schema/blob/${PIN}/schema/object.json` }])
})

test('a brief with no Vendored section reads and writes nothing', () => {
  const db = seeded()
  const root = briefed('')
  const { asked, read } = upstream()
  expect(vendored(db, root, 7, read)).toBeNull()
  expect(asked).toEqual([])
  expect(readdirSync(srcDir(root, 7))).toEqual([])
})

test.each([
  `- \`a.json\` — github.com/caliperforge/sky-schema@main schema/object.json`,
  `- \`a.json\` — gitlab.com/caliperforge/sky-schema@${PIN} schema/object.json`,
  `- \`../x.json\` — github.com/caliperforge/sky-schema@${PIN} schema/object.json`,
  `- \`/etc/x\` — github.com/caliperforge/sky-schema@${PIN} schema/object.json`,
  `- \`a.json\` — github.com/caliperforge/sky-schema@${PIN} schema`,
  `- \`a.json\` — github.com/caliperforge/sky-schema@${PIN} big.json`,
  `- \`a.json\` — github.com/caliperforge/sky-schema@${PIN} gone.json`,
  '- `a.json` from sky-schema',
])('%s is held for the CEO with no file written', (row) => {
  const db = seeded()
  const root = briefed(`## Vendored\n\n${GOOD}\n${row}\n\n`)
  const { read } = upstream()
  const held = vendored(db, root, 7, read)
  expect(held).toMatchObject({ outcome: 'needs_ceo', spans: [row] })
  expect(held?.note.startsWith(`vendor: ${row}: `)).toBe(true)
  expect(readdirSync(srcDir(root, 7))).toEqual([])
})
