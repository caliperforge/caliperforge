import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { record } from '../../record.ts'
import { authority } from '../index.ts'

const root = join(import.meta.dirname, '../../..')

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

test('refuses a write outside write_paths and under a frozen migration', () => {
  const verdict = authority(root, 'typescript_specialist', fixture('red.diff'))
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.origin_kind).toBe('rail')
  expect(verdict.origin_ref).toBe('authority')
  expect(verdict.spans).toEqual(['schema/0001_init.sql:1 authority.frozen_schema', 'cli/cf.ts:1 authority.write_paths'])
})

test('passes a diff confined to the seat write_paths', () => {
  const verdict = authority(root, 'typescript_specialist', fixture('green.diff'))
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('refuses an escape above the root', () => {
  const diff = '--- a/x\n+++ b/../outside.ts\n@@ -1,0 +1,1 @@\n+export const x = 1\n'
  expect(authority(root, 'typescript_specialist', diff).spans).toEqual(['../outside.ts:1 authority.write_paths'])
})

/**
 * #41: the rail applies the runner's own-kernel rule. Measured 2026-09-18 16:04-16:19: the rail
 * kept the narrow fence, so plans 11 (#30) and 13 (#32) built and were then refused here for
 * `cli/adopt.ts` and `rails/tight/index.ts` -- the very files their issues named.
 */
const KERNEL = ['diff --git a/cli/x.ts b/cli/x.ts', '--- a/cli/x.ts', '+++ b/cli/x.ts',
  '@@ -1,0 +1,1 @@', '+export const x = 1',
  'diff --git a/sequencer/y.ts b/sequencer/y.ts', '--- a/sequencer/y.ts', '+++ b/sequencer/y.ts',
  '@@ -1,0 +1,1 @@', '+export const y = 2', ''].join('\n')

const FROZEN = ['diff --git a/schema/0001_init.sql b/schema/0001_init.sql', '--- a/schema/0001_init.sql',
  '+++ b/schema/0001_init.sql', '@@ -1,0 +1,1 @@', '+-- touched', ''].join('\n')

const NOTES = ['diff --git a/.cf/anything b/.cf/anything', '--- a/.cf/anything', '+++ b/.cf/anything',
  '@@ -1,0 +1,1 @@', '+{}', ''].join('\n')

test('an internal plan may write the kernel the issue named; an external plan may not', () => {
  expect(authority(root, 'typescript_specialist', KERNEL, true)).toMatchObject({ outcome: 'pass', spans: [] })
  expect(authority(root, 'typescript_specialist', KERNEL, false).spans)
    .toEqual(['cli/x.ts:1 authority.write_paths', 'sequencer/y.ts:1 authority.write_paths'])
})

test('a frozen migration and the tick\'s own notes are refused on an internal plan too', () => {
  for (const ours of [true, false]) {
    expect(authority(root, 'typescript_specialist', FROZEN, ours).spans)
      .toEqual(['schema/0001_init.sql:1 authority.frozen_schema'])
    expect(authority(root, 'typescript_specialist', NOTES, ours).spans)
      .toEqual(['.cf/anything:1 authority.write_paths'])
  }
})

test('an escape above the root is refused on an internal plan too', () => {
  const diff = '--- a/x\n+++ b/../outside.ts\n@@ -1,0 +1,1 @@\n+export const x = 1\n'
  expect(authority(root, 'typescript_specialist', diff, true).spans).toEqual(['../outside.ts:1 authority.write_paths'])
})

test('an unlisted path is refused with the row that owns it or a revert', () => {
  const { outcome, message } = authority(root, 'typescript_specialist', KERNEL, true, [], ['cli/extra.ts'])
  expect(outcome).toBe('refuse')
  for (const part of ['cli/extra.ts', '## Outside the files', '- `cli/extra.ts` — ', 'revert']) expect(message).toContain(part)
})

test('a refusal with no unlisted path carries no row line', () => {
  const made = 'diff --git a/schema/0018_x.sql b/schema/0018_x.sql\nnew file mode 100644\n--- /dev/null\n+++ b/schema/0018_x.sql\n@@ -0,0 +1 @@\n+SELECT 1;\n'
  for (const verdict of [authority(root, 'typescript_specialist', KERNEL, false), authority(root, 'typescript_specialist', FROZEN, true),
    authority(root, 'typescript_specialist', made, true, [], [], ['schema/0018_x.sql'])]) {
    expect(verdict.outcome).toBe('refuse')
    expect(verdict.message).not.toContain('— <why>')
  }
})

test('writes a verdicts row the store accepts', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const id = record(db, join(import.meta.dirname, '..'), plan, authority(root, 'typescript_specialist', fixture('red.diff')), 0.01)
  const row = db.prepare('SELECT gate, kind, outcome, rail_id, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(id)
  expect(row).toEqual({ gate: 'pre_review', kind: 'rail', outcome: 'refuse', rail_id: 'authority', origin_kind: 'rail', origin_ref: 'authority' })
})
