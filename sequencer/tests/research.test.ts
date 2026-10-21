import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { posts } from '../../store/desk.ts'
import { eventsOf, kindsOf, runRows } from '../../store/events.ts'
import { get, set } from '../../store/lanes.ts'
import { dropPlan, putPlan } from '../../store/plans.ts'
import { WHY } from '../../store/refusals.ts'
import { check, gather, question, record, sourced } from '../../templates/research.ts'
import { tick } from '../index.ts'
import type { Wire } from '../push.ts'
import { mapOf } from '../steps.ts'
import { drop, headSha, maybe, put, srcDir } from '../workspace.ts'
import { git } from './bases.ts'
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

const checked = (answer: string, sources = SOURCES, ask = ASK): ReturnType<typeof check> => {
  const w = researching(ask)
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

test('check D1: a code span holding ... is one sentence', async () => {
  expect(await checked('Build it with `pnpm install` then `pnpm --filter @ultrafuzz/cli... build` [source:1].'))
    .toEqual({ outcome: 'pass', spans: [], note: '1 sentence(s) checked against 1 url(s)' })
})

test('check D2: a split outside a code span still falls', async () => {
  expect(await checked('Run `a. b` now [source:1]. It never moves.'))
    .toEqual({ outcome: 'refuse', spans: ['research.unsourced'], note: 'no source for "It never moves."' })
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

const RULE = '## What\n\nPick by the seven-part selection rule: newest first.\n'

const gathered = async (w: World, reply = FOUND): Promise<[Awaited<ReturnType<typeof gather>>, string]> => {
  let prompt = ''
  const outcome = await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), stub('', 0, reply, (packet) => { prompt = packet.prompt }))
  return [outcome, prompt]
}

test('gather D1: the prompt holds the whole ask and question.json', async () => {
  const w = researching(`${ASK}\n${RULE}`)
  question(w.root, plan(w.db, 1))
  const [, prompt] = await gathered(w)
  expect(prompt).toContain('Pick by the seven-part selection rule: newest first.')
  expect(prompt).toContain(maybe(w.root, 1, 'question.json'))
})

test('gather D2: with no ask.md the prompt holds issue.md', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  drop(w.root, 1, 'ask.md')
  put(w.root, 1, 'issue.md', `${ASK}\n${RULE}`)
  const [, prompt] = await gathered(w)
  expect(prompt).toContain('Pick by the seven-part selection rule: newest first.')
})

test('gather D3: a resumed plan gets the ask, step 0 unrun', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  put(w.root, 1, 'ask.md', `${ASK}\n${RULE}`)
  const [outcome, prompt] = await gathered(w)
  expect(outcome).toMatchObject({ outcome: 'pass' })
  expect(prompt).toContain('Pick by the seven-part selection rule: newest first.')
})

test('gather D4: a reply with no fence is refused', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  const [outcome] = await gathered(w, 'The cap is 3.')
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['researcher.fence'] })
  expect(maybe(w.root, 1, 'answer.md')).toBeNull()
})

test('D4: two fence faults go round, one twice stops', async () => {
  const w = researching()
  await tick(w.db, w.root, seats(FOUND))
  await tick(w.db, w.root, seats('The cap is 3.'))
  const unclaimed = FOUND.replace('    claim: The cap is 3\n', '')
  await tick(w.db, w.root, seats(unclaimed))
  expect(maybe(w.root, 1, 'refusal.md')).not.toContain('# Stopped')
  expect(plan(w.db, 1).state).not.toBe('blocked_on_ceo')
  await tick(w.db, w.root, seats(unclaimed))
  expect(maybe(w.root, 1, 'refusal.md')).toContain(`# Stopped\n\n${WHY.repeat}.`)
})

