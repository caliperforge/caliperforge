import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { eventsOf } from '../../store/events.ts'
import { rewind } from '../../store/plans.ts'
import { refusalRows } from '../../store/refusals.ts'
import { at } from '../../templates/pr-path.ts'
import { tick } from '../index.ts'
import { HELD, thrown } from '../settle.ts'
import { checkout, planDir } from '../workspace.ts'
import { approve, CARRIED, plan, stub, watched, world } from './world.ts'

const FETCH = "Command failed: git fetch --no-tags origin +main:refs/remotes/origin/main\nfatal: unable to access 'https://github.com/caliperforge/caliperforge.git/': Could not resolve host: github.com"

test('offline throw holds the step', () => {
  expect(thrown(at(3), FETCH)).toMatchObject({ outcome: 'pass', held: true, spans: ['offline'] })
  expect(thrown(at(2), 'getaddrinfo ENOTFOUND api.anthropic.com')).toMatchObject({ held: true })
})

test('a locked store holds the step', () => {
  const out = thrown(at(4), 'database is locked')
  expect(out).toMatchObject({ outcome: 'pass', held: true, spans: ['locked'] })
  expect(out.note.endsWith(HELD)).toBe(true)
})

test('an api_error stop holds the step', async () => {
  const w = world()
  approve(w.db, w.target)
  const inner = stub(CARRIED)
  const down = { ...inner, fire: async (packet: Packet) => {
    const out = await inner.fire(packet)
    return packet.tools.includes('Write') ? { ...out, ended: 'stopped' as const, exit: 1, stop_reason: 'api_error' } : out
  } }
  const fired = await tick(w.db, w.root, down, undefined, undefined, watched([], w.root, 1), 5)
  expect(fired.at(-1)).toMatchObject({ step: 2, held: true })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, state: 'running' })
  expect(refusalRows(w.db, 1)).toEqual([])
})

async function reviewThrows(message: string): Promise<{ w: ReturnType<typeof world>; fired: unknown }> {
  const w = world()
  approve(w.db, w.target)
  const wire = watched([], w.root, 1)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  const inner = stub(CARRIED)
  const throwing = { ...inner, fire: async (packet: Packet) => {
    if (!packet.tools.includes('Write')) throw new Error(message)
    return inner.fire(packet)
  } }
  return { w, fired: (await tick(w.db, w.root, throwing))[0] }
}

test('a locked store during review holds step 4', async () => {
  const { w, fired } = await reviewThrows('database is locked')
  expect(fired).toMatchObject({ step: 4, held: true, spans: ['locked'] })
  expect(plan(w.db, 1)).toMatchObject({ step: 4, state: 'running' })
  expect(refusalRows(w.db, 1)).toEqual([])
})

test('any other review throw still refuses', async () => {
  const { fired } = await reviewThrows('boom')
  expect(fired).toMatchObject({ step: 4, outcome: 'refuse', spans: ['reviewers.verdict_fence'] })
})

test('1567a D4 a thrown step logs swallowed, a lock does not', async () => {
  const w = world()
  approve(w.db, w.target)
  await tick(w.db, w.root, stub(CARRIED))
  const [fired] = await tick(w.db, w.root, { ...stub(CARRIED), fire: () => Promise.reject(new Error('boom')) })
  expect(fired).toMatchObject({ step: 1, outcome: 'refuse', spans: ['threw: boom'] })
  expect(eventsOf(w.db, 1, 'swallowed')).toEqual([{ actor: 'made', outcome: 'pass', message: 'boom' }])
  expect(eventsOf((await reviewThrows('database is locked')).w.db, 1, 'swallowed')).toEqual([])
})

test('1567a D3 a failed checkout logs swallowed', async () => {
  const w = world()
  approve(w.db, w.target)
  await tick(w.db, w.root, stub(CARRIED))
  writeFileSync(join(planDir(w.root, 1), 'src'), '')
  const [fired] = await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  expect(fired).toMatchObject({ step: 1, outcome: 'refuse', state: 'running', spans: ['acme/widget'] })
  const swallowed = eventsOf(w.db, 1, 'swallowed')
  expect(swallowed.map((e) => e.actor)).toEqual(['workspace'])
  expect(swallowed[0]?.message).toContain('EEXIST')
})

