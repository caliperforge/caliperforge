import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { ratchet, ratcheted, type Counts } from './ratchet.ts'

function tree(files: Record<string, string>, seed: Counts): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-ratchet-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  record(dir, seed)
  return dir
}

function record(dir: string, seed: Counts): void {
  writeFileSync(join(dir, 'ratchet.json'), JSON.stringify(seed))
}

async function messages(dir: string): Promise<string[]> {
  return (await ratchet.run(dir)).map((f) => f.message)
}

it('refuses a file grown past its budget, and a new one past 300', async () => {
  const dir = tree({ 'a.ts': 'x\n'.repeat(41), 'b.ts': 'x\n'.repeat(301) }, { 'a.ts': { lines: 10 } })
  expect(await messages(dir)).toEqual([
    'a.ts lines 41 over budget 40: move the new function to a new file',
    'b.ts lines 301 over budget 300: move the new function to a new file',
  ])
})

it('refuses db.prepare( in sequencer/ but not in store/', async () => {
  const query = 'db.prepare(\'SELECT 1\')\n'
  const dir = tree({ 'sequencer/x.ts': query, 'store/x.ts': query }, {})
  expect(await messages(dir)).toEqual(['sequencer/x.ts prepare 1 over budget 0: move the query into store/'])
})

it('refuses a silent catch, not one that throws or logs', async () => {
  const dir = tree({
    'a.ts': 'try { f() } catch { return null }\n',
    'b.ts': 'try { f() } catch (e) { throw e }\ntry { f() } catch { logged(db, e) }\n',
  }, {})
  expect(await messages(dir)).toEqual(['a.ts silent-catch 1 over budget 0: rethrow or record an event with logged()'])
})

it('refuses a removal until ratchet.json is lowered', async () => {
  const dir = tree({ 'sequencer/x.ts': 'x\n' }, { 'sequencer/x.ts': { lines: 1, prepare: 1 } })
  expect(await messages(dir)).toEqual(['lower ratchet.json sequencer/x.ts prepare to 0'])
  record(dir, { 'sequencer/x.ts': { lines: 1 } })
  expect(await messages(dir)).toEqual([])
})

const GROWN = 'a.ts lines 41 over budget 40: move the new function to a new file'

it('D1 a raise lifts only the file it names', () => {
  const dir = tree({ 'a.ts': 'x\n'.repeat(60), 'b.ts': 'x\n'.repeat(41) }, { 'a.ts': { lines: 10 }, 'b.ts': { lines: 10 } })
  expect(ratcheted(dir, { 'ratchet.raise.lines.a.ts': 60 }).map((f) => f.message))
    .toEqual([GROWN.replace('a.ts', 'b.ts')])
})

it('D2 a raise that is not a whole number or is under budget lifts nothing', () => {
  const dir = tree({ 'a.ts': 'x\n'.repeat(41) }, { 'a.ts': { lines: 10 } })
  for (const raise of [Number('abc'), 20]) {
    expect(ratcheted(dir, { 'ratchet.raise.lines.a.ts': raise }).map((f) => f.message)).toEqual([GROWN])
  }
})

it('refuses a long test name and citing comments', async () => {
  const dir = tree({
    'a.test.ts': 'it(\'' + 'n'.repeat(61) + '\', () => {})\n',
    'b.ts': '// #123\n// 2026-09-26\n// the CEO\n// the COO\n// plan 62\n',
  }, {})
  expect(await messages(dir)).toEqual([
    'a.test.ts test-name 1 over budget 0: shorten the test name to 60 characters',
    'b.ts citing-comment 5 over budget 0: drop the ticket, date, name or plan number from the comment',
  ])
})
