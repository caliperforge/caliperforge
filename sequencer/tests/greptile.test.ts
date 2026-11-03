import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Read } from '../../cli/gh.ts'
import { distilled, keep, type Precedent, type Source } from '../../precedents/store.ts'
import { keepEscapes } from '../../store/escapes.ts'
import type { Db } from '../../store/index.ts'
import { flag, type Finding } from '../../store/precedent-findings.ts'
import { config } from '../greptile.ts'

const SOURCE = 'https://github.com/o/r/pull/1#discussion_r1'

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-greptile-'))
  mkdirSync(join(dir, 'profiles/solana-foundation'), { recursive: true })
  writeFileSync(join(dir, 'profiles/solana-foundation/pay-kit.yml'), 'greptile_files: [docs/paykit-interface.md]\n')
  mkdirSync(join(dir, 'reviews/examples'), { recursive: true })
  writeFileSync(join(dir, 'reviews/examples/python.md'), '# Python\n\n- pay-kit#1 `a`: one (l1).\n- widget#3 `w`: other (l3).\n')
  return dir
}

const db = (): Db => fresh(join(import.meta.dirname, '../../schema'))

const unread: Read = () => { throw new Error('unread') }

const tree = (paths: string[]): Read => (args) => {
  if (args[1] === 'repos/o/r') return { default_branch: 'main' }
  if (args[1] === 'repos/o/r/git/trees/main?recursive=1') return { tree: paths.map((path) => ({ path })), truncated: false }
  throw new Error(`unread ${args.join(' ')}`)
}

const read = (dir: string, repo: string): unknown => JSON.parse(config(db(), dir, repo, [], unread).json)

const rules = (d: Db, files: string[], gh: Read = unread, dir = root()): unknown =>
  (JSON.parse(config(d, dir, 'o/r', files, gh).json) as { customContext: { rules: unknown } }).customContext.rules

const finding = (acted_on: Finding['acted_on']): Finding => ({ finding: 'f', area: 'src/a.rs:parse', acted_on, source: SOURCE })

const pr = (number: number, files: string[], merged_at = '2026-10-01T00:00:00Z'): Source =>
  ({ repo: 'o/r', number, title: 'T', merged_at, merger: null, files, issues: [] })

const at = (area: string, decision = 'd'): Precedent => ({ area, decision, why: 'w', said_by: 'm', role: 'maintainer', source: SOURCE })

function filed(d: Db, ...stored: [Source, Precedent[]][]): void {
  for (const [source, rows] of stored) {
    keep(d, source, [])
    distilled(d, source, rows, 0)
  }
}

const escape = (d: Db): void => {
  keepEscapes(d, 'o/r', 1, 1, [{ area: 'src/a.rs', line: 3, author: 'm', role: 'maintainer', text: 'too\n  wide', url: SOURCE }])
}

const learned = (dir: string, text: string): string => {
  mkdirSync(join(dir, '.cf/examples'), { recursive: true })
  writeFileSync(join(dir, '.cf/examples/rust.md'), text)
  return dir
}

test('D1 pay-kit carries its files, strictness 1, no autoReview', () => {
  expect(read(root(), 'solana-foundation/pay-kit')).toMatchObject({ autoReview: [], strictness: 1,
    customContext: { files: [{ path: 'docs/paykit-interface.md', scope: ['**'] }] } })
})

test('D3 no profile, no examples and no .cf folder: empty context', () => {
  expect(read(root(), 'acme/kit')).toEqual({ autoReview: [], strictness: 1, customContext: { rules: [], files: [] } })
})

test('D1 a fixed bot finding gives one rule on its file', () => {
  const d = db()
  flag(d, 'o/r', 1, [finding('fixed')])
  expect(rules(d, ['src/a.rs'])).toEqual([{ rule: `f (${SOURCE})`, scope: ['src/a.rs'] }])
})

test('D2 an ignored bot finding gives no rule', () => {
  const d = db()
  flag(d, 'o/r', 1, [finding('ignored')])
  expect(rules(d, ['src/a.rs'])).toEqual([])
})

test('D3 a job on src/b.rs gets no src/a.rs rule from any source', () => {
  const d = db()
  flag(d, 'o/r', 1, [finding('agreed')])
  escape(d)
  filed(d, [pr(1, ['src/a.rs', 'src/b.rs']), [at('src/a.rs')]])
  expect(rules(d, ['src/b.rs'], tree(['src/a.rs', 'src/b.rs']), learned(root(), '- r#1 `o/r@abc1234:src/a.rs:3`: one (l1).\n'))).toEqual([])
})

test('D4 only the latest live precedent on a file gives a rule', () => {
  const d = db()
  filed(d, [pr(1, ['src/a.rs']), [at('src/a.rs', 'old')]], [pr(2, ['src/a.rs', 'src/gone.rs'], '2026-10-05T00:00:00Z'),
    [at('src/a.rs', 'new'), at('src/gone.rs')]])
  expect(rules(d, ['src/a.rs', 'src/gone.rs'], tree(['src/a.rs']))).toEqual([{ rule: `new: w (${SOURCE})`, scope: ['src/a.rs'] }])
})

test('D5 an escape gives a rule scoped to its file', () => {
  const d = db()
  escape(d)
  expect(rules(d, ['src/a.rs'])).toEqual([{ rule: `too wide (${SOURCE})`, scope: ['src/a.rs'] }])
})

test('D6 a learned line is scoped to its span path', () => {
  const dir = learned(root(), '- r#1 `o/r@abc1234:src/a.rs:3`: one (l1).\n- r#2 `a`: two (l2).\n')
  expect(rules(db(), ['src/a.rs'], unread, dir)).toEqual([{ rule: 'r#1 `o/r@abc1234:src/a.rs:3`: one (l1).', scope: ['src/a.rs'] }])
})

test('D1 counts are by source and follow the scope filter', () => {
  const d = db()
  escape(d)
  flag(d, 'o/r', 1, [finding('fixed'), { ...finding('fixed'), finding: 'g' }])
  const counts = (files: string[]): string => config(d, root(), 'o/r', files, unread).counts
  expect(counts(['src/a.rs'])).toBe('escapes 1, their reviewer 2, maintainer decisions 0, ours 0')
  expect(counts(['src/b.rs'])).toBe('escapes 0, their reviewer 0, maintainer decisions 0, ours 0')
})

test('D7 a repo with no filed precedent never reads', () => {
  let reads = 0
  const d = db()
  flag(d, 'o/r', 1, [finding('fixed')])
  expect(rules(d, ['src/a.rs'], () => { reads += 1; throw new Error('unread') })).toHaveLength(1)
  expect(reads).toBe(0)
})
