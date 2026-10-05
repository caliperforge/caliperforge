import { expect, test } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { eventsOf, kindsOf, runRows } from '../../store/events.ts'
import { dropPlan, putPlan } from '../../store/plans.ts'
import { gather, question } from '../../templates/research.ts'
import { tick } from '../index.ts'
import { mapOf } from '../steps.ts'
import { maybe, put } from '../workspace.ts'
import { PASS, plan, stub, world, type World } from './world.ts'

const ASK = '# The cap\n\n**Question:** what is the cap?\n**Would be wrong if:** a page names another cap\n**Done when:** a quote names it\n'

const source = (quote: string): string =>
  `The cap is 3.\n\n---\nsources:\n  - url: https://a.example/doc\n    fetched_at: 2026-10-04T10:00:00Z\n${quote}    claim: The cap is 3\n---\n`

const FOUND = source('    quote: The cap is 3.\n')

const REFUSE = 'The answer goes past its quote.\n\n---\noutcome: refuse\nclass: correctness\nspans:\n  - answer.md:1\n---\n'

const researching = (ask = ASK): World => {
  const w = world()
  const { queued_at } = plan(w.db, 1)
  dropPlan(w.db, 1)
  putPlan(w.db, { id: 1, pipe_id: 1, target_id: 1, template: 'research', state: 'queued', queued_at, step: 0, retries: 0 })
  put(w.root, 1, 'ask.md', ask)
  return w
}

/** The researcher answers `reply`; every other seat answers `verdict`. */
const seats = (reply: string, verdict = PASS): Provider => ({
  name: 'claude-agent-sdk',
  fire: (packet) => stub('', 0, packet.prompt.includes('# researcher\n') ? reply : verdict).fire(packet),
})

const ran = (w: World): string[] => runRows(w.db).map((r) => r.seat)

test('D1: a full ask walks question to record and is done', async () => {
  const w = researching()
  for (let n = 0; n < 6 && plan(w.db, 1).state !== 'done'; n += 1) await tick(w.db, w.root, seats(FOUND))
  expect(plan(w.db, 1).state).toBe('done')
  expect(kindsOf(w.db, 1)).toEqual(['question', 'gather', 'check', 'review', 'record'].map((kind) => ({ kind, outcome: 'pass' })))
  expect(ran(w)).toEqual(['researcher', 'senior_review'])
  for (const name of ['question.json', 'sources.json', 'answer.md', 'review.md']) expect(maybe(w.root, 1, name)).not.toBeNull()
  expect(maybe(w.root, 1, 'answer.md')).toBe('The cap is 3.')
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
