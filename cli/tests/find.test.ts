import { expect, test } from 'vitest'
import { find } from '../find.ts'
import type { Read } from '../gh.ts'

const URL = 'https://github.com/acme/widget/issues/12'
const SAID = { author: { login: 'keeper' }, body: 'yes please', url: `${URL}#issuecomment-1` }

const issue = (over: object = {}): object => ({ number: 12, title: 't', body: 'b', state: 'OPEN', url: URL,
  author: { login: 'reporter' }, assignees: [], comments: [SAID], closedByPullRequestsReferences: [], projectItems: [], ...over })

const merge = (no: number, author: string): object => ({ url: `https://github.com/acme/widget/pull/${String(no)}`,
  author: { login: author }, mergedBy: { login: 'keeper' }, body: 'one\ntwo', additions: 10, deletions: 2,
  files: [{ path: 'src/a.ts' }, { path: 'src/a.test.ts' }] })

interface Canned { issue?: object; merged?: object[]; open?: object[]; siblings?: object[] }

function gh(c: Canned = {}): Read {
  return (args) => {
    if (args[0] === 'issue') return c.issue ?? issue()
    if (args[0] === 'search') return c.siblings ?? []
    if (args[1] === 'view') return { headRepositoryOwner: { login: 'stranger' } }
    return args.includes('merged') ? (c.merged ?? [merge(1, 'keeper'), merge(2, 'outsider')]) : (c.open ?? [])
  }
}

test('D1: a maintainer comment, no claim and one outsider merge answer yes three times, each with a link', () => {
  expect(find('acme/widget', 12, false, gh())).toEqual({ park: null, section: ['## Target check', '',
    `- wanted: yes — a maintainer commented ${URL}#issuecomment-1`,
    `- unclaimed: yes — no assignee, claim, closer or sibling pull request ${URL}`,
    '- shape: yes — match p50 2 files, 12 lines, 1 test files, 2 body lines: https://github.com/acme/widget/pull/2', ''].join('\n') })
})

test.each([
  { why: 'no maintainer and no board', canned: { issue: issue({ comments: [] }) },
    park: `wanted: no maintainer opened or commented on it, and it is on no board ${URL}` },
  { why: 'an assignee', canned: { issue: issue({ assignees: [{ login: 'someone' }] }) }, park: `unclaimed: assigned to someone ${URL}` },
  { why: 'a claiming comment', canned: { issue: issue({ comments: [SAID, { author: { login: 'x' }, body: "I'll take this", url: `${URL}#c2` }] }) },
    park: `unclaimed: a comment claims the issue ${URL}` },
  { why: 'a linked closer', canned: { issue: issue({ closedByPullRequestsReferences: [{ number: 9 }] }) },
    park: 'unclaimed: pull request #9 implements it https://github.com/acme/widget/pull/9' },
  { why: 'an open sibling-repo PR', canned: { siblings: [{ url: 'https://github.com/acme/widget-py/pull/3', repository: { nameWithOwner: 'acme/widget-py' } }] },
    park: 'unclaimed: an open pull request in acme/widget-py names it https://github.com/acme/widget-py/pull/3' },
])('D2: $why parks the target, naming the question', ({ canned, park }) => {
  expect(find('acme/widget', 12, false, gh(canned)).park).toBe(park)
})

test('D3: no merged outsider PR parks; a small, odd shape does not', () => {
  expect(find('acme/widget', 12, false, gh({ merged: [merge(1, 'keeper')] })).park)
    .toBe('shape: no merged outsider PR in the last 100 merges')
  const odd = { ...merge(2, 'outsider'), files: [], additions: 0, deletions: 0, body: '' }
  expect(find('acme/widget', 12, false, gh({ merged: [merge(1, 'keeper'), odd] })).park).toBeNull()
})

test('D6: a foreign PR that only references the issue parks an uncarded ask, not a carded one', () => {
  const open = [{ number: 5, title: 'x', body: 'fixes #12', headRepositoryOwner: { login: 'stranger' } }]
  expect(find('acme/widget', 12, true, gh({ open })).park).toBeNull()
  expect(find('acme/widget', 12, false, gh({ open })).park)
    .toBe('unclaimed: open pull request #5 references it https://github.com/acme/widget/pull/5')
})
