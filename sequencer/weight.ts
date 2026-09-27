import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, type FileDiff } from '../rails/diff.ts'
import { ASSERT, TEST_FILE } from '../rails/test-weakened/index.ts'
import type { Check, Row } from './card.ts'
import { diffOf, srcDir } from './workspace.ts'

const HEAVY = 2
const TEST = /\b(?:test|it)\s*\(\s*(['"`])(.+?)\1/

interface Assertion { path: string; line: number; title: string; key: string }

export function weight(...[, root, plan]: Parameters<Check>): Row {
  return weigh(diffOf(root, plan), (path) => readFileSync(join(srcDir(root, plan), path), 'utf8'))
}

export function weigh(diff: string, read: (path: string) => string): Row {
  const files = parse(diff)
  const tests = files.filter((f) => TEST_FILE.test(f.path))
  const test = lines(tests)
  const code = lines(files.filter((f) => !TEST_FILE.test(f.path)))
  const added = new Set(tests.flatMap((f) => f.added.map(at)))
  const duplicates = repeated(tests.filter((f) => !f.deleted).flatMap((f) => assertions(f.path, read(f.path))), added)
  return {
    check: 'tests',
    ok: test <= HEAVY * code && duplicates.length === 0,
    says: [`+${String(test)} test / +${String(code)} code lines`, ...duplicates].join('; '),
  }
}

function lines(files: FileDiff[]): number {
  return files.flatMap((f) => f.added).filter((l) => l.text.trim() !== '').length
}

function assertions(path: string, text: string): Assertion[] {
  let title: string | undefined
  return text.split('\n').flatMap((raw, i) => {
    title = TEST.exec(raw)?.[2] ?? title
    return title !== undefined && ASSERT.test(raw) ? [{ path, line: i + 1, title, key: raw.trim() }] : []
  })
}

function repeated(all: Assertion[], added: Set<string>): string[] {
  const byKey = new Map<string, Assertion[]>()
  for (const a of all) byKey.set(a.key, [...(byKey.get(a.key) ?? []), a])
  return [...byKey].flatMap(([key, found]) => {
    const tests = found.filter((a, i) => found.findIndex((b) => b.path === a.path && b.title === a.title) === i)
    const fresh = found.some((a) => added.has(at(a)))
    return tests.length > 1 && fresh ? [`${tests.map(named).join(' and ')} both assert ${key}`] : []
  })
}

function at(l: { path: string; line: number }): string {
  return `${l.path}:${String(l.line)}`
}

function named(a: Assertion): string {
  return `${at(a)} "${a.title}"`
}
