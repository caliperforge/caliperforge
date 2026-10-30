import { expect, test } from 'vitest'
import { ofKind } from '../../store/events.ts'
import { record, type SignalRow } from '../../store/signals.ts'
import { started, words } from '../signals.ts'
import { get } from '../workspace.ts'
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

test('D5 a comment, COMMENTED review or bot review reads nothing', () => {
  for (const [kind, state] of [['review', 'COMMENTED'], ['comment', null], ['bot_review', null]] as const) {
    const { seen, merged } = reads()
    const { w, row } = fired(kind, state, merged)
    expect(seen).toEqual([])
    expect(get(w.root, 1, 'ask.md')).toBe(kind === 'bot_review' ? ASK : `${ASK}\n${words(row)}`)
  }
})
