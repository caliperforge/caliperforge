import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Packet, Provider } from '../../providers/kind.ts'
import { posts } from '../../store/desk.ts'
import { eventsOf, kindsOf, runRows } from '../../store/events.ts'
import { get, set } from '../../store/lanes.ts'
import { dropPlan, putPlan } from '../../store/plans.ts'
import { fingerprint, refusalsOf, refused, WHY } from '../../store/refusals.ts'
import { check, gather, question, record, sourced } from '../../templates/research.ts'
import { tick } from '../index.ts'
import type { Wire } from '../push.ts'
import { rule } from '../rule.ts'
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
  fire: (packet) => stub(reply, 0, packet.prompt.includes('# researcher\n') ? reply : verdict).fire(packet),
})

const ran = (w: World): string[] => runRows(w.db).map((r) => r.seat)

let fetched = vi.fn<typeof fetch>()

beforeEach(() => {
  fetched = vi.fn<typeof fetch>(() => Promise.resolve(new Response('The cap\n  is 3.')))
  vi.stubGlobal('fetch', fetched)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const SOURCES = JSON.stringify([{ url: 'https://a.example/doc', fetched_at: '2026-10-04T10:00:00Z', quote: 'The cap is 3.', claim: 'The cap is 3' }])

const checked = (answer: string, sources = SOURCES, ask = ASK, w = researching(ask)): ReturnType<typeof check> => {
  put(w.root, 1, 'sources.json', sources)
  put(w.root, 1, 'answer.md', answer)
  return check(w.db, w.root, plan(w.db, 1))
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

const after = (span: string | null): World => {
  const w = researching()
  if (span !== null) refused(w.db, { plan: 1, step: 2, fingerprint: fingerprint(2, [span]), diff: null, span })
  return w
}

test('stated D1: a second quote_missing states it with its URL', async () => {
  fetched.mockResolvedValue(new Response('The cap is 4.'))
  const w = after('research.quote_missing')
  expect(await checked('The maintainer wrote "the cap is 3" [source:1].', SOURCES, ASK, w)).toEqual({ outcome: 'pass', spans: [],
    note: 'quote not on the page again, stated plainly with its URL for "The maintainer wrote "the cap is 3" [source:1]." (https://a.example/doc)' })
  expect(maybe(w.root, 1, 'answer.md')).toBe('The maintainer wrote the cap is 3 (https://a.example/doc) [source:1].')
})

test('stated D2: a table row loses its quotes, its URL not doubled', async () => {
  fetched.mockResolvedValue(new Response('The cap is 4.'))
  const w = after('research.quote_missing')
  expect(await checked('| Cap | Where |\n|---|---|\n| 3 | "x" https://a.example/doc |', SOURCES, ASK, w)).toMatchObject({ outcome: 'pass' })
  expect(maybe(w.root, 1, 'answer.md')).toBe('| Cap | Where |\n|---|---|\n| 3 | x https://a.example/doc |')
})

test.each([null, 'research.unsourced', 'senior_review'])('stated D3: after %s, a missing quote refuses', async (span) => {
  fetched.mockResolvedValue(new Response('The cap is 4.'))
  const w = after(span)
  expect(await checked('The cap is "3" [source:1].', SOURCES, ASK, w)).toMatchObject({ outcome: 'refuse', spans: ['research.quote_missing'] })
  expect(maybe(w.root, 1, 'answer.md')).toBe('The cap is "3" [source:1].')
})

test('stated D4: after quote_missing an unsourced line refuses', async () => {
  const w = after('research.quote_missing')
  expect(await checked('The cap is "3" [source:1]. It never moves.', SOURCES, ASK, w))
    .toEqual({ outcome: 'refuse', spans: ['research.unsourced'], note: 'no source for "It never moves."' })
  expect(maybe(w.root, 1, 'answer.md')).toBe('The cap is "3" [source:1]. It never moves.')
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

const serve = (body: string | Uint8Array<ArrayBuffer>, type?: string): void => {
  fetched.mockImplementation(() => Promise.resolve(new Response(body, type === undefined ? {} : { headers: { 'content-type': type } })))
}

const quoted = (url: string, quote: string): string => JSON.stringify([{ url, fetched_at: '2026-10-04T10:00:00Z', quote, claim: 'c' }])

const HTML = '<html><head><style>p { color: red }</style><SCRIPT type="x">var decoy = "The cap is 9."</script></head>'
  + '<body><p>Explore and contribute to open issues: <a href="x">GitHub Issues</a> &amp; more</p></body></html>'

test('check D1: a quote split by HTML tags passes', async () => {
  serve(HTML, 'text/html; charset=utf-8')
  expect(await checked('Issues are open [source:1].', quoted('https://a.example/doc', 'Explore and contribute to open issues: GitHub Issues & more')))
    .toMatchObject({ outcome: 'pass' })
})

test('check D5: a quote only in a script is quote_missing', async () => {
  serve(HTML, 'text/html')
  expect(await checked('The cap is 9 [source:1].', quoted('https://a.example/doc', 'The cap is 9.')))
    .toMatchObject({ outcome: 'refuse', spans: ['research.quote_missing'] })
})

test('check D2: a quote across a markdown link passes', async () => {
  serve('# R\n\nFile bugs on [GitHub Issues](https://x) please.')
  expect(await checked('Bugs go to issues [source:1].', quoted('https://raw.githubusercontent.com/o/r/main/README.md', 'File bugs on GitHub Issues please.')))
    .toMatchObject({ outcome: 'pass' })
})

const PDF = readFileSync(join(import.meta.dirname, 'fixtures/research-quote.pdf'))

test('check D3: a PDF quote passes via pdftotext', async () => {
  expect(PDF.toString('latin1')).not.toContain('The cap is 3')
  serve(new Uint8Array(PDF), 'application/pdf')
  expect(await checked('The cap is 3 [source:1].')).toMatchObject({ outcome: 'pass' })
})

test('check D4: an unreadable PDF is pdf_unread', async () => {
  vi.stubEnv('PATH', '')
  serve(new Uint8Array(PDF), 'application/pdf')
  expect(await checked('The cap is 3 [source:1].'))
    .toEqual({ outcome: 'refuse', spans: ['research.pdf_unread'], note: 'pdftotext could not read https://a.example/doc' })
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

const RULING = '\n## Answer from the director (2026-10-22)\n\nCount only the hosted cap.\n'

test('D2: a ruling beside an ask with no wrong-if still refuses', async () => {
  const w = researching(ASK.replace(/\*\*Would be wrong if:\*\*.*\n/, ''))
  put(w.root, 1, 'issue.md', RULING)
  await tick(w.db, w.root, seats(FOUND))
  expect(eventsOf(w.db, 1, 'question')).toEqual([{ actor: 'question', outcome: 'refuse', message: 'ask.md has no **Would be wrong if:** line' }])
  expect(plan(w.db, 1).step).toBe(0)
})

const PARENT = '## Parent ticket\n\n**Question:** parent q\n**Would be wrong if:** parent w\n**Done when:** parent d\n'

const OLDER = `# a part\n\n**What:** part q\n**Why:** y\n**When it ends:** part d\n\n${PARENT}`

const OWN = { question: 'part q', wrong_if: 'it leaves out what this part asks, or answers what its parent ticket asks', done_when: 'part d' }

const FILLED = 'question.json written, filled for a part: '
  + '**Question:** from **What:**, **Would be wrong if:** from the fixed part sentence, **Done when:** from **When it ends:**'

test('part D1: an older part\'s question.json is its own', () => {
  const w = researching(OLDER)
  expect(question(w.root, plan(w.db, 1))).toEqual({ outcome: 'pass', spans: [], note: FILLED })
  const json = maybe(w.root, 1, 'question.json') ?? ''
  expect(JSON.parse(json)).toEqual(OWN)
  for (const parent of ['parent q', 'parent w', 'parent d']) expect(json).not.toContain(parent)
})

test('part D2: gather rewrites a stale parent question.json', async () => {
  const w = researching(OLDER)
  put(w.root, 1, 'question.json', JSON.stringify({ question: 'parent q', wrong_if: 'parent w', done_when: 'parent d' }))
  const [outcome, prompt] = await gathered(w)
  expect(outcome.note).toBe(`${FILLED}; researcher: answer.md written, sources.json written with 1 source(s)`)
  expect(JSON.parse(maybe(w.root, 1, 'question.json') ?? '')).toEqual(OWN)
  expect(prompt).toContain(`# question.json\n\n${JSON.stringify(OWN)}`)
})

test('part D3: a parent-only Question is refused, unfired', async () => {
  const w = researching(`# a part\n\n**When it ends:** part d\n\n${PARENT}`)
  const refusal = { outcome: 'refuse', spans: ['ask.md'], note: 'ask.md has no **Question:** line' }
  expect(question(w.root, plan(w.db, 1))).toEqual(refusal)
  expect((await gathered(w))[0]).toEqual(refusal)
  expect(ran(w)).toEqual([])
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
  const outcome = await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), stub(reply, 0, reply, (packet) => { prompt = packet.prompt }))
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

test('gather D5: the prompt holds an issue.md ruling after the ask', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  put(w.root, 1, 'issue.md', RULING)
  const [, prompt] = await gathered(w)
  const ask = prompt.slice(prompt.indexOf('# Ask'), prompt.indexOf('# question.json'))
  expect(ask.indexOf('Count only the hosted cap.')).toBeGreaterThan(ask.indexOf('**Question:** what is the cap?'))
  expect(ask.indexOf('**Question:**')).toBeGreaterThan(-1)
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

test('gather D4: a refused reply keeps the last answer', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  put(w.root, 1, 'answer.md', 'The cap was 2 [source:1].')
  put(w.root, 1, 'sources.json', SOURCES)
  expect((await gathered(w, 'The cap is 3.'))[0]).toMatchObject({ outcome: 'refuse', spans: ['researcher.fence'] })
  expect(maybe(w.root, 1, 'answer.md')).toBe('The cap was 2 [source:1].')
  expect(maybe(w.root, 1, 'sources.json')).toBe(SOURCES)
  expect((await gathered(w))[1]).toContain('# Your last answer — repair what the ask and the refusal name, keep the rest\n\nThe cap was 2 [source:1].')
})

const draftOf = (w: World): string => {
  mkdirSync(join(srcDir(w.root, 1), '.cf'), { recursive: true })
  return join(srcDir(w.root, 1), '.cf/draft.md')
}

const drafting = (w: World, reply: string, draft: string): ReturnType<typeof gather> =>
  gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), stub(reply, 0, reply, () => { writeFileSync(draftOf(w), draft) }))

test('draft D1: a fenceless reply hands in the checked draft', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  expect(await drafting(w, 'Draft passes.', FOUND)).toMatchObject({ outcome: 'pass', note: expect.stringContaining('from .cf/draft.md') as unknown })
  expect(maybe(w.root, 1, 'answer.md')).toBe(`The cap is 3 [source:1].${SECTIONS}`)
  expect(maybe(w.root, 1, 'sources.json')).toBe(SOURCES)
})

test('draft D3: a draft from before the fire is not handed in', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  writeFileSync(draftOf(w), FOUND)
  expect((await gathered(w, 'Draft passes.'))[0]).toMatchObject({ outcome: 'refuse', spans: ['researcher.fence'] })
  expect(maybe(w.root, 1, 'answer.md')).toBeNull()
})

test('draft D4: a fenced reply wins over the draft', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  expect((await drafting(w, FOUND, source(''))).note).toBe('researcher: answer.md written, sources.json written with 1 source(s)')
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

test('gather D6: the researcher checks its draft, never idled', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  const seen: Packet[] = []
  await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), stub(FOUND, 0, FOUND, (packet) => { seen.push(packet) }))
  expect(seen[0]?.prompt).toContain('cf research check .cf/draft.md')
  expect(seen[0]?.idle).toBe(Number.POSITIVE_INFINITY)
})

test('gather D1: the prompt carries the last answer and sources', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  expect((await gathered(w))[1]).not.toContain('# Your last answer')
  put(w.root, 1, 'answer.md', ANSWER)
  put(w.root, 1, 'sources.json', SOURCES)
  expect(maybe(w.root, 1, 'refusal.md')).toBeNull()
  const last = `# Your last answer — repair what the ask and the refusal name, keep the rest\n\n${ANSWER}\n\n# Its sources, [source:n] counting from 1\n\n${SOURCES}`
  expect((await gathered(w))[1]).toContain(last)
  put(w.root, 1, 'refusal.md', 'step 3 review refused')
  const prompt = (await gathered(w))[1]
  expect(prompt.indexOf(last)).toBeGreaterThan(prompt.indexOf('# Refused — fix what this names\n\nstep 3 review refused'))
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

test('record D3: a failed write throws, no row, then records', () => {
  const { w, wire } = reviewed()
  writeFileSync(findings(w), '')
  expect(() => record(w.db, w.root, plan(w.db, 1), wire)).toThrow()
  expect(posts(w.db)).toEqual([])
  rmSync(findings(w))
  expect(record(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'pass' })
  expect(posts(w.db)).toHaveLength(1)
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

test('record D6: a ruling-only issue.md takes the ask.md title', () => {
  const { w, wire } = reviewed()
  put(w.root, 1, 'issue.md', RULING)
  expect(record(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'pass' })
  expect(readdirSync(findings(w))).toEqual([named])
  expect(posts(w.db)[0]?.title).toBe('The cap')
})

test('record D6: no # in ask.md or a ruling issue.md refuses', () => {
  const { w, wire } = reviewed()
  put(w.root, 1, 'ask.md', ASK.replace('# The cap\n', ''))
  put(w.root, 1, 'issue.md', RULING)
  expect(record(w.db, w.root, plan(w.db, 1), wire)).toEqual({ outcome: 'refuse', spans: ['ask.md'], note: 'ask.md has no # title' })
  expect(existsSync(findings(w))).toBe(false)
  expect(posts(w.db)).toEqual([])
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

const bashed = (command: string, text: string): string => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text }] }] } },
].map((line) => `${JSON.stringify(line)}\n`).join('')

