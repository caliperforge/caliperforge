import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Note } from '../../reviews/verdict.ts'
import { record as stamp } from '../../rails/record.ts'
import { digestOf } from '../../store/approvals.ts'
import { lastChecks } from '../../store/checks.ts'
import { record } from '../../store/files.ts'
import { addRule, type Db } from '../../store/index.ts'
import { verdictRows } from '../../store/verdict.ts'
import { at } from '../../templates/pr-path.ts'
import { landed } from '../notes.ts'
import { checked } from '../seat.ts'
import { diffOf, srcDir } from '../workspace.ts'
import { internalPlan, plan, world } from './world.ts'

const NOTE: Note = { file: 'docs/notes.md', line: 1, old: 'teh', new: 'the', why: 'typo', kind: 'text' }

function lay(root: string, id: number, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(srcDir(root, id), path, '..'), { recursive: true })
    writeFileSync(join(srcDir(root, id), path), body)
  }
}

function passed(db: Db, id: number, digest: string): void {
  addRule(db, { id: 'checks', kind: 'rail', path: 'rules/rails.yaml', content_hash: 'a'.repeat(64), loaded_at: '2026-09-24' })
  stamp(db, join(import.meta.dirname, '../../rails/checks'), id,
    { outcome: 'pass', subject_digest: digest, spans: [], origin_kind: null, origin_ref: null, message: '', defect_class: null }, 0)
}

function rows(db: Db, id: number): number {
  return verdictRows(db, id).filter((r) => r.rail_id === 'checks').length
}

function ruby(digest?: string): { db: Db; root: string } {
  const { db, root } = world()
  record(db, 1, ['ruby/lib/pay_kit/config.rb', 'docs/notes.md'].map((path) => ({ path, is_new: false })))
  lay(root, 1, {
    'ruby/Justfile': 'install:\n    bundle install\n\nlint:\n    bundle exec standardrb\n\ntest:\n    x\n',
    'ruby/lib/pay_kit/config.rb': 'x\n',
    'docs/notes.md': 'teh notes\n',
  })
  passed(db, 1, digest ?? digestOf(diffOf(root, 1)))
  landed(db, root, plan(db, 1), at(4), [NOTE])
  return { db, root }
}

test('D1 D2 a landed note re-stamps the checks pass', () => {
  const { db, root } = ruby()
  const diff = diffOf(root, 1)
  expect(rows(db, 1)).toBe(2)
  expect(lastChecks(db, 1)).toEqual({ outcome: 'pass', subject_digest: digestOf(diff), message: 'checks re-stamped after notes' })
  const { checks } = checked(db, plan(db, 1), srcDir(root, 1), diff)
  expect(checks).toContain('just --justfile Justfile')
  expect(checks).not.toContain('No gate ran for')
})

test('D3 notes rolled back after failed checks write no checks row', () => {
  const { db, root } = world()
  internalPlan(db, root, 2)
  lay(root, 2, { 'package.json': '{"scripts":{"lint":"exit 1"}}', 'docs/notes.md': 'teh notes\n' })
  passed(db, 2, digestOf(diffOf(root, 2)))
  landed(db, root, plan(db, 2), at(4), [NOTE])
  expect(rows(db, 2)).toBe(1)
})

test('D3 a checks pass on another diff is not re-stamped', () => {
  const { db, root } = ruby('b'.repeat(64))
  expect(rows(db, 1)).toBe(1)
  expect(checked(db, plan(db, 1), srcDir(root, 1), diffOf(root, 1)).checks).toContain('No gate ran for')
})