const GPG = 'Command failed: git commit -S\ngpg: Note: database_open 134217901 waiting for lock (held by 98937) ...\ngpg: keydb_search failed: Operation timed out\ngpg: signing failed: Operation timed out'

test('a gpg key database lock asks a person', () => {
  const out = thrown(at(6), GPG)
  expect(out).toMatchObject({ outcome: 'needs_ceo', spans: ['gpg'], message: GPG })
  expect(out.note).toMatch(/^step 6 ready: gpg waited on a key database lock held by pid 98937 \((running|gone)\); likely ~\/\.gnupg\/public-keys\.d\/pubring\.db\.lock$/)
})

test('1558b D1 a kernel step throw is a machine fault', () => {
  expect(thrown(at(3), 'spawnSync gh ENOBUFS')).toMatchObject({ outcome: 'needs_ceo',
    spans: ['machine_fault', 'threw: spawnSync gh ENOBUFS'], note: 'step 3 rails threw: spawnSync gh ENOBUFS' })
})

test('1558b D2 a rails throw asks the director once', { timeout: 60_000 }, async () => {
  const w = world()
  checkout(w.root, 1, 'acme/widget', 'widget-12-a1')
  approve(w.db, 1)
  rewind(w.db, 1, 3)
  const [fired] = await tick(w.db, w.root, stub(CARRIED))
  expect(plan(w.db, 1)).toMatchObject({ step: 3, state: 'blocked_on_ceo' })
  expect(fired).toMatchObject({ outcome: 'needs_ceo' })
  expect(fired?.spans).toContain('machine_fault')
  expect(refusalRows(w.db, 1)).toEqual([])
})

const GH = 'Command failed: gh pr list --repo acme/widget --state open --limit 100 --json number\nHTTP 502: Bad Gateway'

test('1822 D1 a kernel step gh throw is a blip', () => {
  const out = thrown(at(6), GH)
  expect(out).toMatchObject({ outcome: 'refuse', blip: true })
  expect(out.spans[0]).toMatch(/^threw: Command failed: gh pr list/)
  expect(out.note.endsWith(HELD)).toBe(true)
})

test('1822 D4 a seat gh throw and ENOBUFS are unchanged', () => {
  const seat = thrown(at(2), GH)
  expect(seat).toMatchObject({ outcome: 'refuse', to: 2 })
  expect(seat.blip).toBeUndefined()
  expect(thrown(at(6), 'spawnSync gh ENOBUFS')).toMatchObject({ outcome: 'needs_ceo', spans: ['machine_fault', 'threw: spawnSync gh ENOBUFS'] })
})

test('other throws still refuse', () => {
  expect(thrown(at(2), 'plan 123 has no checkout at /x/src')).toMatchObject({ outcome: 'refuse', spans: ['threw: plan 123 has no checkout at /x/src'] })
})

test.each([
  'Post "https://api.github.com/graphql": net/http: TLS handshake timeout',
  'Post "https://api.github.com/graphql": unexpected EOF',
  'dial tcp 140.82.112.6:443: i/o timeout',
  "fatal: unable to access 'https://github.com/x/y.git/': SSL connection timeout",
  'gh: Client Closed Request (HTTP 499)',
  'error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly: CANCEL (err 8)',
])('1532 D1 network throw %# holds as offline', (message) => {
  expect(thrown(at(6), message)).toMatchObject({ outcome: 'pass', held: true, spans: ['offline'] })
})

test('1532 D2 a 404 throw still refuses', () => {
  expect(thrown(at(2), 'gh: Not Found (HTTP 404)')).toMatchObject({ outcome: 'refuse', spans: ['threw: gh: Not Found (HTTP 404)'] })
})
