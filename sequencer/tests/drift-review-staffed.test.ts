import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { addFinding, findings } from '../../store/drift.ts'
import { runAt } from '../../store/events.ts'
import { strays } from '../../store/files.ts'
import { addRule, type Db } from '../../store/index.ts'
import { drift, mechanisms, recovered } from '../drift.ts'
import { git } from '../workspace.ts'
import { db, NOW, REGISTRY, work } from './drifting.ts'

const SWIFT = REGISTRY.filter((e) => e.name === 'swift_review')
const KOTLIN = REGISTRY.filter((e) => e.name === 'kotlin_review')
const RUBY = REGISTRY.filter((e) => e.name === 'ruby_review')
const RULE = { kind: 'card' as const, path: 'rules/roster.yaml', content_hash: '0'.repeat(64), loaded_at: '2026-09-22' }

function planned(path: string): Db {
  const d = db()
  work(d, 5, path)
  addRule(d, { id: 'code_quality', ...RULE })
  return d
}

function ran(d: Db, mode: string, at: string): number {
  const id = runAt(d, 1, 4, 'code_quality', at)
  d.exec(`UPDATE runs SET mode = '${mode}' WHERE id = ${String(id)}`)
  return id
}

function review(d: Db, staffed: string, at: string): void {
  d.exec(`UPDATE runs SET staffed = '${staffed}' WHERE id = ${String(ran(d, 'review', at))}`)
}

test('D1 an old swift review with a fix run in the gap is quiet', () => {
  const d = planned('App.swift')
  review(d, 'swift_specialist', '2026-09-20 10:00:00')
  ran(d, 'fix', '2026-10-02 10:00:00')
  expect(drift(d, SWIFT, NOW)).toEqual([])
})

test('D2 a review run with only seat set does not count', () => {
  const d = planned('App.swift')
  addRule(d, { id: 'swift_specialist', ...RULE })
  d.exec(`UPDATE runs SET mode = 'review' WHERE id = ${String(runAt(d, 1, 4, 'swift_specialist', '2026-10-02 10:00:00'))}`)
  expect(drift(d, SWIFT, NOW)).toEqual([{ name: 'swift_review', state: 'silent',
    detail: "no row in runs WHERE staffed = 'swift_specialist' AND mode = 'review'" }])
})

test('D3 a ruby review in the gap needs a fresh staffed review', () => {
  const ruby = (at: string): Db => {
    const d = planned('app.rb')
    ran(d, 'review', '2026-10-02 10:00:00')
    review(d, 'ruby_specialist', at)
    return d
  }
  expect(drift(ruby('2026-09-20 10:00:00'), RUBY, NOW).map((r) => r.state)).toEqual(['stale'])
  expect(drift(ruby('2026-10-02 11:00:00'), RUBY, NOW)).toEqual([])
})

const PYTHON = 'rules/registry/05-python_review.yaml'

function committed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'))
  const path = join(dir, PYTHON)
  const yaml = readFileSync(join(import.meta.dirname, '../..', PYTHON), 'utf8')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, yaml)
  git(dir, ['init', '-q'])
  git(dir, ['add', '.'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'registry'])
  writeFileSync(path, yaml.replace("staffed = 'python_specialist'", "seat = 'python_specialist'"))
  return dir
}

function python(): Db {
  const d = planned('main.py')
  addRule(d, { id: 'senior_review', ...RULE })
  addRule(d, { id: 'python_specialist', ...RULE })
  d.exec(`UPDATE runs SET mode = 'review', staffed = 'python_specialist'
    WHERE id = ${String(runAt(d, 1, 4, 'senior_review', '2026-10-02 10:00:00'))}`)
  d.exec(`UPDATE runs SET mode = 'review' WHERE id = ${String(runAt(d, 1, 4, 'python_specialist', '2026-09-20 10:00:00'))}`)
  return d
}

test('D1 a registry read at HEAD holds the committed where', () => {
  const dir = committed()
  expect(mechanisms(dir, 'HEAD').map((e) => e.where)).toEqual(["staffed = 'python_specialist' AND mode = 'review'"])
  expect(mechanisms(dir).map((e) => e.where)).toEqual(["seat = 'python_specialist' AND mode = 'review'"])
})

test('D2 a staffed python review is fresh at HEAD only', () => {
  const dir = committed()
  const d = python()
  expect(drift(d, mechanisms(dir, 'HEAD'), NOW)).toEqual([])
  expect(drift(d, mechanisms(dir), NOW)).toEqual([{ name: 'python_review', state: 'stale',
    detail: 'newest runs.at is 2026-09-20 10:00:00, older than 7d', newest: '2026-09-20 10:00:00' }])
})

test('D3 the stale python finding closes as recovered', () => {
  const registry = mechanisms(committed(), 'HEAD')
  const d = python()
  addFinding(d, { name: 'python_review', state: 'stale', detail: 'newest runs.at is 2026-09-20 10:00:00, older than 7d' }, NOW)
  expect(recovered(d, registry, drift(d, registry, NOW), NOW)).toEqual([1])
  expect(findings(d)).toMatchObject([{ outcome: 'fixed', why: 'recovered: newest runs.at is 2026-10-02 10:00:00' }])
})

test('D5 .kt and .kts plans count, a stray .swift path does not', () => {
  for (const path of ['App.kt', 'build.gradle.kts']) {
    const d = planned(path)
    ran(d, 'review', '2026-10-02 10:00:00')
    expect(drift(d, KOTLIN, NOW).map((r) => r.state)).toEqual(['silent'])
  }
  const d = db()
  addRule(d, { id: 'code_quality', ...RULE })
  strays(d, 1, ['App.swift'])
  ran(d, 'review', '2026-10-02 10:00:00')
  expect(drift(d, SWIFT, NOW)).toEqual([])
})
