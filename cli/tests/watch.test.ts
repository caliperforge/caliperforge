import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { receipt } from '../../store/ticks.ts'
import { CRASHED, liveness, livenessLine, watch } from '../watch.ts'

const schema = join(import.meta.dirname, '../../schema')

// 14:00Z is 08:00 in Guatemala, inside every pipe's 07:00-22:00 window.
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

test('a lane switched off with jobs in it alerts once, and not again until it is back on', () => {
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