test('gather D2: a ``` wrapped fence passes, answer.md unwrapped', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  const [outcome] = await gathered(w, `${FOUND.replace('\n---\nsources:', '\n```yaml\n---\nsources:')}\`\`\`\n`)
  expect(outcome).toMatchObject({ outcome: 'pass' })
  expect(maybe(w.root, 1, 'answer.md')).toBe(`The cap is 3 [source:1].${SECTIONS}`)
})

test('gather D6: the prompt carries refusal.md when present', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  expect((await gathered(w))[1]).not.toContain('# Refused')
  put(w.root, 1, 'refusal.md', 'step 1 gather refused: line 5')
  expect((await gathered(w))[1]).toContain('# Refused — fix what this names\n\nstep 1 gather refused: line 5')
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

const RULES = '1. Severity High or Medium.\n2. Newest first.\n'

test('check D1: a table header and separator are not claims', async () => {
  expect(await checked('| Cap | Value |\n| :--- | ---: |\n\nThe cap is 3 [source:1].'))
    .toMatchObject({ outcome: 'pass', note: '1 sentence(s) checked against 1 url(s)' })
})

test('check D2: rule lines quoted from the ask are not claims', async () => {
  expect(await checked(`${RULES}\n3. The cap is 3 [source:1].`, SOURCES, `${ASK}\n${RULES}`))
    .toMatchObject({ outcome: 'pass', note: '1 sentence(s) checked against 1 url(s)' })
  expect(await checked(`${RULES}\nIt never moves.`, SOURCES, `${ASK}\n${RULES}`))
    .toMatchObject({ outcome: 'refuse', spans: ['research.unsourced'], note: 'no source for "It never moves."' })
})

test('check D3/D4: a data row and an ask near-copy are unsourced', async () => {
  expect(await checked('| Rule | Seen |\n|---|---|\n| 1 | yes |\n1. Severity High or Low.', SOURCES, `${ASK}\n${RULES}`))
    .toMatchObject({ outcome: 'refuse', spans: ['research.unsourced'], note: 'no source for "| 1 | yes |", "Severity High or Low."' })
})

test('label D1: label sentences are not claims', async () => {
  expect(await checked('How I applied it:\n\n**Rows that may need your decision:**\n\nThe cap is 3 [source:1].'))
    .toMatchObject({ outcome: 'pass', note: '1 sentence(s) checked against 1 url(s)' })
})

const METHOD = 'The cap is 3 [source:1].\n\n## Method\n\nI went through the sources newest first.'

test('label D2: a Method body passes, the next section is checked', async () => {
  expect(await checked(`${METHOD}${SECTIONS}`)).toMatchObject({ outcome: 'pass' })
  expect(await checked(`${METHOD}\n\n## Would be wrong if\n\nIt never moves.`))
    .toMatchObject({ outcome: 'refuse', spans: ['research.unsourced'], note: 'no source for "It never moves."' })
})

test('label D3: a label with text after its colon is a claim', async () => {
  expect(await checked('The cap is 3 [source:1].\n\n**Row 6:** the report gives no fix commit.'))
    .toMatchObject({ outcome: 'refuse', spans: ['research.unsourced'], note: 'no source for "**Row 6:** the report gives no fix commit."' })
})

test('label D4: a lone bold line is a claim, a sub-heading is not', async () => {
  expect(await checked('**Pashov Audit Group**\n\nThe cap is 3 [source:1].'))
    .toMatchObject({ outcome: 'refuse', spans: ['research.unsourced'], note: 'no source for "**Pashov Audit Group**"' })
  expect(await checked('### Pashov Audit Group\n\nThe cap is 3 [source:1].'))
    .toMatchObject({ outcome: 'pass', note: '1 sentence(s) checked against 1 url(s)' })
  expect(await checked('**Pashov Audit Group:**\n\nThe cap is 3 [source:1].'))
    .toMatchObject({ outcome: 'pass', note: '1 sentence(s) checked against 1 url(s)' })
})

const TABLE = readFileSync(join(import.meta.dirname, 'fixtures/research-table-answer.md'), 'utf8')

const FIXES = '# Fix commits\n\n**Question:** which commit fixed each advisory?\n**Would be wrong if:** a fix was reverted\n**Done when:** each advisory names its fix\n'

const LISTED = [...[...Array(8).keys()].map((i) => ({ url: `https://github.com/example/lib/commit/${String(i + 1).repeat(7)}`, quote: `Fixes advisory ${String(i + 1)}.` })),
  { url: 'https://a.example/reverts', quote: 'No fix was reverted.' }]

const PAGE = LISTED.map((s) => s.quote).join('\n')

test('table D1: an 1186-shaped answer passes', async () => {
  fetched.mockImplementation(() => Promise.resolve(new Response(PAGE)))
  expect(await checked(TABLE, JSON.stringify(LISTED), FIXES)).toEqual({ outcome: 'pass', spans: [], note: '9 sentence(s) checked against 9 url(s)' })
})

test('table D2: an uncited line outside the table is refused', async () => {
  expect(await checked(TABLE.replace('\n\n## How', '\n\nEvery fix landed within a week.\n\n## How'), JSON.stringify(LISTED), FIXES))
    .toEqual({ outcome: 'refuse', spans: ['research.unsourced'], note: 'no source for "Every fix landed within a week."' })
})

test('table D3: a row linking an unlisted url is unsourced', async () => {
  expect(await checked('| Cap | Where |\n|---|---|\n| 3 | [doc](https://b.example/doc) |'))
    .toMatchObject({ outcome: 'refuse', spans: ['research.unsourced'], note: 'no source for "| 3 | [doc](https://b.example/doc) |"' })
})

test('table D4: a row cited by its link is fetched', async () => {
  fetched.mockResolvedValue(new Response('The cap is 4.'))
  expect(await checked('| Cap | Where |\n|---|---|\n| 3 | https://a.example/doc |')).toMatchObject({ outcome: 'refuse',
    spans: ['research.quote_missing'], note: 'quote not on the page for "| 3 | https://a.example/doc |" (https://a.example/doc)' })
})

test('table D5: a Not found body passes, the next is checked', async () => {
  const found = 'The cap is 3 [source:1].\n\n### Not found\n\nNo page names a floor.'
  expect(await checked(found)).toMatchObject({ outcome: 'pass' })
  expect(await checked(`${found}\n\n## Why\n\nIt never moves.`))
    .toMatchObject({ outcome: 'refuse', spans: ['research.unsourced'], note: 'no source for "It never moves."' })
})

test('table D6: the ask quoted in markup is not a claim', async () => {
  expect(await checked('> "what is the cap?"\n\nThe cap is 3 [source:1].'))
    .toMatchObject({ outcome: 'pass', note: '1 sentence(s) checked against 1 url(s)' })
})

const PROMPTED = '**23 Sep:** The cap is 3 [source:1].\n\n## Not found\n\nNo page names a floor.\n\n## Would be wrong if\n\n### Not found\n\n' +
  'No source says whether another cap exists.\n\n## Still unknown\n\nWhen the cap last moved.'

test('prompt D3: an answer laid out as the prompt says is recorded', async () => {
  expect(await checked(PROMPTED)).toMatchObject({ outcome: 'pass', note: '1 sentence(s) checked against 1 url(s)' })
  const { w, wire } = reviewed(PROMPTED)
  expect(record(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'pass' })
  expect(readFileSync(join(findings(w), named), 'utf8'))
    .toContain('## Would be wrong if\n\na page names another cap\n\n### Not found\n\nNo source says whether another cap exists.\n\n## Sources')
})

test.each(['**23 Sep:** solidity-auditor v4 was merged and released.', 'Next cohort date: not found.'])('prompt D4: %s is unsourced', async (line) => {
  expect(await checked(PROMPTED.replace('\n\n## Not found', `\n\n${line}\n\n## Not found`)))
    .toEqual({ outcome: 'refuse', spans: ['research.unsourced'], note: `no source for "${line}"` })
})

const MEASURE = `${ASK}**Measure:** time the cold start\n`

const RUN = 'uv run bench.py'

const TRANSCRIPT = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: RUN } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'cold start:\n  41 ms' }] }] } },
].map((line) => `${JSON.stringify(line)}\n`).join('')

