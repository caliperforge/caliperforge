import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { migrate, open, type Db } from '../../store/index.ts'
import { receipt } from '../../store/ticks.ts'
import { unread } from '../inbox.ts'
import { CRASHED, down, liveness, livenessLine, watch } from '../watch.ts'

const schema = join(import.meta.dirname, '../../schema')

vi.mock('playwright-core', () => { throw new Error('playwright-core failed to load') })
vi.mock('../../sequencer/workspace.ts', () => { throw new Error('sequencer/workspace.ts failed to load') })
vi.mock('../../templates/pr-path.ts', () => { throw new Error('templates/pr-path.ts failed to load') })

// 14:00Z is 08:00 in Guatemala, inside every pipe's 07:00 to 22:00 window.
const NOW = new Date('2026-09-25T14:00:00.000Z')

function world(open = true): Db {
  const db = fresh(schema)
  db.prepare('UPDATE pipes SET enabled = ?').run(Number(open))
  db.prepare("UPDATE settings SET value = '-360' WHERE key = 'tick.zone_offset_minutes'").run()
  return db
}

function tickAt(db: Db, minutesAgo: number, note = 'nothing to fire', dry = false): void {
  const at = new Date(NOW.getTime() - minutesAgo * 60000).toISOString()
  receipt(db, { at, hhmm: '08:00', dry, pipes: 1, fired: 0, exit: 0, note })
}

interface Row { fired: number; exit: number; note: string }

const NORMAL = { fired: 0, exit: 0, note: 'nothing to fire' }
const HALT = { fired: 0, exit: 1, note: 'live tree is behind 0123456789ab; it fires nothing until it holds that commit' }
const REFUSED = { fired: 2, exit: 1, note: 'refused' }
const CRASH = { fired: 0, exit: 1, note: `${CRASHED}tick failed` }

/** One receipt a minute, the last `ago` minutes before NOW. */
function receipts(db: Db, rows: Row[], ago = 0): void {
  rows.forEach((row, i) => {
    const at = new Date(NOW.getTime() - (ago + rows.length - 1 - i) * 60000).toISOString()
    receipt(db, { at, hhmm: '08:00', dry: false, pipes: 1, ...row })
  })
}

function halts(n: number): Row[] {
  return Array.from({ length: n }, () => HALT)
}

function watched(rows: Row[]): string[] {
  const db = world()
  const root = mkdtempSync(join(tmpdir(), 'cf-halt-'))
  const posted: string[] = []
  receipts(db, rows)
  watch(db, root, NOW, (title) => void posted.push(title))
  watch(db, root, NOW, (title) => void posted.push(title))
  return posted
}

test('haltAlerts', () => {
  expect(watched(halts(30))).toEqual(['CaliperForge · the tick is halted'])
  expect(watched([NORMAL, ...halts(29)])).toEqual([])
  expect(watched([...halts(15), REFUSED, ...halts(14)])).toEqual([])
  expect(watched([...halts(15), CRASH, ...halts(14)])).toEqual([])
})

test('haltClears', () => {
  const db = world()
  const root = mkdtempSync(join(tmpdir(), 'cf-halt-'))
  const posted: string[] = []
  const post = (title: string): void => void posted.push(title)
  receipts(db, halts(30), 1)
  watch(db, root, NOW, post)
  receipts(db, [NORMAL])
  watch(db, root, NOW, post)
  watch(db, root, NOW, post)
  expect(posted).toEqual(['CaliperForge · the tick is halted', 'CaliperForge · the tick is firing again'])
  expect(existsSync(join(root, '.cf/watch.halted'))).toBe(false)
})

test('crashUnchanged', () => {
  expect(watched(Array.from({ length: 30 }, () => CRASH))).toEqual(['CaliperForge · the machine is down'])
  const db = world()
  receipts(db, [CRASH])
  expect(liveness(db, NOW).crash).toBe('tick failed')
})

test('tickLogs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-ticklog-'))
  for (const sub of ['launchd', 'cli', '.cf']) mkdirSync(join(dir, sub))
  cpSync(join(import.meta.dirname, '../../launchd/tick.sh'), join(dir, 'launchd/tick.sh'))
  writeFileSync(join(dir, 'cli/cf.ts'), "process.stderr.write('stub tick failed\\n')\n")
  const log = join(dir, '.cf/tick.log')
  writeFileSync(log, 'line\n'.repeat(6000))
  execFileSync('/bin/sh', [join(dir, 'launchd/tick.sh')])
  const lines = (): string[] => readFileSync(log, 'utf8').trimEnd().split('\n')
  await expect.poll(() => lines().at(-1), { timeout: 5000 }).toBe('stub tick failed')
  expect(lines().length).toBeLessThanOrEqual(5001)
})

