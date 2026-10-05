import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { posts } from '../../store/desk.ts'
import { eventsOf, kindsOf, runRows } from '../../store/events.ts'
import { get, set } from '../../store/lanes.ts'
import { dropPlan, putPlan } from '../../store/plans.ts'
import { check, gather, question, record } from '../../templates/research.ts'
import { tick } from '../index.ts'
import type { Wire } from '../push.ts'
import { mapOf } from '../steps.ts'
import { maybe, put } from '../workspace.ts'
import { PASS, plan, stub, watched, world, type World } from './world.ts'

const ASK = '# The cap\n\n**Question:** what is the cap?\n**Would be wrong if:** a page names another cap\n**Done when:** a quote names it\n'

const SECTIONS = '\n\n## Would be wrong if\n\nNo page names another cap [source:1].\n\n## Still unknown\n\nWhen the cap last moved.'

const source = (quote: string): string =>
  `The cap is 3 [source:1].${SECTIONS}\n\n---\nsources:\n  - url: https://a.example/doc\n    fetched_at: 2026-10-04T10:00:00Z\n${quote}    claim: The cap is 3\n---\n`

const FOUND = source('    quote: The cap is 3.\n')

const REFUSE = 'The answer goes past its quote.\n\n---\noutcome: refuse\nclass: correctness\nspans:\n  - answer.md:1\n---\n'

const researching = (ask = ASK): World => {
  const w = world()
  const { queued_at } = plan(w.db, 1)
  dropPlan(w.db, 1)
  putPlan(w.db, { id: 1, pipe_id: 1, target_id: 1, template: 'research', state: 'queued', queued_at, step: 0, retries: 0 })
  put(w.root, 1, 'ask.md', ask)
  set(w.db, 'science.dir', mkdtempSync(join(tmpdir(), 'cf-science-')), 'ceo', '2026-10-05')
  return w
}

/** The researcher answers `reply`; every other seat answers `verdict`. */
const seats = (reply: string, verdict = PASS): Provider => ({
  name: 'claude-agent-sdk',
  fire: (packet) => stub('', 0, packet.prompt.includes('# researcher\n') ? reply : verdict).fire(packet),
})

const ran = (w: World): string[] => runRows(w.db).map((r) => r.seat)

let fetched = vi.fn<typeof fetch>()

beforeEach(() => {
  fetched = vi.fn<typeof fetch>(() => Promise.resolve(new Response('The cap\n  is 3.')))
  vi.stubGlobal('fetch', fetched)
})

afterEach(() => { vi.unstubAllGlobals() })

const SOURCES = JSON.stringify([{ url: 'https://a.example/doc', fetched_at: '2026-10-04T10:00:00Z', quote: 'The cap is 3.', claim: 'The cap is 3' }])

const checked = (answer: string, sources = SOURCES): ReturnType<typeof check> => {
  const w = researching()
  put(w.root, 1, 'sources.json', sources)
  put(w.root, 1, 'answer.md', answer)
  return check(w.root, plan(w.db, 1))
}

test('D1: a full ask walks question to record and is done', async () => {
  const w = researching()
  for (let n = 0; n < 6 && plan(w.db, 1).state !== 'done'; n += 1) await tick(w.db, w.root, seats(FOUND))
  expect(plan(w.db, 1).state).toBe('done')
  expect(kindsOf(w.db, 1)).toEqual(['question', 'gather', 'check', 'review', 'record'].map((kind) => ({ kind, outcome: 'pass' })))
  expect(ran(w)).toEqual(['researcher', 'senior_review'])
  for (const name of ['question.json', 'sources.json', 'answer.md', 'review.md']) expect(maybe(w.root, 1, name)).not.toBeNull()
  expect(maybe(w.root, 1, 'answer.md')).toBe(`The cap is 3 [source:1].${SECTIONS}`)
})

test('check: two claims on one page pass, fetched once', async () => {
  expect(await checked('# Cap\n\nThe cap is 3 [source:1]. It is 3. [source:1]')).toMatchObject({ outcome: 'pass' })
  expect(fetched).toHaveBeenCalledTimes(1)
})

test('check: a quote not on the page is quote_missing', async () => {
  fetched.mockResolvedValue(new Response('The cap is 4.'))
  expect(await checked('The cap is 3 [source:1].'))
    .toMatchObject({ outcome: 'refuse', spans: ['research.quote_missing'], note: expect.stringContaining('"The cap is 3 [source:1]." (https://a.example/doc)') as unknown })
})

test('check: an unmarked sentence is unsourced, unfetched', async () => {
  expect(await checked('The cap is 3 [source:1]. It never moves.'))
    .toMatchObject({ outcome: 'refuse', spans: ['research.unsourced'], note: 'no source for "It never moves."' })
  expect(await checked('The cap is 3 [source:2].')).toMatchObject({ spans: ['research.unsourced'] })
  expect(fetched).not.toHaveBeenCalled()
})

test('check: a 404 is a dead source', async () => {
  fetched.mockResolvedValue(new Response('', { status: 404 }))
  expect(await checked('The cap is 3 [source:1].'))
    .toMatchObject({ outcome: 'refuse', spans: ['research.dead_source'], note: 'dead source: https://a.example/doc (404)' })
})

