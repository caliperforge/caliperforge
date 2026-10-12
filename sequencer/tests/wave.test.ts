import { cpSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { fill } from '../../cli/digests.ts'
import type { Read, Run } from '../../cli/gh.ts'
import { all } from '../../cli/inbox.ts'
import type { Provider } from '../../providers/kind.ts'
import { load } from '../../runner/rules.ts'
import { logged, ofKind } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { addPipe, allPlans } from '../../store/plans.ts'
import { lastLogged } from '../../store/wave.ts'
import { intake } from '../capture.ts'
import { closing } from '../wave.ts'

const repo = join(import.meta.dirname, '../..')
const schema = join(repo, 'schema')
const REPO = 'caliperforge/atelier-web'
const NOW = new Date('2026-10-05T09:00:00.000Z')

// headless launches chromium-headless-shell, whose path executablePath() does not report
const missing = await chromium.launch({ headless: true }).then(
  async (browser) => { await browser.close(); return null },
  (e: unknown) => `no Chromium: ${String(e).split('\n')[0] ?? ''}`,
)

interface Fixture { number: number; wave: number; closedAt?: string }

const shape = (r: Fixture) => ({ number: r.number, title: `issue ${String(r.number)}`, body: 'the ask',
  url: `https://github.com/${REPO}/issues/${String(r.number)}`, labels: [{ name: 'lane:atelier' }, { name: `wave:${String(r.wave)}` }],
  createdAt: '2026-09-20T09:00:00Z', closedAt: r.closedAt ?? null, stateReason: null })

function canned(open: Fixture[], closed: Fixture[] = [], log: string[] = [], design = true, first: number[] = []): Read {
  return (args) => {
    log.push(args.join(' '))
    if (args[1] === `repos/${REPO}/contents?ref=main`) return [{ path: design ? 'DESIGN.md' : 'index.html' }]
    if (args.includes('seat:design_lead')) return first.map((number) => ({ number }))
    if (args[1] === 'list') return (args[5] === 'closed' ? closed : open).map(shape)
    if (args[0] === 'api') return { sub_issues_summary: { total: 0 } }
    const hit = open.map(shape).find((r) => String(r.number) === args[2])
    if (args.at(-1) === 'state,comments') return { state: 'OPEN', comments: [] }
    if (hit === undefined) throw new Error(`no fixture for ${args.join(' ')}`)
    return hit
  }
}

function piped(enabled = 1): Db {
  const db = fresh(schema)
  addPipe(db, { name: 'atelier', enabled, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  return db
}

const passed = (db: Db, outcome: 'pass' | 'refuse' | 'needs_ceo', at = '2026-10-02T09:00:00.000Z'): void => {
  logged(db, { plan: null, kind: 'wave', actor: 'design_lead', outcome, message: '', pointer: 'wave 1', run: null }, at)
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'cf-wave-'))

const FILED = `https://github.com/${REPO}/issues/30`

function filer(calls: string[][]): Run {
  return (args) => {
    calls.push(args)
    return `${FILED}\n`
  }
}

function stub(fires: string[], text = '---\noutcome: pass\n---\n'): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => {
      fires.push(packet.prompt)
      return Promise.resolve({ text, transcript_path: packet.transcript, usage: { input: 1, cache: 0, output: 1 }, seconds: 0,
        ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

function seeded(): { db: Db; home: string } {
  const db = piped()
  const home = tmp()
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(home, dir), { recursive: true })
  cpSync(join(repo, 'rules.seed.sql'), join(home, 'rules.seed.sql'))
  fill(home, '2026-10-05')
  load(db, home)
  return { db, home }
}

function web(body = '<h1>Plans</h1>'): string {
  const dir = tmp()
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`)
  return dir
}

const WAVE_ONE = [{ number: 10, wave: 1, closedAt: '2026-10-01T09:00:00Z' }]

const browsed = (name: string, fn: () => Promise<void>): void => {
  test(name, { timeout: 60_000 }, async ({ skip }) => {
    if (missing !== null) skip(missing)
    await fn()
  })
}

test('D1: a wave:2 ticket waits with no wave 1 event', () => {
  const db = piped()
  intake(db, tmp(), canned([{ number: 20, wave: 2 }]))
  expect(allPlans(db)).toEqual([])
})

test('D2: a refused or needs_ceo wave 1 holds wave:2', () => {
  const db = piped()
  for (const outcome of ['refuse', 'needs_ceo'] as const) {
    passed(db, outcome)
    intake(db, tmp(), canned([{ number: 20, wave: 2 }]))
    expect(allPlans(db)).toEqual([])
  }
})

test('D3: a passed wave 1 releases wave:2; wave:1 never waits', () => {
  const db = piped()
  const root = tmp()
  intake(db, root, canned([{ number: 19, wave: 1 }, { number: 20, wave: 2 }]))
  expect(allPlans(db).map((p) => p.origin)).toEqual([`https://github.com/${REPO}/issues/19`])
  passed(db, 'pass')
  intake(db, root, canned([{ number: 19, wave: 1 }, { number: 20, wave: 2 }]))
  expect(allPlans(db).map((p) => p.origin)).toEqual([19, 20].map((n) => `https://github.com/${REPO}/issues/${String(n)}`))
})

test('D4: no fire on an off pipe, an open ticket or a newer event', async () => {
  const fires: string[] = []
  const log: string[] = []
  const calls: string[][] = []
  expect(await closing(piped(0), tmp(), stub(fires), canned([], WAVE_ONE, log, false), NOW, web(), filer(calls))).toEqual([])
  expect(log).toEqual([])
  expect(calls).toEqual([])
  expect(await closing(piped(), tmp(), stub(fires), canned([{ number: 11, wave: 1 }], WAVE_ONE), NOW, web())).toEqual([])
  const db = piped()
  passed(db, 'refuse')
  expect(await closing(db, tmp(), stub(fires), canned([], WAVE_ONE), NOW, web())).toEqual([])
  expect(fires).toEqual([])
})

test('first pass D1: no DESIGN.md and no issue files one', async () => {
  const calls: string[][] = []
  expect(await closing(piped(), tmp(), stub([]), canned([], [], [], false), NOW, tmp(), filer(calls))).toEqual([`first pass: ${FILED}`])
  const created = calls.filter((c) => c[0] === 'issue' && c[1] === 'create')
  expect(created).toHaveLength(1)
  expect(created[0]?.join(' ')).toContain('--label lane:atelier --label seat:design_lead')
})

test('first pass D2: DESIGN.md on main files nothing', async () => {
  const calls: string[][] = []
  expect(await closing(piped(), tmp(), stub([]), canned([]), NOW, tmp(), filer(calls))).toEqual([])
  expect(calls).toEqual([])
})

test('first pass D3: an open or closed first pass files nothing', async () => {
  const calls: string[][] = []
  expect(await closing(piped(), tmp(), stub([]), canned([], [], [], false, [7]), NOW, tmp(), filer(calls))).toEqual([])
  expect(calls).toEqual([])
})

test('first pass D5: a failed issue create is one wave line', async () => {
  const db = piped()
  const exec: Run = (args) => {
    if (args[0] === 'issue') throw new Error('gh: HTTP 502')
    return ''
  }
  expect(await closing(db, tmp(), stub([]), canned([], [], [], false), NOW, tmp(), exec)).toEqual(['wave: gh: HTTP 502'])
  expect(ofKind(db, 'swallowed')).toMatchObject([{ actor: 'wave', message: 'wave: gh: HTTP 502' }])
})

browsed('D4: a wave:1 close after the last pass fires again', async () => {
  const { db, home } = seeded()
  passed(db, 'refuse')
  const fires: string[] = []
  await closing(db, home, stub(fires), canned([], [...WAVE_ONE, { number: 11, wave: 1, closedAt: '2026-10-03T09:00:00Z' }]), NOW, web())
  expect(fires).toHaveLength(1)
})

browsed('D5: a pass leaves four PNGs and one wave event', async () => {
  const { db, home } = seeded()
  expect(await closing(db, home, stub([]), canned([], WAVE_ONE), NOW, web())).toEqual(['wave 1 pass'])
  const dir = join(home, '.cf/waves/1/design')
  const pngs = readdirSync(dir)
  expect(pngs).toHaveLength(4)
  const events = all(home)
  expect(events).toMatchObject([{ kind: 'wave', ticket: 'wave 1', plan: 0 }])
  for (const name of [dir, ...pngs]) expect(events[0]?.note).toContain(name)
  expect(lastLogged(db, 'wave', 'wave 1')?.outcome).toBe('pass')
})

browsed('D6: a design span refuses over a pass fence', async () => {
  const { db, home } = seeded()
  await closing(db, home, stub([]), canned([], WAVE_ONE), NOW, web('<table style="width:1200px"><tr><td>wide</td></tr></table>'))
  expect(lastLogged(db, 'wave', 'wave 1')?.outcome).toBe('refuse')
  expect(all(home)).toMatchObject([{ kind: 'refused', ticket: 'wave 1' }])
  expect(all(home)[0]?.note).toContain('index.html design.overflow 400 light')
})

browsed('D6: a fence refuse in the asked shape refuses', async () => {
  const { db, home } = seeded()
  const reply = '---\noutcome: refuse\nclass: drift\nspans:\n  - "index.html: the status pill differs from plans.html"\n---\n'
  await closing(db, home, stub([], reply), canned([], WAVE_ONE), NOW, web())
  expect(lastLogged(db, 'wave', 'wave 1')?.outcome).toBe('refuse')
  expect(all(home)).toMatchObject([{ kind: 'refused', ticket: 'wave 1' }])
  expect(all(home)[0]?.note).toContain('index.html: the status pill differs from plans.html')
})

browsed('D7: a reply with no fence is needs_ceo and blocked', async () => {
  const { db, home } = seeded()
  await closing(db, home, stub([], 'looks fine'), canned([], WAVE_ONE), NOW, web())
  expect(lastLogged(db, 'wave', 'wave 1')?.outcome).toBe('needs_ceo')
  expect(all(home)).toMatchObject([{ kind: 'blocked', ticket: 'wave 1' }])
})