const TRANSCRIPT = bashed(RUN, 'cold start:\n  41 ms')

const entry = (commit: string, quote = 'cold start: 41 ms'): string =>
  `  - run:\n      command: ${RUN}\n      commit: ${commit}\n      quote: ${quote}\n      claim: Cold start is 41 ms\n`

const LINKED = '  - url: https://a.example/doc\n    fetched_at: 2026-10-04T10:00:00Z\n    quote: The cap is 3.\n    claim: The cap is 3\n'

const fence = (...entries: string[]): string => `Cold start is 41 ms [source:1].${SECTIONS}\n\n---\nsources:\n${entries.join('')}---\n`

/** The measurer or fetcher answers `reply` and leaves `transcript` behind; every other seat answers `others`. */
const measuring = (reply: string, seen: (packet: Packet) => void, transcript = TRANSCRIPT, others = PASS): Provider => ({
  name: 'claude-agent-sdk',
  fire: async (packet) => {
    seen(packet)
    const measurer = /# (?:measurer|fetcher)\n/.test(packet.prompt)
    const text = measurer ? reply : others
    const fired = await stub(text, 0, text).fire(packet)
    if (measurer) writeFileSync(packet.transcript, transcript)
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
  let idle: number | undefined
  expect(await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), measuring(fence(entry(head)), (p) => { prompt = p.prompt; idle = p.idle })))
    .toMatchObject({ outcome: 'pass', note: expect.stringContaining('measurer: answer.md written') as unknown })
  expect(prompt).toContain(`# HEAD\n\n${head}`)
  expect(idle).toBeUndefined()
  expect(ran(w)).toEqual(['measurer'])
  expect(JSON.parse(maybe(w.root, 1, 'runs.json') ?? '')).toEqual([{ command: RUN, output: 'cold start:\n  41 ms' }])
})

