import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { digest, listed } from '../../runner/rules.ts'
import { check, fill } from '../digests.ts'

const repo = join(import.meta.dirname, '../..')
const TODAY = '2026-09-20'
const ROW = /^ {2}\('(.+?)', '.+?', '(.+?)', '(.+?)', '(.+?)'\)/gm

interface Row { id: string; path: string; hash: string; at: string }

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-digests-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(root, dir), { recursive: true })
  cpSync(join(repo, 'rules.seed.sql'), join(root, 'rules.seed.sql'))
  return root
}

function rows(root: string): Row[] {
  return [...readFileSync(join(root, 'rules.seed.sql'), 'utf8').matchAll(ROW)]
    .map((m) => ({ id: m[1] ?? '', path: m[2] ?? '', hash: m[3] ?? '', at: m[4] ?? '' }))
}

const BRIEF = 'rules/roster/brief_writer.yaml'

test('changed prompt fills its seat file and the seed, once', () => {
  const root = tree()
  appendFileSync(join(root, 'seats/brief_writer/prompt.md'), '\n')
  const was = rows(root).filter((r) => r.id !== 'brief_writer')

  expect(check(root, TODAY)[0]).toEqual({ path: BRIEF, digests: { 'brief_writer.prompt': digest(join(root, 'seats/brief_writer/prompt.md')) } })
  expect(fill(root, TODAY)).toEqual([BRIEF, 'rules.seed.sql'])
  expect(listed(root).digests.brief_writer).toEqual({
    manifest: digest(join(root, 'seats/brief_writer/manifest.yaml')),
    prompt: digest(join(root, 'seats/brief_writer/prompt.md')),
  })
  expect(rows(root).find((r) => r.id === 'brief_writer')).toMatchObject({ path: BRIEF, hash: digest(join(root, BRIEF)) })
  expect(rows(root).filter((r) => r.id !== 'brief_writer')).toEqual(was)
  expect(fill(root, TODAY)).toEqual([])
})

test('added seat: both digests, a row dated today, old dates kept', () => {
  const root = tree()
  const seat = join(root, 'seats/java_specialist')
  mkdirSync(seat)
  writeFileSync(join(seat, 'manifest.yaml'), 'seat: java_specialist\n')
  writeFileSync(join(seat, 'prompt.md'), '# java_specialist\n')
  writeFileSync(join(root, 'rules/roster/java_specialist.yaml'), '')
  const was = Object.fromEntries(rows(root).map((r) => [r.id, r.at]))

  fill(root, TODAY)
  expect(listed(root).digests.java_specialist).toEqual({
    manifest: digest(join(seat, 'manifest.yaml')),
    prompt: digest(join(seat, 'prompt.md')),
  })
  expect(rows(root).find((r) => r.id === 'java_specialist')).toMatchObject({ path: 'rules/roster/java_specialist.yaml', at: TODAY })
  const seats = rows(root).filter((r) => r.path.startsWith('rules/roster/')).map((r) => r.id)
  expect(seats).toEqual([...seats].sort())
  expect(Object.fromEntries(rows(root).filter((r) => r.id !== 'java_specialist').map((r) => [r.id, r.at]))).toEqual(was)
  expect(check(root, TODAY)).toEqual([])
})

test('check names edited digest and hex, no write; clean passes', () => {
  const root = tree()
  expect(check(root, TODAY)).toEqual([])
  const roster = join(root, BRIEF)
  const was = readFileSync(roster, 'utf8')
  const seed = readFileSync(join(root, 'rules.seed.sql'), 'utf8')
  const hex = digest(join(root, 'seats/brief_writer/prompt.md'))
  writeFileSync(roster, was.replace(hex, 'a'.repeat(64)))

  expect(check(root, TODAY)).toEqual([{ path: BRIEF, digests: { 'brief_writer.prompt': hex } }])
  expect(readFileSync(roster, 'utf8')).toBe(was.replace(hex, 'a'.repeat(64)))
  expect(readFileSync(join(root, 'rules.seed.sql'), 'utf8')).toBe(seed)
  expect(fill(root, TODAY)).toEqual([BRIEF])
  expect(readFileSync(roster, 'utf8')).toBe(was)
})

test('a short or emptied seat file is named and refilled', () => {
  const root = tree()
  const roster = join(root, BRIEF)
  const was = readFileSync(roster, 'utf8')
  const hex = digest(join(root, 'seats/brief_writer/prompt.md'))
  writeFileSync(roster, was.replace(hex, hex.slice(0, 63)))

  expect(check(root, TODAY)).toEqual([{ path: BRIEF, digests: { 'brief_writer.prompt': hex } }])
  expect(fill(root, TODAY)).toEqual([BRIEF])
  expect(listed(root).digests.brief_writer?.prompt).toBe(hex)

  writeFileSync(roster, '')

  expect(check(root, TODAY)).toEqual([{ path: BRIEF, digests: {
    'brief_writer.manifest': digest(join(root, 'seats/brief_writer/manifest.yaml')),
    'brief_writer.prompt': digest(join(root, 'seats/brief_writer/prompt.md')),
  } }])
  expect(fill(root, TODAY)).toEqual([BRIEF])
  expect(readFileSync(roster, 'utf8')).toBe(was)
  expect(check(root, TODAY)).toEqual([])
})

test('check names a seed fill would rewrite; fill keeps its date', () => {
  const root = tree()
  const seed = join(root, 'rules.seed.sql')
  const was = readFileSync(seed, 'utf8')
  writeFileSync(seed, was.replace(rows(root)[0]?.hash ?? '', 'not-a-hash'))

  expect(check(root, TODAY)).toEqual([{ path: 'rules.seed.sql', digests: {} }])
  expect(fill(root, TODAY)).toEqual(['rules.seed.sql'])
  expect(readFileSync(seed, 'utf8')).toBe(was)
})