test('watchLoadsAlone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-watch-main-'))
  cpSync(schema, join(dir, 'schema'), { recursive: true })
  const db = open(join(dir, 'cf.db'))
  migrate(db, join(dir, 'schema'))
  db.exec("UPDATE pipes SET enabled = 1, window_start = '00:00', window_end = '23:59'")
  receipt(db, { at: new Date(Date.now() - 20 * 60000).toISOString(), hhmm: '00:00', dry: false, pipes: 1, fired: 0, exit: 0, note: 'nothing to fire' })
  db.close()
  vi.spyOn(process, 'cwd').mockReturnValue(dir)
  await import('../watch-main.ts')
  expect(existsSync(join(dir, '.cf/watch.alerted'))).toBe(true)
})

test('a real tick a minute ago is alive', () => {
  const db = world()
  tickAt(db, 1)
  expect(liveness(db, NOW)).toMatchObject({ minutes: 1, crash: null, stale: false })
})

test('eleven quiet minutes in an open window is down', () => {
  const db = world()
  tickAt(db, 11)
  tickAt(db, 0, 'dry', true)
  expect(liveness(db, NOW).stale).toBe(true)
})

test('a closed window is never down', () => {
  const db = world(false)
  tickAt(db, 600)
  expect(liveness(db, NOW).stale).toBe(false)
})

test('a crash receipt is down at once and names the error', () => {
  const db = world()
  tickAt(db, 0, `${CRASHED}Command failed: git diff c25df73`)
  const l = liveness(db, NOW)
  expect(l.stale).toBe(true)
  expect(livenessLine(db, l)).toContain('crashed: Command failed: git diff c25df73')
})

test('a stall alerts once, and its end alerts once', () => {
  const db = world()
  const root = mkdtempSync(join(tmpdir(), 'cf-watch-'))
  const posted: string[] = []
  const post = (title: string): void => void posted.push(title)
  tickAt(db, 20)
  watch(db, root, NOW, post)
  watch(db, root, NOW, post)
  expect(posted).toEqual(['CaliperForge · the machine is down'])
  tickAt(db, 0)
  watch(db, root, NOW, post)
  expect(posted.at(-1)).toBe('CaliperForge · the machine is running again')
  expect(existsSync(join(root, '.cf/watch.alerted'))).toBe(false)
})

test('a reporter whose store fails records that in the inbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-down-'))
  down(() => { throw new Error('store gone') }, root, NOW, new Error('tick failed'), () => undefined)
  expect(unread(root)).toEqual([expect.objectContaining({ kind: 'crashed', note: 'store gone' })])
})

test('a reporter with a store leaves a crash receipt and alerts', () => {
  const db = world()
  const root = mkdtempSync(join(tmpdir(), 'cf-down-'))
  const posted: string[] = []
  down(() => db, root, NOW, new Error('tick failed'), (title) => void posted.push(title))
  expect(liveness(db, NOW).crash).toBe('tick failed')
  expect(posted).toEqual(['CaliperForge · the machine is down'])
  expect(unread(root)).toEqual([])
})

test('a lane off with jobs alerts once, not again until back on', () => {
  const db = world()
  const root = mkdtempSync(join(tmpdir(), 'cf-lanes-'))
  tickAt(db, 0)
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, step, lane, seat, origin)
    SELECT 1, id, 'pr_path', 'running', '2026-09-25', 2, 'machine', 'typescript_specialist', 'https://github.com/caliperforge/caliperforge/issues/1' FROM pipes WHERE name = 'pr-path'`).run()
  db.prepare("UPDATE pipes SET enabled = 0 WHERE name = 'pr-path'").run()
  const posted: string[] = []
  const post = (title: string, body: string): void => void posted.push(`${title}: ${body}`)
  watch(db, root, NOW, post)
  watch(db, root, NOW, post)
  expect(posted).toHaveLength(1)
  expect(posted[0]).toContain('pr-path (1 job waiting)')
  db.prepare("UPDATE pipes SET enabled = 1 WHERE name = 'pr-path'").run()
  watch(db, root, NOW, post)
  expect(existsSync(join(root, '.cf/watch.lanes'))).toBe(false)
})