const UNBASHED = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Kept the rest.' }] } })}\n`

const regathered = async (...left: string[]): Promise<unknown> => {
  const w = researching(MEASURE)
  const head = headed(w)
  question(w.root, plan(w.db, 1))
  for (const transcript of left) {
    expect(await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), measuring(fence(entry(head)), () => undefined, transcript)))
      .toMatchObject({ outcome: 'pass' })
  }
  return JSON.parse(maybe(w.root, 1, 'runs.json') ?? '')
}

test('runs D1: a repair run with no Bash call keeps earlier runs', async () => {
  expect(await regathered(TRANSCRIPT, UNBASHED)).toEqual([{ command: RUN, output: 'cold start:\n  41 ms' }])
})

test('runs D2: runs.json holds every run, oldest first', async () => {
  expect(await regathered(TRANSCRIPT, bashed('uv run warm.py', 'warm start:\n  9 ms')))
    .toEqual([{ command: RUN, output: 'cold start:\n  41 ms' }, { command: 'uv run warm.py', output: 'warm start:\n  9 ms' }])
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

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-home-'))
  vi.stubEnv('HOME', dir)
  return dir
}

test('fetch D1: an Output line fires fetcher into its folder', async () => {
  const out = join(home(), 'cf_work/rubin-post')
  const w = researching(`${MEASURE}**Output:** ~/cf_work/rubin-post/\n`)
  const head = headed(w)
  question(w.root, plan(w.db, 1))
  const seen: Packet[] = []
  let made = false
  expect(await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), measuring(fence(entry(head)), (p) => { seen.push(p); made = existsSync(out) })))
    .toMatchObject({ outcome: 'pass', note: expect.stringContaining('fetcher: answer.md written') as unknown })
  const [packet] = seen
  expect(made).toBe(true)
  expect(packet?.prompt).toContain(`# HEAD\n\n${head}\n\n# Output\n\n${out}`)
  expect(packet?.reads).toEqual([out])
  expect(packet?.refuse(join(out, 'data.json'))).toBeNull()
  expect(ran(w)).toEqual(['fetcher'])
  expect(JSON.parse(maybe(w.root, 1, 'runs.json') ?? '')).toEqual([{ command: RUN, output: 'cold start:\n  41 ms' }])
})

