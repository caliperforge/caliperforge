import { expect, test } from 'vitest'
import type { Read } from '../../cli/gh.ts'
import { stanceOf } from '../stance.ts'

const REPO = 'acme/widget'
const COMMENT = 'https://github.com/acme/widget/issues/12#issuecomment-1'
const PR = 'https://github.com/acme/widget/pull/2'
const AGENTS = 'I will not accept code from external and autonomous agents'

interface Fake { files?: Record<string, string>; comments?: { body: string; author_association: string }[]; merged?: [string, string][] }

/** Each file's sha is its path; `src/main.ts` is in every tree and throws if it is fetched. */
function gh({ files = {}, comments = [], merged = [] }: Fake): Read {
  return (args) => {
    const path = String(args[1])
    if (path.includes('/git/trees/')) return { tree: [...Object.keys(files), 'src/main.ts'].map((p) => ({ path: p, type: 'blob', sha: p })) }
    if (path.includes('/git/blobs/')) {
      const text = files[path.split('/git/blobs/')[1] ?? '']
      if (text === undefined) throw new Error(`fetched ${path}`)
      return { content: Buffer.from(text).toString('base64') }
    }
    if (path.includes('/comments')) return comments.map((c) => ({ ...c, html_url: COMMENT, user: { login: 'someone' } }))
    return merged.map(([login, body], i) => ({ url: `${PR}${i === 0 ? '' : String(i)}`, author: { login }, mergedBy: { login: 'keeper' }, body }))
  }
}

test('D1 no AI-generated contributions in CONTRIBUTING is closed', () => {
  expect(stanceOf(REPO, 12, gh({ files: { 'CONTRIBUTING.md': '# Contributing\n\nPlease, no AI-generated contributions.\n' } }))).toEqual({
    stance: 'closed', says: '"Please, no AI-generated contributions." https://github.com/acme/widget/blob/HEAD/CONTRIBUTING.md#L3' })
})

test('D5 a MEMBER refusing agents is closed, citing the comment', () => {
  expect(stanceOf(REPO, 12, gh({ comments: [{ body: AGENTS, author_association: 'MEMBER' }] })))
    .toEqual({ stance: 'closed', says: `"${AGENTS}" ${COMMENT}` })
})

test('D5 the same words from a NONE author do not count', () => {
  expect(stanceOf(REPO, 12, gh({ comments: [{ body: AGENTS, author_association: 'NONE' }] })).stance).toBe('unstated')
})

test('D6 an outside merge generated with Claude Code is open', () => {
  expect(stanceOf(REPO, 12, gh({ merged: [['outsider', 'Fixes #3\r\n\r\nGenerated with Claude Code'], ['keeper', 'AI-assisted']] })))
    .toEqual({ stance: 'open', says: `"Generated with Claude Code" ${PR}` })
})

test('a permission outweighs a negated line and unchecked options', () => {
  const read = gh({ files: {
    'CONTRIBUTING.md': '## AI-assisted contributions\n\nYou may use AI-assisted tools.\nYou must be able to explain every line of your diff without an LLM.\n',
    '.github/pull_request_template.md': '- [ ] No AI tooling was used beyond editor autocomplete.\n- [ ] AI tooling was used.\n',
  } })
  expect(stanceOf(REPO, 12, read)).toEqual({
    stance: 'open', says: '"You may use AI-assisted tools." https://github.com/acme/widget/blob/HEAD/CONTRIBUTING.md#L3' })
})

test('a ban is closed even beside a permission', () => {
  const ban = 'We do not accept AI-generated contributions.'
  expect(stanceOf(REPO, 12, gh({ files: { 'CONTRIBUTING.md': `You may use AI-assisted tools.\n${ban}\n` } }))).toEqual({
    stance: 'closed', says: `"${ban}" https://github.com/acme/widget/blob/HEAD/CONTRIBUTING.md#L2` })
  expect(stanceOf(REPO, 12, gh({ files: { 'CONTRIBUTING.md': 'PRs written by AI will be closed.\n' } })).stance).toBe('closed')
})

test('task-list option lines alone are unstated', () => {
  const read = gh({ files: { '.github/pull_request_template.md': '- [ ] No AI tooling was used beyond editor autocomplete.\n' } })
  expect(stanceOf(REPO, 12, read)).toEqual({ stance: 'unstated', says: 'no statement in 1 files, 0 maintainer comments, 0 outside merges in 90 days' })
})

test('a negated welcome is closed', () => {
  expect(stanceOf(REPO, 12, gh({ files: { 'CONTRIBUTING.md': 'AI contributions are not welcome.\n' } })).stance).toBe('closed')
})

test('unstated counts files, maintainer comments, outside merges', () => {
  const read = gh({ files: { 'CONTRIBUTING.md': 'Run the tests.\n' }, comments: [{ body: 'thanks', author_association: 'OWNER' }],
    merged: [['outsider', 'b'], ['keeper', 'b']] })
  expect(stanceOf(REPO, 12, read)).toEqual({ stance: 'unstated', says: 'no statement in 1 files, 1 maintainer comments, 1 outside merges in 90 days' })
})
