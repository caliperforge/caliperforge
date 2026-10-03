import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Note } from '../../reviews/verdict.ts'
import { digestOf } from '../../store/approvals.ts'
import { record } from '../../store/files.ts'
import type { Db } from '../../store/index.ts'
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
  db.prepare(`INSERT OR IGNORE INTO rules (id, kind, path, content_hash, loaded_at) VALUES ('checks', 'rail', 'rules/rails.yaml', ?, '2026-09-24')`).run('a'.repeat(64))
  db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds)
    VALUES ('pre_review', 'rail', ?, ?, 3, 'pass', 'checks', NULL, NULL, 0, 0)`).run(digest, id)
}

function rows(db: Db, id: number): { message: string | null; subject_digest: string }[] {
  return db.prepare("SELECT message, subject_digest FROM verdicts WHERE plan = ? AND rail_id = 'checks' ORDER BY id").all(id) as
    { message: string | null; subject_digest: string }[]
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

test('D1 D2 a landed note re-stamps the checks pass on the new diff', () => {
  const { db, root } = ruby()
  const diff = diffOf(root, 1)
  expect(rows(db, 1)[1]).toEqual({ message: 'checks re-stamped after notes', subject_digest: digestOf(diff) })
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
  expect(rows(db, 2)).toHaveLength(1)
})

test('D3 a checks pass on another diff is not re-stamped', () => {
  const { db, root } = ruby('b'.repeat(64))
  expect(rows(db, 1)).toHaveLength(1)
  expect(checked(db, plan(db, 1), srcDir(root, 1), diffOf(root, 1)).checks).toContain('No gate ran for')
})