test.each(['/tmp/x', '~/cf_work/../x', '~/cf_work'])('fetch D2: Output %s is refused at gather', async (named) => {
  const dir = home()
  const w = researching(`${ASK}**Output:** ${named}\n`)
  question(w.root, plan(w.db, 1))
  expect((await gathered(w))[0]).toEqual({ outcome: 'refuse', spans: ['ask.md'], note: `**Output:** ${named} is not a folder under ~/cf_work/` })
  expect(ran(w)).toEqual([])
  expect(readdirSync(dir)).toEqual([])
})

test('ruling D1/D2: an Output ruling reruns gather on fetcher', async () => {
  const out = join(home(), 'cf_work/1401a')
  const w = researching(MEASURE)
  const head = headed(w)
  expect(rule(w.db, w.root, plan(w.db, 1), 'director', '**Output:** ~/cf_work/1401a/')).toBe('ask.md')
  expect(maybe(w.root, 1, 'ask.md')).toMatch(/\n\*\*Output:\*\* ~\/cf_work\/1401a\/\n$/)
  question(w.root, plan(w.db, 1))
  let prompt = ''
  expect(await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), measuring(fence(entry(head)), (p) => { prompt = p.prompt })))
    .toMatchObject({ outcome: 'pass', note: expect.stringContaining('fetcher: answer.md written') as unknown })
  expect(prompt).toContain(`# Output\n\n${out}`)
  expect(existsSync(out)).toBe(true)
  expect(ran(w)).toEqual(['fetcher'])
})

