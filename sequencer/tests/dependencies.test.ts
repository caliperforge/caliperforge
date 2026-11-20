import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrate, open } from '../../store/index.ts'
import { planEvents } from '../../store/trail.ts'
import type { Ran } from '../checks.ts'
import { added } from '../dependencies.ts'
import { put, srcDir } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')

function seeded() {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  return db
}

function briefed(pinned: string, dependencies: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-pinned-'))
  put(root, 7, 'issue.md', `# Ask\n\n## Files\n\n- \`a.ts\`\n\n${pinned}## Tests\n\n- \`b.ts\`\n`)
  writeFileSync(join(srcDir(root, 7), 'package.json'), JSON.stringify({ name: 'x', dependencies }))
  return root
}

function npm(answer: Ran = { ok: true, output: 'added 2 packages' }) {
  const asked: [string[], string][] = []
  return { asked, run: (args: string[], cwd: string): Ran => {
    asked.push([args, cwd])
    if (answer.ok) writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { a: '1.0.0', '@s/b': '2.1.3' } }))
    return answer
  } }
}

const rows = (db: ReturnType<typeof seeded>): unknown[] => planEvents(db, 7).filter((e) => e.kind === 'pinned')

const PINS = '## Pinned\n\n- `a@1.0.0`\n- `@s/b@2.1.3`\n\n'

test('pinned rows install once, exact, in the checkout', () => {
  const db = seeded()
  const root = briefed(PINS)
  const { asked, run } = npm()
  expect(added(db, root, 7, run)).toBeNull()
  expect(asked).toEqual([[['install', '--save-exact', 'a@1.0.0', '@s/b@2.1.3'], srcDir(root, 7)]])
  expect(rows(db)).toEqual([{ kind: 'pinned', actor: 'machine', outcome: 'pass', run: null,
    message: 'npm install --save-exact a@1.0.0 @s/b@2.1.3', pointer: null }])
})

test.each([
  '- `a@^1.2.0`',
  '- `a@latest`',
  '- `a`',
  '- `a@git+https://github.com/o/a.git`',
  '- `a@file:../a`',
  '- `a@https://example.com/a.tgz`',
  '- a@1.0.0',
])('%s is held for the CEO and npm is not run', (row) => {
  const db = seeded()
  const root = briefed(`## Pinned\n\n- \`a@1.0.0\`\n${row}\n\n`)
  const { asked, run } = npm()
  expect(added(db, root, 7, run)).toEqual({ outcome: 'needs_ceo', spans: [row], note: `pinned: ${row}: not - \`<name>@<x.y.z>\`` })
  expect(asked).toEqual([])
  expect(rows(db)).toMatchObject([{ actor: 'machine', outcome: 'needs_ceo' }])
})

test('a failed install is held with its command, code and output', () => {
  const db = seeded()
  const { run } = npm({ ok: false, code: '1', output: 'npm error 404 a@1.0.0' })
  expect(added(db, briefed(PINS), 7, run)).toEqual({ outcome: 'needs_ceo', spans: ['## Pinned'],
    note: 'pinned: npm install --save-exact a@1.0.0 @s/b@2.1.3 exited 1', message: 'npm error 404 a@1.0.0' })
  expect(rows(db)).toMatchObject([{ outcome: 'needs_ceo' }])
})

test('a package already at its pinned version is not reinstalled', () => {
  const db = seeded()
  const { asked, run } = npm()
  expect(added(db, briefed(PINS, { a: '1.0.0', '@s/b': '^2.1.3' }), 7, run)).toBeNull()
  expect(asked.map(([args]) => args)).toEqual([['install', '--save-exact', '@s/b@2.1.3']])
  expect(added(db, briefed(PINS, { a: '1.0.0', '@s/b': '2.1.3' }), 7, run)).toBeNull()
  expect(asked).toHaveLength(1)
})

test('a brief with no Pinned section runs nothing', () => {
  const db = seeded()
  const { asked, run } = npm()
  expect(added(db, briefed(''), 7, run)).toBeNull()
  expect(asked).toEqual([])
  expect(rows(db)).toEqual([])
})
