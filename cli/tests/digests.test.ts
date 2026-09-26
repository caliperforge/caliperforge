import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { digest, listed } from '../../runner/rules.ts'
import { check, fill } from '../digests.ts'
import { map } from '../map.ts'

const repo = join(import.meta.dirname, '../..')
const TODAY = '2026-09-20'
const ROW = /^ {2}\('(.+?)', '.+?', '(.+?)', '(.+?)', '(.+?)'\)/gm

interface Row { id: string; path: string; hash: string; at: string }

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-digests-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(root, dir), { recursive: true })
  cpSync(join(repo, 'rules.seed.sql'), join(root, 'rules.seed.sql'))
  writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'MAP.md'), map(root))
  return root
}

function rows(root: string): Row[] {
  return [...readFileSync(join(root, 'rules.seed.sql'), 'utf8').matchAll(ROW)]
    .map((m) => ({ id: m[1] ?? '', path: m[2] ?? '', hash: m[3] ?? '', at: m[4] ?? '' }))
}

function rosterHashes(root: string): string[] {
  return rows(root).filter((r) => r.path === 'rules/roster.yaml').map((r) => r.hash)
}

test('a changed prompt fills that seat digest and every roster hash, and a second fill writes nothing', () => {
  const root = tree()
  appendFileSync(join(root, 'seats/brief_writer/prompt.md'), '\n')
  const stale = rosterHashes(root)

  expect(fill(root, TODAY)).toEqual(['rules/roster.yaml', 'rules.seed.sql'])
  expect(listed(root).digests.brief_writer).toEqual({
    manifest: digest(join(root, 'seats/brief_writer/manifest.yaml')),
    prompt: digest(join(root, 'seats/brief_writer/prompt.md')),
  })
  const filled = digest(join(root, 'rules/roster.yaml'))
  expect(stale).not.toContain(filled)
  expect(rosterHashes(root)).toEqual(stale.map(() => filled))
  expect(fill(root, TODAY)).toEqual([])
})

test('an added seat fills both its digests and appends a row dated today, leaving the dates already written', () => {
  const root = tree()
  const seat = join(root, 'seats/yaml_specialist')
  mkdirSync(seat)
  writeFileSync(join(seat, 'manifest.yaml'), 'seat: yaml_specialist\n')
  writeFileSync(join(seat, 'prompt.md'), '# yaml_specialist\n')
  const roster = join(root, 'rules/roster.yaml')
  writeFileSync(roster, readFileSync(roster, 'utf8').replace('digests:', '  - yaml_specialist\ndigests:'))
  const was = rows(root).map((r) => [r.id, r.at])

  fill(root, TODAY)
  expect(listed(root).digests.yaml_specialist).toEqual({
    manifest: digest(join(seat, 'manifest.yaml')),
    prompt: digest(join(seat, 'prompt.md')),
  })
  expect(rows(root).at(-1)).toMatchObject({ id: 'yaml_specialist', path: 'rules/roster.yaml', at: TODAY })
  expect(rows(root).filter((r) => r.id !== 'yaml_specialist').map((r) => [r.id, r.at])).toEqual(was)
  expect(check(root, TODAY)).toEqual([])
})

test('check names a hand-edited digest and the hex that belongs there, writes nothing, and passes a clean tree', () => {
  const root = tree()
  expect(check(root, TODAY)).toEqual([])
  const roster = join(root, 'rules/roster.yaml')
  const was = readFileSync(roster, 'utf8')
  const seed = readFileSync(join(root, 'rules.seed.sql'), 'utf8')
  const hex = digest(join(root, 'seats/brief_writer/prompt.md'))
  writeFileSync(roster, was.replace(hex, 'a'.repeat(64)))

  expect(check(root, TODAY)).toEqual([{ path: 'rules/roster.yaml', digests: { 'brief_writer.prompt': hex } }])
  expect(readFileSync(roster, 'utf8')).toBe(was.replace(hex, 'a'.repeat(64)))
  expect(readFileSync(join(root, 'rules.seed.sql'), 'utf8')).toBe(seed)
  expect(fill(root, TODAY)).toEqual(['rules/roster.yaml'])
  expect(readFileSync(roster, 'utf8')).toBe(was)
})

test('a digest too short for the roster schema is named and filled, and what follows the block survives', () => {
  const root = tree()
  const roster = join(root, 'rules/roster.yaml')
  const hex = digest(join(root, 'seats/brief_writer/prompt.md'))
  writeFileSync(roster, `${readFileSync(roster, 'utf8').replace(hex, hex.slice(0, 63))}notes: kept\n`)

  expect(check(root, TODAY)).toEqual([
    { path: 'rules/roster.yaml', digests: { 'brief_writer.prompt': hex } },
    { path: 'rules.seed.sql', digests: {} },
  ])
  expect(fill(root, TODAY)).toEqual(['rules/roster.yaml', 'rules.seed.sql'])
  expect(listed(root).digests.brief_writer?.prompt).toBe(hex)
  expect(readFileSync(roster, 'utf8').endsWith('\nnotes: kept\n')).toBe(true)
  expect(check(root, TODAY)).toEqual([])
})

test('a roster whose block was deleted gets one back and keeps its seats', () => {
  const root = tree()
  const roster = join(root, 'rules/roster.yaml')
  const was = readFileSync(roster, 'utf8')
  writeFileSync(roster, was.slice(0, was.indexOf('digests:')))

  expect(fill(root, TODAY)).toEqual(['rules/roster.yaml'])
  expect(readFileSync(roster, 'utf8')).toBe(was)
  expect(check(root, TODAY)).toEqual([])
})

test('check names a seed a fill would rewrite, whatever the edited row holds, and the fill keeps its date', () => {
  const root = tree()
  const seed = join(root, 'rules.seed.sql')
  const was = readFileSync(seed, 'utf8')
  writeFileSync(seed, was.replace(rows(root)[0]?.hash ?? '', 'not-a-hash'))

  expect(check(root, TODAY)).toEqual([{ path: 'rules.seed.sql', digests: {} }])
  expect(fill(root, TODAY)).toEqual(['rules.seed.sql'])
  expect(readFileSync(seed, 'utf8')).toBe(was)
})

test('check names a map an added export makes stale and writes nothing, then fill makes it clean', () => {
  const root = tree()
  const was = readFileSync(join(root, 'MAP.md'), 'utf8')
  appendFileSync(join(root, 'a.ts'), 'export const b = 2\n')

  expect(check(root, TODAY)).toEqual([{ path: 'MAP.md', digests: {} }])
  expect(readFileSync(join(root, 'MAP.md'), 'utf8')).toBe(was)
  expect(fill(root, TODAY)).toEqual(['MAP.md'])
  expect(check(root, TODAY)).toEqual([])
})

test('check names a missing map and writes nothing, then fill creates it', () => {
  const root = tree()
  rmSync(join(root, 'MAP.md'))

  expect(check(root, TODAY)).toEqual([{ path: 'MAP.md', digests: {} }])
  expect(existsSync(join(root, 'MAP.md'))).toBe(false)
  expect(fill(root, TODAY)).toEqual(['MAP.md'])
  expect(check(root, TODAY)).toEqual([])
})
