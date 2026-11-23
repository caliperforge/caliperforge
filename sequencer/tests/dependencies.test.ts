import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { eventsOf } from '../../store/events.ts'
import { record } from '../../store/files.ts'
import { migrate, open } from '../../store/index.ts'
import { planById, putPlan } from '../../store/plans.ts'
import { planEvents } from '../../store/trail.ts'
import type { Ran } from '../checks.ts'
import { added } from '../dependencies.ts'
import { BRIEF_FILES, fenceFor } from '../fence.ts'
import { kernelPlan } from '../home.ts'
import { put, srcDir } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')

function seeded() {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  return db
}

function briefed(pinned: string, dependencies: Record<string, string> = {}, plan = 7): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-pinned-'))
  put(root, plan, 'issue.md', `# Ask\n\n## Files\n\n- \`a.ts\`\n\n${pinned}## Tests\n\n- \`b.ts\`\n`)
  writeFileSync(join(srcDir(root, plan), 'package.json'), JSON.stringify({ name: 'x', dependencies }))
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

test('a checkout with no root package.json runs nothing', () => {
  const db = seeded()
  const root = briefed(PINS)
  rmSync(join(srcDir(root, 7), 'package.json'))
  const { asked, run } = npm()
  expect(added(db, root, 7, run)).toBeNull()
  expect(asked).toEqual([])
  expect(rows(db)).toEqual([])
})

test('an outside plan fences in the package files once pins pass', () => {
  const db = seeded()
  putPlan(db, { id: 8, pipe_id: 99, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-09-24', step: 2,
    retries: 0, lane: 'uniswap', seat: 'python_specialist', origin: 'https://github.com/caliperforge/v4-hook-index/issues/1' })
  expect(kernelPlan(planById(db, 8))).toBe(false)
  record(db, 8, [{ path: 'a.ts', is_new: false }])
  expect(fenceFor(db, 8, [BRIEF_FILES])).toEqual(['a.ts'])
  const { run } = npm()
  expect(added(db, briefed('## Pinned\n\n- `a@latest`\n\n', {}, 8), 8, run)).toMatchObject({ outcome: 'needs_ceo' })
  expect(fenceFor(db, 8, [BRIEF_FILES])).toEqual(['a.ts'])
  expect(added(db, briefed(PINS, {}, 8), 8, run)).toBeNull()
  expect(eventsOf(db, 8, 'pinned').map((e) => e.outcome)).toEqual(['needs_ceo', 'pass'])
  expect(fenceFor(db, 8, [BRIEF_FILES])).toEqual(['a.ts', 'package.json', 'package-lock.json'])
})