test('check: no sources passes without fetching', async () => {
  expect(await checked('Nothing found.', '[]')).toMatchObject({ outcome: 'pass', note: 'no sources: nothing found' })
  expect(fetched).not.toHaveBeenCalled()
})

test('D2: an ask with no wrong-if line is refused at step 0', async () => {
  const w = researching(ASK.replace(/\*\*Would be wrong if:\*\*.*\n/, ''))
  await tick(w.db, w.root, seats(FOUND))
  expect(eventsOf(w.db, 1, 'question')).toEqual([{ actor: 'question', outcome: 'refuse', message: 'ask.md has no **Would be wrong if:** line' }])
  expect(plan(w.db, 1).step).toBe(0)
  expect(maybe(w.root, 1, 'question.json')).toBeNull()
})

test('D3: an unquoted source is refused at gather', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  expect(await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), seats(source(''))))
    .toMatchObject({ outcome: 'refuse', spans: ['researcher.unquoted'] })
  expect(maybe(w.root, 1, 'answer.md')).toBeNull()
})

test('D4: a senior_review refuse sends the plan back to gather', async () => {
  const w = researching()
  for (let n = 0; n < 4; n += 1) await tick(w.db, w.root, seats(FOUND, REFUSE))
  expect(eventsOf(w.db, 1, 'review')).toMatchObject([{ actor: 'senior_review', outcome: 'refuse' }])
  expect(plan(w.db, 1).step).toBe(1)
})

const ANSWER = `The cap is 3 [source:1].${SECTIONS}`

const ORIGIN = 'https://github.com/caliperforge/cf/issues/7'

/** A plan past review with `answer` as its answer.md; a close logs its comment. */
const reviewed = (answer = ANSWER): { w: World; log: string[]; wire: Wire } => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  put(w.root, 1, 'sources.json', SOURCES)
  put(w.root, 1, 'answer.md', answer)
  const log: string[] = []
  return { w, log, wire: { ...watched(log, w.root, 1), close: (repo, no, sha, comment) => void log.push(`close ${repo}#${String(no)} ${sha}${comment ?? ''}`) } }
}

const findings = (w: World): string => join(get(w.db, 'science.dir'), 'findings')

const named = `${new Date().toISOString().slice(0, 10)}_the-cap.md`

test('record D1: one finding in five sections, one proof row', () => {
  const { w, wire } = reviewed(`${'word '.repeat(200)}${ANSWER}`)
  expect(record(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'pass' })
  expect(readdirSync(findings(w))).toEqual([named])
  expect(readFileSync(join(findings(w), named), 'utf8').match(/^## .*$/gm))
    .toEqual(['## Question', '## Answer', '## Would be wrong if', '## Sources', '## Still unknown'])
  expect(posts(w.db)).toMatchObject([{ id: 1, kind: 'note', dest: 'site', status: 'proof', title: 'The cap', dek: 'what is the cap?' }])
  expect(posts(w.db)[0]?.body.split(' ')).toHaveLength(150)
})

test('record D2: a second run adds no file, row or close', () => {
  const { w, log, wire } = reviewed()
  const origined = { ...plan(w.db, 1), origin: ORIGIN }
  record(w.db, w.root, origined, wire)
  expect(record(w.db, w.root, origined, wire)).toEqual({ outcome: 'pass', spans: [], note: 'already recorded' })
  expect(readdirSync(findings(w))).toHaveLength(1)
  expect(posts(w.db)).toHaveLength(1)
  expect(log).toHaveLength(1)
})

test.each(['## Would be wrong if', '## Still unknown'])('record D3: no %s section is refused', (heading) => {
  const { w, wire } = reviewed(ANSWER.replace(heading, ''))
  expect(record(w.db, w.root, plan(w.db, 1), wire)).toEqual({ outcome: 'refuse', spans: ['answer.md'], note: `answer.md has no ${heading} section` })
  expect(existsSync(findings(w))).toBe(false)
  expect(posts(w.db)).toEqual([])
})

test.each(['', '/nowhere/science'])('record D4: science.dir "%s" is refused', (dir) => {
  const { w, wire } = reviewed()
  set(w.db, 'science.dir', dir, 'ceo', '2026-10-05')
  expect(record(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'refuse', spans: ['science.dir'] })
  expect(existsSync(dir)).toBe(false)
  expect(posts(w.db)).toEqual([])
})

test('record D5: an origin closes once, naming the finding', () => {
  const { w, log, wire } = reviewed()
  record(w.db, w.root, { ...plan(w.db, 1), origin: ORIGIN }, wire)
  expect(log).toEqual([`close caliperforge/cf#7 Finding: ${join(findings(w), named)}`])
})

test('record D5: a plan with no origin closes nothing', () => {
  const { w, log, wire } = reviewed()
  record(w.db, w.root, plan(w.db, 1), wire)
  expect(log).toEqual([])
})

test('check D6: an unsourced Still unknown sentence passes', async () => {
  expect(await checked(ANSWER)).toMatchObject({ outcome: 'pass' })
})