const entry = (commit: string, quote = 'cold start: 41 ms'): string =>
  `  - run:\n      command: ${RUN}\n      commit: ${commit}\n      quote: ${quote}\n      claim: Cold start is 41 ms\n`

const LINKED = '  - url: https://a.example/doc\n    fetched_at: 2026-10-04T10:00:00Z\n    quote: The cap is 3.\n    claim: The cap is 3\n'

const fence = (...entries: string[]): string => `Cold start is 41 ms [source:1].${SECTIONS}\n\n---\nsources:\n${entries.join('')}---\n`

/** The measurer answers `reply` and leaves TRANSCRIPT behind; every other seat answers PASS. */
const measuring = (reply: string, seen: (prompt: string) => void): Provider => ({
  name: 'claude-agent-sdk',
  fire: async (packet) => {
    seen(packet.prompt)
    const measurer = packet.prompt.includes('# measurer\n')
    const fired = await stub('', 0, measurer ? reply : PASS).fire(packet)
    if (measurer) writeFileSync(packet.transcript, TRANSCRIPT)
    return fired
  },
})

const headed = (w: World): string => {
  const src = srcDir(w.root, 1)
  git(src, ['init', '-q'])
  git(src, ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'base'])
  return headSha(src)
}

test('measure D1: a Measure line fires measurer with HEAD', async () => {
  const w = researching(MEASURE)
  const head = headed(w)
  question(w.root, plan(w.db, 1))
  let prompt = ''
  expect(await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), measuring(fence(entry(head)), (p) => { prompt = p })))
    .toMatchObject({ outcome: 'pass', note: expect.stringContaining('measurer: answer.md written') as unknown })
  expect(prompt).toContain(`# HEAD\n\n${head}`)
  expect(ran(w)).toEqual(['measurer'])
  expect(JSON.parse(maybe(w.root, 1, 'runs.json') ?? '')).toEqual([{ command: RUN, output: 'cold start:\n  41 ms' }])
})

