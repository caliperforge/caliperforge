import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planRow } from '../../../runner/index.ts'
import { record, strays } from '../../../store/files.ts'
import { inContext } from '../../package.ts'

const root = join(import.meta.dirname, '../../..')

const A = ['export function one(): number {', '  const x = 1', '  return x', '}', '', 'export function two(): number {', '  return 2', '}', '']
const B = ['const b = 1', '', 'export function three(): string {', "  return 'c'", '}', '']

function setup(listed: string[], importers: Record<string, string> = {}): { db: ReturnType<typeof fresh>; plan: number; repo: string } {
  const repo = mkdtempSync(join(tmpdir(), 'cf-package-'))
  mkdirSync(join(repo, 'src'))
  for (const [name, lines] of [['a', A], ['b', B], ['c', B]] as const) writeFileSync(join(repo, 'src', `${name}.ts`), lines.join('\n'))
  for (const [name, text] of Object.entries(importers)) writeFileSync(join(repo, 'src', name), text)
  const db = fresh(join(root, 'schema'))
  const plan = planRow(db)
  record(db, plan, listed.map((path) => ({ path, is_new: false })))
  return { db, plan, repo }
}

const fenced = (name: string, lines: string[]): string => `## ${name}\n\n\`\`\`\`\n${lines.join('\n')}\n\`\`\`\``

const hunk = (path: string, body: string): string => `--- a/${path}\n+++ b/${path}\n${body}\n`
const ONE = hunk('src/a.ts', '@@ -2 +2 @@\n-  const x = 0\n+  const x = 1')
const THREE = hunk('src/b.ts', "@@ -4 +4 @@\n-  return 'b'\n+  return 'c'")

test('D1: a two-file diff carries each changed declaration whole and no other', () => {
  const { db, plan, repo } = setup(['src/a.ts', 'src/b.ts'])
  expect(inContext(db, plan, repo, ONE + THREE)).toBe(`${fenced('src/a.ts:1-4', A.slice(0, 4))}\n\n${fenced('src/b.ts:3-5', B.slice(2, 5))}`)
})

test('D2: a removal-only hunk carries the function it landed in', () => {
  const { db, plan, repo } = setup(['src/a.ts'])
  expect(inContext(db, plan, repo, hunk('src/a.ts', '@@ -7,1 +6,0 @@\n-  const y = 2'))).toBe(fenced('src/a.ts:6-8', A.slice(5, 8)))
})

test('D3: two hunks in one declaration give one block', () => {
  const { db, plan, repo } = setup(['src/a.ts'])
  expect(inContext(db, plan, repo, hunk('src/a.ts', '@@ -2 +2 @@\n-  const x = 0\n+  const x = 1\n@@ -3 +3 @@\n-  return 0\n+  return x')))
    .toBe(fenced('src/a.ts:1-4', A.slice(0, 4)))
})

test('D6: only the store\'s listed files are carried, never a stray, and no rows mean no context', () => {
  const { db, plan, repo } = setup(['src/a.ts'])
  strays(db, plan, ['src/c.ts'])
  const diff = ONE + THREE + THREE.replaceAll('src/b.ts', 'src/c.ts')
  expect(inContext(db, plan, repo, diff)).toBe(fenced('src/a.ts:1-4', A.slice(0, 4)))
  const bare = setup([])
  expect(inContext(bare.db, bare.plan, bare.repo, diff)).toBeUndefined()
})

const BOTH = `${fenced('src/a.ts:1-4', A.slice(0, 4))}\n\n${fenced('src/b.ts:3-5', B.slice(2, 5))}`

test('85b D1: a two-file diff lists the importers of its changed exports', () => {
  const { db, plan, repo } = setup(['src/a.ts', 'src/b.ts'], { 'd.ts': "import { one } from './a.ts'\n", 'e.ts': "import { three } from './b.ts'\n" })
  expect(inContext(db, plan, repo, ONE + THREE)).toBe(`${BOTH}\n\n## Imported by\n\n- src/d.ts\n- src/e.ts`)
})

test('85b D2: an importer of an unchanged export or of an unlisted path is not listed', () => {
  const { db, plan, repo } = setup(['src/a.ts', 'src/b.ts'], {
    'd.ts': "import { one } from './a.ts'\n",
    'f.ts': "import { two } from './a.ts'\n",
    'g.ts': "import { three } from './c.ts'\n",
  })
  const diff = ONE + THREE + THREE.replaceAll('src/b.ts', 'src/c.ts')
  expect(inContext(db, plan, repo, diff)).toBe(`${BOTH}\n\n## Imported by\n\n- src/d.ts`)
})

test('85b D3: with no importer the output is 85a\'s', () => {
  const { db, plan, repo } = setup(['src/a.ts', 'src/b.ts'])
  expect(inContext(db, plan, repo, ONE + THREE)).toBe(BOTH)
})

test('85b D4: an importer of several changed files appears once', () => {
  const { db, plan, repo } = setup(['src/a.ts', 'src/b.ts'], {
    'd.ts': "import { one } from './a.ts'\nimport * as a from './a'\nimport { three } from './b.ts'\n",
  })
  expect(inContext(db, plan, repo, ONE + THREE)).toBe(`${BOTH}\n\n## Imported by\n\n- src/d.ts`)
})
