import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { record, type Verdict } from '../../record.ts'
import { tight, type Subject } from '../index.ts'

const root = join(import.meta.dirname, '../../..')

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

function subject(colour: string): Subject {
  return {
    diff: fixture(`${colour}.diff`),
    sources: { 'src/helper.ts': fixture(`${colour}.source.txt`) },
    description: fixture(`${colour}.description.md`),
  }
}

test('refuses the nine Tight breaches over a diff, naming every span', () => {
  const verdict = tight(root, subject('red'))
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.origin_kind).toBe('rail')
  expect(verdict.origin_ref).toBe('tight')
  expect(verdict.spans).toEqual([
    'src/helper.ts:2 tight.unused_import',
    'src/helper.ts:4 tight.justifying',
    'src/helper.ts:9 tight.restating',
    'src/helper.ts:10 tight.dead_helper',
    'src/helper.ts:14 tight.nesting',
    'description:1 tight.preamble',
    'description:3 tight.hedge',
    'description:3 tight.summary',
  ])
})

test('passes a diff and description that are Tight', () => {
  const verdict = tight(root, subject('green'))
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('refuses a function longer than the manifest ceiling', () => {
  const body = [...Array(45).keys()].map((i) => `  const v${String(i)} = ${String(i)}`).join('\n')
  const source = `export function long(): number {\n${body}\n  return v0\n}\n`
  const diff = `--- /dev/null\n+++ b/src/long.ts\n@@ -0,0 +1,48 @@\n${source.split('\n').map((l) => `+${l}`).join('\n')}`
  const verdict = tight(root, { diff, sources: { 'src/long.ts': source }, description: 'Long.' })
  expect(verdict.spans).toEqual(['src/long.ts:1 tight.length'])
})

test('on an outside repo the code limits are theirs; the prose is still judged', () => {
  const body = [...Array(45).keys()].map((i) => `  const v${String(i)} = ${String(i)}`).join('\n')
  const source = `export function long(): number {\n${body}\n  return v0\n}\n`
  const diff = `--- /dev/null\n+++ b/src/long.ts\n@@ -0,0 +1,48 @@\n${source.split('\n').map((l) => `+${l}`).join('\n')}`
  expect(tight(root, { diff, sources: { 'src/long.ts': source }, description: 'Long.', code: false }).outcome).toBe('pass')
  expect(tight(root, { ...subject('red'), code: false }).spans).toEqual([
    'description:1 tight.preamble', 'description:3 tight.hedge', 'description:3 tight.summary',
  ])
})

test('ignores a breach on a line the diff did not add', () => {
  const source = '// because it is old\nexport const x = 1\n'
  const diff = '--- a/src/old.ts\n+++ b/src/old.ts\n@@ -1,2 +1,2 @@\n // because it is old\n-export const x = 0\n+export const x = 1\n'
  expect(tight(root, { diff, sources: { 'src/old.ts': source }, description: 'x.' }).outcome).toBe('pass')
})

function braced(path: string, source: string): Subject {
  const lines = source.split('\n')
  return {
    diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${String(lines.length)} @@\n${lines.map((l) => `+${l}`).join('\n')}`,
    sources: { [path]: source },
    description: 'Ledger settlement.',
  }
}

test('refuses a Kotlin function past the ceiling at its fun line', () => {
  const verdict = tight(root, braced('src/Ledger.kt', fixture('kotlin.long.kt.txt')))
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['src/Ledger.kt:3 tight.length'])
})

test('passes the same Kotlin work split under the ceiling', () => {
  const verdict = tight(root, braced('src/Ledger.kts', fixture('kotlin.split.kt.txt')))
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('judges Swift func the same as Kotlin fun', () => {
  expect(tight(root, braced('src/Ledger.swift', fixture('swift.long.swift.txt'))).spans)
    .toEqual(['src/Ledger.swift:3 tight.length'])
  expect(tight(root, braced('src/Ledger.swift', fixture('swift.split.swift.txt'))).spans).toEqual([])
})

test('ends a Kotlin function at its brace, not at one inside a multi-line string', () => {
  const verdict = tight(root, braced('src/Receipt.kt', fixture('kotlin.strings.kt.txt')))
  expect(verdict.spans).toEqual([])
  expect(verdict.message).not.toContain('src/Receipt.kt')
})

test('reads no span from an unbalanced Kotlin file and names it', () => {
  const source = 'fun open(rows: List<Row>): Int {\n    if (rows.isEmpty()) {\n        return 0\n    return rows.size\n}\n'
  const verdict = tight(root, braced('src/Open.kt', source))
  expect(verdict.spans).toEqual([])
  expect(verdict.message).toContain('src/Open.kt')
})

test('never judges an expression-bodied fun', () => {
  const filler = [...Array(45).keys()].map((i) => `    val step${String(i)} = ${String(i)}`).join('\n')
  const source = `fun total(rows: List<Row>) = rows.size\n\nfun tally(rows: List<Row>): Int {\n${filler}\n    return rows.size\n}\n`
  expect(tight(root, braced('src/Total.kt', source)).spans).toEqual(['src/Total.kt:3 tight.length'])
})

test('leaves the next function its brace when a declaration has no body', () => {
  const doc = [...Array(45).keys()].map((i) => `    val step${String(i)}: Int`).join('\n')
  const body = [...Array(45).keys()].map((i) => `    val step${String(i)} = ${String(i)}`).join('\n')
  const kotlin = `fun interface Handler {\n${doc}\n    fun handle(row: Row): Int\n}\n\nfun settle(rows: List<Row>): Long {\n${body}\n    return 0L\n}\n`
  expect(tight(root, braced('src/Handler.kt', kotlin)).spans).toEqual(['src/Handler.kt:50 tight.length'])
  const counts = [...Array(45).keys()].map((i) => `        let step${String(i)} = ${String(i)}`).join('\n')
  const swift = `protocol Ledger {\n    func settle(rows: [Row]) -> Int\n}\n\nstruct Cash: Ledger {\n    func settle(rows: [Row]) -> Int {\n${counts}\n        return rows.count\n    }\n}\n`
  expect(tight(root, braced('src/Cash.swift', swift)).spans).toEqual(['src/Cash.swift:6 tight.length'])
})

test('reads nothing from a .py path whose source is present', () => {
  const verdict = tight(root, braced('src/ledger.py', fixture('kotlin.long.kt.txt')))
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('writes a verdicts row the store accepts', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const id = record(db, join(import.meta.dirname, '..'), plan, tight(root, subject('red')), 0.01)
  const row = db.prepare('SELECT gate, kind, outcome, rail_id, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(id)
  expect(row).toEqual({ gate: 'pre_review', kind: 'rail', outcome: 'refuse', rail_id: 'tight', origin_kind: 'rail', origin_ref: 'tight' })
})

const added = (path: string, source: string): string => {
  const lines = source.trimEnd().split('\n')
  return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${String(lines.length)} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`
}

/** #105: plan 47 was refused on a template line that writes `// step ${i}`, read as a comment once an earlier `${…}` threw the scan off. */
test('text in a template or a regex is not a comment', () => {
  const template = [
    'export const body = (i: number): string => `    val step${String(i)} = ${String(i)}`',
    'export const doc = (i: number): string => `    // step ${String(i)}`',
    'export const stepString = 1',
  ].join('\n')
  const regex = 'export const slashes = (s: string): boolean => /\\/\\/ step string/.test(s)\nexport const stepString = 1'
  for (const source of [template, regex]) {
    const verdict = tight(root, { diff: added('src/fixture.ts', source), sources: { 'src/fixture.ts': source }, description: 'x.' })
    expect(verdict.spans).toEqual([])
  }
})

test('a restating comment after a template still refuses', () => {
  const source = 'export const doc = (i: number): string => `// step ${String(i)} done`\n// step count\nexport const stepCount = 1\n'
  const verdict = tight(root, { diff: added('src/fixture.ts', source), sources: { 'src/fixture.ts': source }, description: 'x.' })
  expect(verdict.spans).toEqual(['src/fixture.ts:2 tight.restating'])
})

const commented = (comment: string, code = 'export const reap = 1'): Verdict => {
  const source = `${comment}\n${code}\n`
  return tight(root, { diff: added('src/x.ts', source), sources: { 'src/x.ts': source }, description: 'x.' })
}

test('refuses history in an added comment and says where it belongs', () => {
  const verdict = commented('/** #154: reap on land */')
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['src/x.ts:1 tight.history'])
  expect(verdict.message).toContain('commit message')
})

test('passes the same comment without its history', () => {
  expect(commented('/** Reap on land. */').spans).toEqual([])
})

test('passes a history comment on a line the diff did not add', () => {
  const source = '// #154: reap on land\nexport const x = 1\n'
  const diff = '--- a/src/old.ts\n+++ b/src/old.ts\n@@ -1,2 +1,2 @@\n // #154: reap on land\n-export const x = 0\n+export const x = 1\n'
  expect(tight(root, { diff, sources: { 'src/old.ts': source }, description: 'x.' }).outcome).toBe('pass')
})

test('refuses each form of history', () => {
  for (const comment of ['// 2026-09-24', '// 09-24', '// asked by the CEO', '// COO call', '// plan 47']) {
    expect(commented(comment).spans).toEqual(['src/x.ts:1 tight.history'])
  }
})

test('passes ranges, bare hashes, the word plan and history in a string', () => {
  for (const comment of ['// ports 80-99', '// the #private field', '// the plan holds']) {
    expect(commented(comment).spans).toEqual([])
  }
  expect(commented('', "export const s = '#154 09-24'").spans).toEqual([])
})

const moved = (removed: string, source: string): string[] => {
  const gone = removed.split('\n')
  const diff = `--- a/src/a.ts\n+++ /dev/null\n@@ -1,${String(gone.length)} +0,0 @@\n${gone.map((l) => `-${l}`).join('\n')}\n${added('src/b.ts', source)}`
  return tight(root, { diff, sources: { 'src/b.ts': source }, description: 'x.' }).spans
}

const within = (comment: string): string[] => {
  const source = `export const reap = 1\n${comment}\nexport const sow = 2\n`
  const diff = `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,4 +1,4 @@\n-/** #154: reap\n- * on land */\n export const reap = 1\n+${comment.replace('\n', '\n+')}\n export const sow = 2\n`
  return tight(root, { diff, sources: { 'src/a.ts': source }, description: 'x.' }).spans
}

test('passes a comment moved unchanged to another file', () => {
  for (const source of ['/** #154: reap on land */\nexport const reap = 1', '// step count\nexport const stepCount = 1']) {
    expect(moved(source, source)).toEqual([])
  }
})

test('passes a block comment moved unchanged within its file', () => {
  expect(within('/** #154: reap\n * on land */')).toEqual([])
})

test('refuses a moved comment with one word changed', () => {
  expect(within('/** #154: reap\n * at land */')).toEqual(['src/a.ts:2 tight.history'])
  expect(moved('// step count\nexport const stepCount = 1', '// step total\nexport const stepTotal = 1')).toEqual(['src/b.ts:1 tight.restating'])
})

test('judges an unused import moved verbatim', () => {
  const line = "import { join } from 'node:path'"
  expect(moved(line, `${line}\nexport const x = 1`)).toEqual(['src/b.ts:1 tight.unused_import'])
})

test('a prose span is named for the text it read', () => {
  const verdict = tight(root, { ...subject('red'), prose: 'handback' })
  expect(verdict.spans.filter((s) => !s.startsWith('src/'))).toEqual(['handback:1 tight.preamble', 'handback:3 tight.hedge', 'handback:3 tight.summary'])
})
