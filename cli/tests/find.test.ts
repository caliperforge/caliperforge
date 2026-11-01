import { expect, test } from 'vitest'
import { find } from '../find.ts'
import type { Read } from '../gh.ts'

const URL = 'https://github.com/acme/widget/issues/12'
const SAID = { author: { login: 'keeper' }, body: 'yes please', url: `${URL}#issuecomment-1` }
const SIGNED = { target: 57, digest: '0123456789abcdef'.repeat(4) }

const issue = (over: object = {}): object => ({ number: 12, title: 't', body: 'b', state: 'OPEN', url: URL,
  author: { login: 'reporter' }, assignees: [], comments: [SAID], closedByPullRequestsReferences: [], projectItems: [], ...over })

const merge = (no: number, author: string): object => ({ url: `https://github.com/acme/widget/pull/${String(no)}`,
  author: { login: author }, mergedBy: { login: 'keeper' }, body: 'one\ntwo', additions: 10, deletions: 2,
  files: [{ path: 'src/a.ts' }, { path: 'src/a.test.ts' }] })

const sibling = (over: object = {}): object => ({ url: 'https://github.com/acme/widget-py/pull/3', title: 'x', body: '',
  repository: { nameWithOwner: 'acme/widget-py' }, ...over })
const SIBLING = 'unclaimed: an open pull request in acme/widget-py names it https://github.com/acme/widget-py/pull/3'

interface Canned { issue?: object; merged?: object[]; open?: object[]; siblings?: object[] }

function gh(c: Canned = {}): Read {
  return (args) => {
    if (args[0] === 'issue') return c.issue ?? issue()
    if (args[0] === 'search') return c.siblings ?? []
    if (args[1] === 'view') return { headRepositoryOwner: { login: 'stranger' } }
    return args.includes('merged') ? (c.merged ?? [merge(1, 'keeper'), merge(2, 'outsider')]) : (c.open ?? [])
  }
}

test('maintainer comment, no claim, outsider merge: 3 linked yes', () => {
  expect(find('acme/widget', 12, false, null, gh())).toEqual({ park: null, section: ['## Target check', '',
    `- wanted: yes — a maintainer commented ${URL}#issuecomment-1`,
    `- unclaimed: yes — no assignee, claim, closer or sibling pull request ${URL}`,
    '- shape: yes — match p50 2 files, 12 lines, 1 test files, 2 body lines: https://github.com/acme/widget/pull/2', ''].join('\n') })
})

test('D1: a CEO sign-off answers wanted with no maintainer', () => {
  const found = find('acme/widget', 12, false, SIGNED, gh({ issue: issue({ comments: [] }) }))
  expect(found.park).toBeNull()
  expect(found.section).toContain('\n- wanted: yes — the CEO approved target 57 (0123456789ab)\n')
})

test.each([
  { why: 'no maintainer and no board', canned: { issue: issue({ comments: [] }) },
    park: `wanted: no maintainer opened or commented on it, and it is on no board ${URL}` },
  { why: 'an assignee', canned: { issue: issue({ assignees: [{ login: 'someone' }] }) }, park: `unclaimed: assigned to someone ${URL}` },
  { why: 'a claiming comment', canned: { issue: issue({ comments: [SAID, { author: { login: 'x' }, body: "I'll take this", url: `${URL}#c2` }] }) },
    park: `unclaimed: a comment claims the issue ${URL}` },
  { why: 'a linked closer', canned: { issue: issue({ closedByPullRequestsReferences: [{ number: 9 }] }) },
    park: 'unclaimed: pull request #9 implements it https://github.com/acme/widget/pull/9' },
  { why: 'an open sibling-repo PR', canned: { siblings: [sibling({ body: 'fixes acme/widget#12' })] }, park: SIBLING },
])('D2: $why parks the target, naming the question', ({ canned, park }) => {
  expect(find('acme/widget', 12, false, null, gh(canned)).park).toBe(park)
})

test('D1: a sibling with only an image width is no claim', () => {
  const found = find('acme/widget', 12, false, null, gh({ siblings: [sibling({ body: '<img width="12" src="x">' })] }))
  expect(found.park).toBeNull()
  expect(found.section).toContain(`\n- unclaimed: yes — no assignee, claim, closer or sibling pull request ${URL}\n`)
})

test.each([
  { why: 'the issue URL', over: { body: URL } },
  { why: 'a trailing slash', over: { body: `${URL}/` } },
  { why: 'a fragment', over: { body: `${URL}#issuecomment-1` } },
  { why: 'another case in the title', over: { title: 'ACME/Widget#12' } },
])('D3: a sibling naming it by $why parks', ({ over }) => {
  expect(find('acme/widget', 12, false, null, gh({ siblings: [sibling(over)] })).park).toBe(SIBLING)
})

test.each(['acme/widget#123', `${URL}3`])('D4: a sibling naming only #123 does not park', (body) => {
  expect(find('acme/widget', 12, false, null, gh({ siblings: [sibling({ body })] })).park).toBeNull()
})

test('D5: a hit in the target repo itself never counts', () => {
  const own = sibling({ body: 'fixes acme/widget#12', repository: { nameWithOwner: 'acme/widget' } })
  expect(find('acme/widget', 12, false, null, gh({ siblings: [own] })).park).toBeNull()
})

test.each([
  { why: 'a claim', canned: { issue: issue({ comments: [], assignees: [{ login: 'someone' }] }) },
    park: `unclaimed: assigned to someone ${URL}` },
  { why: 'shape', canned: { issue: issue({ comments: [] }), merged: [merge(1, 'keeper')] },
    park: 'shape: no merged outsider PR in the last 100 merges' },
])('D3: a CEO sign-off still parks on $why', ({ canned, park }) => {
  expect(find('acme/widget', 12, false, SIGNED, gh(canned)).park).toBe(park)
})

test('D3: no merged outsider PR parks; a small, odd shape does not', () => {
  expect(find('acme/widget', 12, false, null, gh({ merged: [merge(1, 'keeper')] })).park)
    .toBe('shape: no merged outsider PR in the last 100 merges')
  const odd = { ...merge(2, 'outsider'), files: [], additions: 0, deletions: 0, body: '' }
  expect(find('acme/widget', 12, false, null, gh({ merged: [merge(1, 'keeper'), odd] })).park).toBeNull()
})

test('foreign referencing PR parks an uncarded ask, not a carded', () => {
  const open = [{ number: 5, title: 'x', body: 'fixes #12', headRepositoryOwner: { login: 'stranger' } }]
  expect(find('acme/widget', 12, true, null, gh({ open })).park).toBeNull()
  expect(find('acme/widget', 12, false, null, gh({ open })).park)
    .toBe('unclaimed: open pull request #5 references it https://github.com/acme/widget/pull/5')
})

test('our own assignment and claim leave it unclaimed', () => {
  const ours = issue({ assignees: [{ login: 'michael-moffett' }],
    comments: [SAID, { author: { login: 'michael-moffett' }, body: "I'd like to take this one", url: `${URL}#c3` }] })
  expect(find('acme/widget', 12, false, null, gh({ issue: ours })).park).toBeNull()
})