test.each(['~/cf_work', '~/cf_work/../x', '~/.ssh/config'])('ruling D3: Output %s is refused', (named) => {
  home()
  const w = researching()
  expect(rule(w.db, w.root, plan(w.db, 1), 'director', `**Output:** ${named}`)).toBeNull()
  expect(maybe(w.root, 1, 'ask.md')).toBe(ASK)
})

test('ruling D4: a pr_path Output ruling is refused', () => {
  home()
  const w = world()
  expect(rule(w.db, w.root, plan(w.db, 1), 'director', '**Output:** ~/cf_work/x/')).toBeNull()
})

const NEEDS_RUN = 'This needs a timed run.\n\n```\n---\noutcome: needs_run\n---\n```\n'

test('needs_run D1: a researcher needs_run hands to the measurer', async () => {
  const w = researching()
  const head = headed(w)
  question(w.root, plan(w.db, 1))
  const prompts: string[] = []
  expect(await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), measuring(fence(entry(head)), (p) => prompts.push(p.prompt), TRANSCRIPT, NEEDS_RUN)))
    .toMatchObject({ outcome: 'pass', note: expect.stringContaining('measurer: answer.md written') as unknown })
  expect(ran(w)).toEqual(['researcher', 'measurer'])
  expect(prompts[1]).toContain(`# HEAD\n\n${head}`)
  expect(JSON.parse(maybe(w.root, 1, 'runs.json') ?? '')).toEqual([{ command: RUN, output: 'cold start:\n  41 ms' }])
})

test('needs_run D2: a handed measurer needs_run refuses its fence', async () => {
  const w = researching()
  headed(w)
  question(w.root, plan(w.db, 1))
  expect(await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), measuring(NEEDS_RUN, () => undefined, TRANSCRIPT, NEEDS_RUN)))
    .toMatchObject({ outcome: 'refuse', spans: ['researcher.fence'] })
  expect(ran(w)).toEqual(['researcher', 'measurer'])
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