test('measure D1: an ask with no Measure line fires researcher', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  const [outcome, prompt] = await gathered(w)
  expect(outcome).toMatchObject({ outcome: 'pass' })
  expect(prompt).not.toContain('# HEAD')
  expect(ran(w)).toEqual(['researcher'])
  expect(maybe(w.root, 1, 'runs.json')).toBeNull()
})

const NEEDS_RUN = 'This needs a timed run.\n\n```\n---\noutcome: needs_run\n---\n```\n'

const UNRUN = { outcome: 'refuse', spans: ['ask.md'], note: 'ask needs executed runs: add a **Measure:** line so the measurer gathers it' }

test('needs_run D1: a researcher needs_run reply refuses ask.md', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  expect((await gathered(w, NEEDS_RUN))[0]).toEqual(UNRUN)
  expect(maybe(w.root, 1, 'answer.md')).toBeNull()
  expect(maybe(w.root, 1, 'sources.json')).toBeNull()
})

test('needs_run D2: a measurer needs_run reply refuses its fence', async () => {
  const w = researching(MEASURE)
  headed(w)
  question(w.root, plan(w.db, 1))
  expect(await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), measuring(NEEDS_RUN, () => undefined)))
    .toMatchObject({ outcome: 'refuse', spans: ['researcher.fence'] })
  expect(ran(w)).toEqual(['measurer'])
})

const NEEDS_BUILD = 'This needs the network.\n\n```\n---\noutcome: needs_build\n---\n```\n'

