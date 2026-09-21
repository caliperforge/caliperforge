import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, test } from 'vitest'
import { dryLines, tickNote } from '../../cli/brief.ts'
import { held, holder, take } from '../../store/leases.ts'
import { last, receipt } from '../../store/ticks.ts'
import { dry, tick } from '../index.ts'
import { CARRIED, inFlight, internalPlan, ours, plan, stub, world, type World } from './world.ts'

const repo = join(import.meta.dirname, '../..')

const ID = 2
const SECOND = 3
const THIRD = 4

/** Our own issue alone in the one lane, walked to the build step, where a seat is what takes the time. */
async function built(): Promise<World> {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  return w
}

test('two ticks started together step the plan once and the loser leaves no run row', async () => {
  const w = await built()
  const first = inFlight(w)
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  expect((await first).map((f) => f.plan)).toEqual([ID])
  expect(w.db.prepare('SELECT count(*) AS n FROM runs WHERE step = 2').get()).toEqual({ n: 1 })
  expect(plan(w.db, ID).step).toBe(3)
  expect(held(w.db)).toEqual([])
})

test('take loses to a live holder and wins against a lease past the ceiling', async () => {
  const w = await built()
  const now = new Date()
  expect(take(w.db, ID, now)).toMatchObject({ plan: ID, pid: process.pid, stole: null })
  expect(take(w.db, ID, now)).toBeNull()
  expect(holder(w.db, ID, now)).toMatchObject({ pid: process.pid, taken_at: now.toISOString() })

  w.db.prepare('UPDATE leases SET taken_at = ? WHERE plan = ?')
    .run(new Date(now.getTime() - 4 * 3600_000).toISOString(), ID)
  expect(held(w.db, now)).toEqual([])
  expect(take(w.db, ID, now)).toMatchObject({ stole: process.pid })
})

test('a lease whose holder is gone is taken over, and the tick receipt names the pid it took it from', async () => {
  const w = await built()
  const dead = spawnSync('/usr/bin/true').pid
  w.db.prepare('INSERT INTO leases (plan, pid, taken_at) VALUES (?, ?, ?)')
    .run(ID, dead, new Date().toISOString())
  expect(held(w.db)).toEqual([])

  const fired = await tick(w.db, w.root, stub(CARRIED))
  expect(fired.map((f) => f.plan)).toEqual([ID])
  expect(tickNote(fired)).toContain(`took over pid ${String(dead)}`)
  expect(held(w.db)).toEqual([])
})

test('a slow seat holds one slot, a second tick takes the next, and the pipe width holds across them', async () => {
  const w = await built()
  w.db.prepare('UPDATE pipes SET max_concurrent = 2 WHERE id = 1').run()
  const building = inFlight(w, 1500)
  internalPlan(w.db, w.root, SECOND, 'a second internal plan', 35)
  internalPlan(w.db, w.root, THIRD, 'a third internal plan', 36)

  const second = await tick(w.db, w.root, stub(CARRIED))
  expect(second.map((f) => f.plan)).toEqual([SECOND])
  expect(held(w.db).map((l) => l.plan)).toEqual([ID])
  expect([...(await building), ...second].map((f) => f.plan)).toEqual([ID, SECOND])
  expect(plan(w.db, THIRD).step).toBe(0)
})

test('a tick with nothing unheld to step writes a receipt of 0 and exits 0', async () => {
  const w = await built()
  take(w.db, ID)
  const fired = await tick(w.db, w.root, stub(CARRIED))
  expect(fired).toEqual([])
  receipt(w.db, { at: new Date().toISOString(), hhmm: '09:00', dry: false, pipes: 1, fired: fired.length,
    exit: fired.some((f) => f.outcome === 'refuse') ? 1 : 0, note: tickNote(fired) })
  expect(last(w.db)[0]).toMatchObject({ fired: 0, exit: 0, note: 'nothing to fire' })
})

test('a dry tick writes no lease of its own and names the pid holding each plan', async () => {
  const w = await built()
  const now = new Date()
  take(w.db, ID, now)
  const would = dry(w.db, now)
  expect(would.would).toEqual([])
  expect(would.held).toEqual([{ plan: ID, pid: process.pid, taken_at: now.toISOString() }])
  expect(dryLines(would)).toContain(`  plan ${String(ID)}\tleased by pid ${String(process.pid)}\t`)
  expect(w.db.prepare('SELECT count(*) AS n FROM leases').get()).toEqual({ n: 1 })
})

test('the plist runs tick.sh, which returns before the tick it starts finishes', async () => {
  expect(readFileSync(join(repo, 'launchd/com.caliperforge.tick.plist'), 'utf8'))
    .toContain('<string>/Users/michael/cf_v2/launchd/tick.sh</string>')
  const dir = mkdtempSync(join(tmpdir(), 'cf-tick-'))
  const fired = join(dir, 'fired')
  for (const sub of ['launchd', 'cli']) mkdirSync(join(dir, sub))
  cpSync(join(repo, 'launchd/tick.sh'), join(dir, 'launchd/tick.sh'))
  writeFileSync(join(dir, 'cli/cf.ts'),
    `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(fired)}, 'fired') }, 600)\n`)

  const began = Date.now()
  execFileSync('/bin/sh', [join(dir, 'launchd/tick.sh')])
  expect(Date.now() - began).toBeLessThan(600)
  expect(existsSync(fired)).toBe(false)
  await sleep(2000)
  expect(readFileSync(fired, 'utf8')).toBe('fired')
})
