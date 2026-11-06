import { expect, test } from 'vitest'
import { all } from '../../cli/inbox.ts'
import { ofKind } from '../../store/events.ts'
import { record, type SignalRow } from '../../store/signals.ts'
import { started, words } from '../signals.ts'
import { get, maybe, put } from '../workspace.ts'
import { plan, watched, world, type World } from './world.ts'

const REVIEW = 'PRR_kwDOreview1'

const ASK = '# hello\n\n- **D1** add `hello()` in `src/hello.ts`\n'

const comment = (id: number, author: string, review: string, body: string, line: number | null = 3): object => ({
  databaseId: id, path: 'src/hello.ts', line, originalLine: 9, body, author: { login: author }, pullRequestReview: { id: review },
})

const answer = (threads: { isResolved: boolean; comments: { nodes: object[] } }[]): unknown =>
  ({ data: { repository: { pullRequest: { reviewThreads: { totalCount: threads.length, nodes: threads } } } } })

const UPSTREAM = answer([
  { isResolved: false, comments: { nodes: [comment(11, 'maintainer', REVIEW, 'rename\n  expires'), comment(12, 'maintainer', REVIEW, 'drop this', null)] } },
  { isResolved: false, comments: { nodes: [comment(13, 'greptile-apps[bot]', 'PRR_bot', 'null check')] } },
  { isResolved: true, comments: { nodes: [comment(14, 'maintainer', REVIEW, 'settled')] } },
  { isResolved: false, comments: { nodes: [comment(15, 'maintainer', 'PRR_older', 'from before')] } },
])

const FORK = answer([{ isResolved: false, comments: { nodes: [comment(16, 'greptile-apps[bot]', 'PRR_fork', 'rehearsal only')] } }])

function fired(kind: SignalRow['kind'], state: string | null, merged: (args: string[]) => unknown): { w: World; row: SignalRow } {
  const w = world()
  const row = record(w.db, { repo: 'acme/widget', pr: 7, kind, author: 'maintainer', at: new Date().toISOString(),
    external_id: REVIEW, score: kind === 'bot_review' ? 3 : null, plan: 1, body: 'see inline', state })
  if (row === null) throw new Error('signal not recorded')
  started(w.db, row, w.root, { ...watched([], w.root, 1), merged })
  return { w, row }
}

function reads(): { seen: string[][]; merged: (args: string[]) => unknown } {
  const seen: string[][] = []
  return { seen, merged: (args) => { seen.push(args); return args.includes('owner=caliperforge') ? FORK : UPSTREAM } }
}

test('D1 D2 the review\'s own and open bot comments are rows', () => {
  const { w, row } = fired('review', 'CHANGES_REQUESTED', reads().merged)
  expect(get(w.root, 1, 'ask.md')).toBe(`${ASK}\n${words(row)}\ninline:\n`
    + '- r11 maintainer src/hello.ts:3 rename expires\n- r12 maintainer src/hello.ts:9 drop this\n'
    + '- r13 greptile-apps[bot] src/hello.ts:3 null check\n')
})

test('D3 only the upstream pull request is read', () => {
  const { seen, merged } = reads()
  const { w } = fired('review', 'CHANGES_REQUESTED', merged)
  expect(get(w.root, 1, 'ask.md')).not.toContain('rehearsal only')
  expect(seen.map((a) => a.filter((x) => /^(owner|name|no)=/.test(x)))).toEqual([['owner=acme', 'name=widget', 'no=7']])
})

test('D4 a read that throws leaves the ask as the words', () => {
  const { w, row } = fired('review', 'CHANGES_REQUESTED', () => { throw new Error('gh: rate limited') })
  expect(get(w.root, 1, 'ask.md')).toBe(`${ASK}\n${words(row)}`)
  expect(plan(w.db, 1).step).toBe(1)
  expect(ofKind(w.db, 'swallowed')).toEqual([{ plan: 1, kind: 'swallowed', actor: 'review', outcome: 'pass', message: 'gh: rate limited' }])
})

const HEAD = 'a'.repeat(40)

const FINDING = '- G11 rust/src/ledger/mod.rs:1063 Unused device handles accumulate'

function bot(score: number, finding: boolean): { w: World; row: SignalRow; step: number | undefined } {
  const w = world()
  if (finding) put(w.root, 1, `findings-${HEAD}.md`, `${FINDING}\n`)
  const row = record(w.db, { repo: 'acme/widget', pr: 7, kind: 'bot_review', author: 'greptile-apps[bot]', at: new Date().toISOString(),
    external_id: `g@${HEAD}`, score, plan: 1, body: `Confidence Score: ${String(score)}/5\n\n1. a numbered finding`, head: HEAD })
  if (row === null) throw new Error('signal not recorded')
  return { w, row, step: started(w.db, row, w.root)?.step }
}

const asked = (w: World): object[] => all(w.root).filter((e) => e.kind === 'asked').map((e) => ({ step: e.step, name: e.name, note: e.note }))

test('a bot inline finding goes to the build, words and inbox', () => {
  const { w, row, step } = bot(4, true)
  expect(step).toBe(2)
  expect(plan(w.db, 1).step).toBe(2)
  expect(get(w.root, 1, 'refusal.md')).toBe(`${words(row)}\n${FINDING}\n`)
  expect(asked(w)).toEqual([{ step: 2, name: 'build', note: `greptile-apps[bot]: ${FINDING}` }])
})

test('a score-only bot review stays at review with its words', () => {
  const { w, row, step } = bot(4, false)
  expect(step).toBe(4)
  expect(get(w.root, 1, 'refusal.md')).toBe(words(row))
  expect(asked(w)).toEqual([{ step: 4, name: 'review', note: 'greptile-apps[bot]: Confidence Score: 4/5 1. a numbered finding' }])
})

test('a 5/5 bot review writes nothing', () => {
  const { w, step } = bot(5, true)
  expect(step).toBeUndefined()
  expect(maybe(w.root, 1, 'refusal.md')).toBeNull()
  expect(asked(w)).toEqual([])
})

test('D5 a comment, COMMENTED review or bot review reads nothing', () => {
  for (const [kind, state] of [['review', 'COMMENTED'], ['comment', null], ['bot_review', null]] as const) {
    const { seen, merged } = reads()
    const { w, row } = fired(kind, state, merged)
    expect(seen).toEqual([])
    expect(get(w.root, 1, 'ask.md')).toBe(kind === 'bot_review' ? ASK : `${ASK}\n${words(row)}`)
  }
})
