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

it('D2 a raise not whole or under budget lifts nothing', () => {
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

it('act.ts to brief.ts meet their ratchet rows', () => {
  const paths = ['sequencer/act.ts', 'sequencer/approve.ts', 'sequencer/base.ts', 'sequencer/brief.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('capture.ts to coolite.ts meet their ratchet rows', () => {
  const paths = ['sequencer/capture.ts', 'sequencer/checks.ts', 'sequencer/ci.ts', 'sequencer/coolite.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('seat.ts to signals.ts meet their ratchet rows', () => {
  const paths = ['sequencer/seat.ts', 'sequencer/settle.ts', 'sequencer/signals.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('signoff.ts to steps.ts meet their ratchet rows', () => {
  const paths = ['sequencer/signoff.ts', 'sequencer/split.ts', 'sequencer/steps.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('theirs.ts to workspace.ts meet their ratchet rows', () => {
  const paths = ['sequencer/theirs.ts', 'sequencer/upgrade.ts', 'sequencer/workspace.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('approvals.ts to files.ts meet their ratchet rows', () => {
  const paths = ['store/approvals.ts', 'store/decisions.ts', 'store/deliverables.ts', 'store/files.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('holds.ts to merges.ts meet their ratchet rows', () => {
  const paths = ['store/holds.ts', 'store/lanes.ts', 'store/leases.ts', 'store/merges.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('plans.ts to refusals.ts meet their ratchet rows', () => {
  const paths = ['store/plans.ts', 'store/proposals.ts', 'store/refusals.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('batch.ts to gh.ts meet their ratchet rows', () => {
  const paths = ['cli/batch.ts', 'cli/brief.ts', 'cli/cf.ts', 'cli/gh.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('inbox.ts to watch.ts meet their ratchet rows', () => {
  const paths = ['cli/inbox.ts', 'cli/map.ts', 'cli/queue.ts', 'cli/watch.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('providers meet their ratchet rows', () => {
  const paths = ['providers/claude-agent-sdk/index.ts', 'providers/credential.ts', 'providers/kind.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('ready and tight/source meet their ratchet rows', () => {
  const paths = ['rails/ready/index.ts', 'rails/tight/source.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('index.ts to wake.ts meet their ratchet rows', () => {
  const paths = ['runner/index.ts', 'runner/packet.ts', 'runner/wake.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('pr-path.ts and vitest.config.ts meet their ratchet rows', () => {
  const paths = ['templates/pr-path.ts', 'vitest.config.ts']
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => paths.includes(f.path))).toEqual([])
})

it('sequencer/tests/ meets its ratchet rows', () => {
  expect(ratcheted(join(import.meta.dirname, '..'), {}).filter((f) => f.path.startsWith('sequencer/tests/'))).toEqual([])
})