test('needs_build D1: a measurer needs_build reply refuses ask.md', async () => {
  const w = researching(MEASURE)
  headed(w)
  question(w.root, plan(w.db, 1))
  expect(await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), measuring(NEEDS_BUILD, () => undefined))).toEqual({
    outcome: 'refuse', spans: ['ask.md'],
    note: 'ask needs network or writes outside .cf/measure/: file it on a pr_path lane, whose builder writes the script and runs it',
  })
  expect(maybe(w.root, 1, 'answer.md')).toBeNull()
  expect(maybe(w.root, 1, 'sources.json')).toBeNull()
  expect(maybe(w.root, 1, 'runs.json')).toBeNull()
})

test('needs_build D2: a researcher needs_build refuses its fence', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  expect((await gathered(w, NEEDS_BUILD))[0]).toMatchObject({ outcome: 'refuse', spans: ['researcher.fence'] })
  expect(ran(w)).toEqual(['researcher'])
})

const cite =(commit: string, quote = 'cold start: 41 ms', command = RUN): object => ({ run: { command, commit, quote, claim: 'Cold start is 41 ms' } })

test('measure D2: a fence of run and url entries is written whole', () => {
  const w = researching()
  expect(sourced(w.root, plan(w.db, 1), fence(entry('abc1234'), LINKED))).toMatchObject({ outcome: 'pass' })
  expect(JSON.parse(maybe(w.root, 1, 'sources.json') ?? '')).toEqual([cite('abc1234'), ...(JSON.parse(SOURCES) as unknown[])])
})

test('measure D2: a run with an empty quote is unquoted', () => {
  const w = researching()
  expect(sourced(w.root, plan(w.db, 1), fence(entry('abc1234', ''))))
    .toEqual({ outcome: 'refuse', spans: ['researcher.unquoted'], note: `no quote for ${RUN}` })
})

const measured = (sources: (head: string) => object[]): ReturnType<typeof check> => {
  const w = researching(MEASURE)
  const head = headed(w)
  put(w.root, 1, 'sources.json', JSON.stringify(sources(head)))
  put(w.root, 1, 'runs.json', JSON.stringify([{ command: RUN, output: 'cold start:\n  41 ms' }]))
  put(w.root, 1, 'answer.md', 'Cold start is 41 ms [source:1].')
  return check(w.root, plan(w.db, 1))
}

test('measure D3: a run cite at HEAD in runs.json passes unfetched', async () => {
  expect(await measured((head) => [cite(head)])).toEqual({ outcome: 'pass', spans: [], note: '1 sentence(s) checked against 0 url(s)' })
  expect(fetched).not.toHaveBeenCalled()
})

test('measure D4: a run cite off HEAD is run_commit', async () => {
  expect(await measured(() => [cite('0000000')])).toEqual({ outcome: 'refuse', spans: ['research.run_commit'],
    note: expect.stringContaining(`for "Cold start is 41 ms [source:1]." (${RUN})`) as unknown })
})

test.each([[RUN, '42 ms'], [`${RUN} --cold`, 'cold start: 41 ms']])('measure D5: an unrun command or quote is run_missing', async (command, quote) => {
  expect(await measured((head) => [cite(head, quote, command)])).toEqual({ outcome: 'refuse', spans: ['research.run_missing'],
    note: `quote not in the run's output for "Cold start is 41 ms [source:1]." (${command})` })
})

test('measure D6: a run source is listed by command and commit', () => {
  const { w, wire } = reviewed()
  put(w.root, 1, 'sources.json', JSON.stringify([cite('abc1234')]))
  record(w.db, w.root, plan(w.db, 1), wire)
  const finding = readFileSync(join(findings(w), named), 'utf8')
  expect(finding).toContain(`## Sources\n\n1. \`${RUN}\` at abc1234: "cold start: 41 ms"\n`)
  expect(finding).not.toContain('undefined')
  expect(JSON.parse(posts(w.db)[0]?.sources ?? '')).toEqual([{ claim: 'Cold start is 41 ms', ref: `\`${RUN}\` at abc1234` }])
})
