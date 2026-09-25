import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { desk as ghDesk, type Answer, type Desk, type Pr, type Seen } from '../../cli/gh.ts'
import { unread } from '../../cli/inbox.ts'
import { rewind } from '../../store/plans.ts'
import { tick } from '../index.ts'
import { ruled, signoffs } from '../signoff.ts'
import { put, SELF, SIGNOFF, srcDir } from '../workspace.ts'
import { approve, CARRIED, plan, stub, watched, world, type World } from './world.ts'

/** Their pull request as the tick reads it, offline: open and quiet. */
const quiet = (): Pr => ({
  number: 7, url: 'https://github.com/acme/widget/pull/7', state: 'OPEN', mergedAt: null, mergedBy: null,
  reviewDecision: null, comments: [], reviews: [], statusCheckRollup: [],
})

async function atBatch(): Promise<World> {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  writeFileSync(join(srcDir(w.root, 1), 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  expect(plan(w.db, 1).step).toBe(7)
  return w
}

interface Held { title: string; body: string; open: boolean; answer: Answer | null; words: string | null; closing: string | null }

/** The tracker as a map: a test answers a card by setting its label and words. */
function fake(): Desk & { cards: Map<number, Held>; log: string[] } {
  const cards = new Map<number, Held>()
  const log: string[] = []
  const card = (no: number): Held => {
    const held = cards.get(no)
    if (held === undefined) throw new Error(`no card ${String(no)}`)
    return held
  }
  return {
    cards,
    log,
    open: (title, body) => {
      const no = cards.size + 100
      cards.set(no, { title, body, open: true, answer: null, words: null, closing: null })
      log.push(`open ${String(no)}`)
      return { no, url: `https://github.com/${SIGNOFF}/issues/${String(no)}` }
    },
    seen: (no): Seen => ({ answer: card(no).answer, words: card(no).words, open: card(no).open }),
    unlabel: (no, label) => { log.push(`unlabel ${String(no)} ${label}`); card(no).answer = null },
    close: (no, comment) => { log.push(`close ${String(no)}`); card(no).open = false; card(no).closing = comment },
  }
}

test('an outside plan at sign-off gets one card, and the card links nothing on their thread', async () => {
  const w = await atBatch()
  const desk = fake()
  expect(signoffs(w.db, w.root, desk)).toEqual([{ plan: 1, card: 100, did: 'opened' }])
  expect(signoffs(w.db, w.root, desk)).toEqual([])
  const card = desk.cards.get(100)
  expect(card?.title).toBe('Sign-off: widget 12, hello')
  expect(card?.body).toContain('titled `hello`')
  expect(card?.body).toContain('```markdown\nAddresses #12.')
  expect(card?.body).toContain('https://github.com/caliperforge/widget/commit/')
  expect(card?.body).toContain('pre_review pass, review pass, senior_review pass, ready pass')
  const outside = (card?.body ?? '').replace(/```markdown[\s\S]*?\n```\n/, '').replace(/`[^`]*`/g, '')
  expect(outside).not.toMatch(/#\d|acme\/widget|github\.com\/acme/)
  expect(unread(w.root).map((e) => [e.kind, e.ticket])).toEqual([['signoff', 'acme/widget#12']])
})

test('go signs the head the card showed, closes the card, and the next tick sends it', async () => {
  const w = await atBatch()
  const desk = fake()
  signoffs(w.db, w.root, desk)
  const card = desk.cards.get(100)
  if (card !== undefined) card.answer = 'go'
  expect(signoffs(w.db, w.root, desk)).toEqual([{ plan: 1, card: 100, did: 'go' }])
  expect(w.db.prepare("SELECT who, decision, subject_digest FROM approvals WHERE subject_kind = 'plan'").get())
    .toEqual({ who: 'ceo', decision: 'approved', subject_digest: plan(w.db, 1).head_digest })
  expect(card).toMatchObject({ open: false })
  const sent: string[] = []
  await tick(w.db, w.root, stub(CARRIED), undefined, quiet, watched(sent, w.root, 1))
  await tick(w.db, w.root, stub(CARRIED), undefined, quiet, watched(sent, w.root, 1))
  expect(sent).toContain('open acme/widget caliperforge:widget-12-a1')
  expect(signoffs(w.db, w.root, desk)).toEqual([])
})

test('no with words sends it back to the builder with them', async () => {
  const w = await atBatch()
  const desk = fake()
  signoffs(w.db, w.root, desk)
  const card = desk.cards.get(100)
  if (card !== undefined) { card.answer = 'no'; card.words = 'Call it expiry, not expires.' }
  expect(signoffs(w.db, w.root, desk)).toEqual([{ plan: 1, card: 100, did: 'no' }])
  expect(plan(w.db, 1)).toMatchObject({ step: 2, state: 'running', head_digest: null })
  expect(readFileSync(join(w.root, '.cf/work/1/refusal.md'), 'utf8')).toContain('Call it expiry, not expires.')
  const brief = readFileSync(join(w.root, '.cf/work/1/issue.md'), 'utf8')
  expect(brief).toContain(`- D3 The CEO's ruling at sign-off (${new Date().toISOString().slice(0, 10)}): Call it expiry, not expires.`)
  expect(brief.split('## Must not break')[1]?.split('## ')[0]).toContain("The CEO's ruling at sign-off")
  expect(w.db.prepare("SELECT decision, reason FROM approvals WHERE subject_kind = 'plan'").get())
    .toEqual({ decision: 'refused', reason: 'signoff.no' })
})

test('no alone waits for the coo', async () => {
  const bare = await atBatch()
  const quiet = fake()
  signoffs(bare.db, bare.root, quiet)
  const other = quiet.cards.get(100)
  if (other !== undefined) other.answer = 'no'
  signoffs(bare.db, bare.root, quiet)
  expect(plan(bare.db, 1)).toMatchObject({ step: 7, state: 'blocked_on_ceo' })
  expect(signoffs(bare.db, bare.root, quiet)).toEqual([])
  expect(unread(bare.root).map((e) => e.kind)).toEqual(['signoff', 'asked'])
})

test('talk hands it to the coo and leaves the card open for an answer', async () => {
  const w = await atBatch()
  const desk = fake()
  signoffs(w.db, w.root, desk)
  const card = desk.cards.get(100)
  if (card !== undefined) card.answer = 'talk'
  expect(signoffs(w.db, w.root, desk)).toEqual([{ plan: 1, card: 100, did: 'talk' }])
  expect(desk.log).toEqual(['open 100', 'unlabel 100 talk'])
  expect(card).toMatchObject({ open: true })
  expect(unread(w.root).at(-1)).toMatchObject({ kind: 'asked' })
  expect(signoffs(w.db, w.root, desk)).toEqual([])
})

test('a new head closes the old card and opens the next; a job sent back closes its card', async () => {
  const w = await atBatch()
  const desk = fake()
  signoffs(w.db, w.root, desk)
  put(w.root, 1, 'signoff', `100 ${'f'.repeat(64)} https://github.com/${SIGNOFF}/issues/100\n`)
  expect(signoffs(w.db, w.root, desk)).toEqual([{ plan: 1, card: 100, did: 'superseded' }, { plan: 1, card: 101, did: 'opened' }])
  expect(desk.cards.get(100)?.closing).toMatch(/^Superseded/)
  rewind(w.db, 1, 4)
  expect(signoffs(w.db, w.root, desk)).toEqual([{ plan: 1, card: 101, did: 'withdrawn' }])
  expect(desk.cards.get(101)?.closing).toMatch(/^Withdrawn/)
})

test('only the label the owner of the gh credential set is an answer', () => {
  const read = (args: string[]): unknown => args[0] === 'issue'
    ? { state: 'OPEN', labels: [{ name: 'go' }, { name: 'talk' }],
      comments: [{ author: { login: 'stranger' }, body: 'ship it' }, { author: { login: 'michael-moffett' }, body: 'one question' }] }
    : [
      { event: 'labeled', actor: { login: 'michael-moffett' }, label: { name: 'talk' } },
      { event: 'labeled', actor: { login: 'stranger' }, label: { name: 'go' } },
    ]
  const seen = ghDesk('caliperforge/caliperforge', read, () => 'michael-moffett\n').seen(5)
  expect(seen).toEqual({ answer: 'talk', words: 'one question', open: true })
})

test('the card names every workflow and says green only of what is', async () => {
  const w = await atBatch()
  put(w.root, 1, 'ci.json', JSON.stringify([
    { workflow: 'Ruby', status: 'completed', conclusion: 'success', gates: true },
    { workflow: 'Python', status: 'completed', conclusion: 'failure', gates: false },
  ]))
  const desk = fake()
  signoffs(w.db, w.root, desk)
  const body = desk.cards.get(100)?.body ?? ''
  expect(body).toContain('but 1 of their workflows is not green')
  expect(body).toContain('- Their CI on our fork: Ruby green; also ran, not judged on: Python red')
})

test('a ruling lands as the next D row and a Must not break line, or in its own section', () => {
  const brief = '# t\n\n## Cases\n\n- D1 a\n- D2 b\n\n## Must not break\n\n- c\n\n## Files\n\n- `a/b.ts`\n'
  expect(ruled(brief, 'Only\nthe number.', '2026-09-21')).toBe('# t\n\n## Cases\n\n- D1 a\n- D2 b\n'
    + "- D3 The CEO's ruling at sign-off (2026-09-21): Only the number.\n\n## Must not break\n\n- c\n"
    + "- The CEO's ruling at sign-off (2026-09-21): Only the number.\n\n## Files\n\n- `a/b.ts`\n")
  expect(ruled('# t\n\nfree text\n', 'x', '2026-09-21')).toBe("# t\n\nfree text\n\n## The CEO's rulings\n\n- D1 The CEO's ruling at sign-off (2026-09-21): x\n")
})

/** #97: on plan 65 the PR text came from the hand build and never mentioned two Lua files the machine changed. */
test('the card names a changed file the PR text written in advance leaves out', async () => {
  const bodyWith = async (pr: string): Promise<string> => {
    const w = await atBatch()
    put(w.root, 1, 'pr.md', pr)
    const desk = fake()
    signoffs(w.db, w.root, desk)
    return desk.cards.get(100)?.body ?? ''
  }
  expect(await bodyWith('Says hey.\n')).toContain('**Not in the PR text:** `src/hello.ts`')
  expect(await bodyWith('`hello.ts` says hey.\n')).not.toContain('Not in the PR text')
})

/** #102: the cards carry unposted PR text and the CEO's answers, so they live apart from our public repo. */
test('the cards live on the private sign-off repo, not ours', () => {
  expect(SIGNOFF).toBe('caliperforge/signoff')
  expect(SIGNOFF).not.toBe(SELF)
})