const UNBUILT = 'ask needs network or writes outside .cf/measure/: add an **Output:** line naming a folder under ~/cf_work/ so the fetcher runs it'

test('needs_build D1: a measurer needs_build asks a person', async () => {
  const w = researching(MEASURE)
  headed(w)
  question(w.root, plan(w.db, 1))
  expect(await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), measuring(NEEDS_BUILD, () => undefined)))
    .toEqual({ outcome: 'needs_ceo', spans: ['ask.md'], note: UNBUILT })
  expect(maybe(w.root, 1, 'question.md')).toBe(UNBUILT)
  expect(maybe(w.root, 1, 'answer.md')).toBeNull()
  expect(maybe(w.root, 1, 'sources.json')).toBeNull()
  expect(maybe(w.root, 1, 'runs.json')).toBeNull()
})

test('needs_build D1: a handed measurer needs_build asks a person', async () => {
  const w = researching()
  headed(w)
  question(w.root, plan(w.db, 1))
  expect(await gather(w.db, w.root, plan(w.db, 1), mapOf('research').at(1), measuring(NEEDS_BUILD, () => undefined, TRANSCRIPT, NEEDS_RUN)))
    .toEqual({ outcome: 'needs_ceo', spans: ['ask.md'], note: UNBUILT })
  expect(maybe(w.root, 1, 'question.md')).toBe(UNBUILT)
  expect(ran(w)).toEqual(['researcher', 'measurer'])
})

test('needs_build D2: a ticked needs_build blocks with no refusal', async () => {
  const w = researching(MEASURE)
  headed(w)
  for (let n = 0; n < 4 && eventsOf(w.db, 1, 'gather').length === 0; n += 1) await tick(w.db, w.root, measuring(NEEDS_BUILD, () => undefined))
  expect(plan(w.db, 1)).toMatchObject({ state: 'blocked_on_ceo', step: 1 })
  expect(eventsOf(w.db, 1, 'gather')).toMatchObject([{ outcome: 'escalate', message: UNBUILT }])
  expect(refusalsOf(w.db, 1)).toBe(0)
  expect(ran(w).filter((seat) => seat === 'measurer')).toHaveLength(1)
})

test('needs_build D2: a researcher needs_build refuses its fence', async () => {
  const w = researching()
  question(w.root, plan(w.db, 1))
  expect((await gathered(w, NEEDS_BUILD))[0]).toMatchObject({ outcome: 'refuse', spans: ['researcher.fence'] })
  expect(ran(w)).toEqual(['researcher'])
})

const cite = (commit: string, quote = 'cold start: 41 ms', command = RUN): object => ({ run: { command, commit, quote, claim: 'Cold start is 41 ms' } })

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

const MOVED = ['https://github.com/o/r/blob/main/a.md', 'https://github.com/o/r/blob/master/a.md', 'https://raw.githubusercontent.com/o/r/main/a.pdf',
  'https://api.github.com/repos/o/r/commits/main', 'https://api.github.com/repos/o/r/git/trees/HEAD']

test.each(MOVED)('moving_ref D1: %s is refused', (url) => {
  const w = researching()
  expect(sourced(w.root, plan(w.db, 1), fence(LINKED.replace('https://a.example/doc', url))))
    .toEqual({ outcome: 'refuse', spans: ['research.moving_ref'], note: `moving ref in ${url}` })
  expect(maybe(w.root, 1, 'sources.json')).toBeNull()
})

test.each([...MOVED.map((url) => url.replace(/main|master|HEAD/, '2aee380')), `https://github.com/o/r/blob/${'a'.repeat(40)}/a.md`,
  'https://docs.example/main/a', 'https://a.example/doc'])('moving_ref D2 D3: %s passes', (url) => {
  const w = researching()
  expect(sourced(w.root, plan(w.db, 1), fence(LINKED.replace('https://a.example/doc', url)))).toMatchObject({ outcome: 'pass' })
})

const measured = (sources: (head: string) => object[]): ReturnType<typeof check> => {
  const w = researching(MEASURE)
  const head = headed(w)
  put(w.root, 1, 'sources.json', JSON.stringify(sources(head)))
  put(w.root, 1, 'runs.json', JSON.stringify([{ command: RUN, output: 'cold start:\n  41 ms' }]))
  put(w.root, 1, 'answer.md', 'Cold start is 41 ms [source:1].')
  return check(w.db, w.root, plan(w.db, 1))
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
