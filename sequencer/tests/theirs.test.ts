import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { waiting } from '../card.ts'
import { theirs } from '../theirs.ts'
import { checkout, get, git, srcDir } from '../workspace.ts'
import { world, type World } from './world.ts'

const TARGET = { repo: 'acme/widget', issue_no: 12, named_merger: 'maintainer' }
const URL = 'https://github.com/acme/widget/pull/40'
const PASS = { check: 'their work', ok: true, says: 'nothing of theirs touches our files or names #12' }

const pr = (over: object): object => ({ url: URL, title: 't', body: '', isDraft: false, author: { login: 'maintainer' },
  headRepositoryOwner: { login: 'maintainer' }, files: [], ...over })

const canned = (prs: object[], found: object[] = []) => (args: string[]): unknown => args[0] === 'search' ? found : prs

function ours(): World {
  const w = world()
  checkout(w.root, 1, 'acme/widget', 'widget-12-a1')
  writeFileSync(join(srcDir(w.root, 1), 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
  return w
}

test('D1 a PR by the named merger on our file is flagged and the card holds', () => {
  const w = ours()
  const check = theirs(canned([pr({ files: [{ path: 'src/hello.ts' }] })]))
  expect(check(w.db, w.root, 1, TARGET)).toEqual({ check: 'their work', ok: false, says: `pr ${URL} touches src/hello.ts` })
  expect(waiting(w.db, w.root, 1, 'a'.repeat(40), TARGET, [check])).toMatchObject({ held: true, spans: ['card'] })
  expect(get(w.root, 1, 'maintainer.md')).toContain(`flag\ttheir work\tpr ${URL} touches src/hello.ts\n`)
})

test('D2 a draft naming the issue on none of our files is flagged as naming it', () => {
  const w = ours()
  const draft = pr({ isDraft: true, author: { login: 'other' }, headRepositoryOwner: { login: 'acme' }, body: 'fixes #12' })
  expect(theirs(canned([draft]))(w.db, w.root, 1, TARGET).says).toBe(`draft ${URL} names #12`)
})

test('D3 our fork, an outsider fork and a search hit in the repo itself pass', () => {
  const w = ours()
  const files = [{ path: 'src/hello.ts' }]
  const read = canned([
    pr({ headRepositoryOwner: { login: 'caliperforge' }, files }),
    pr({ author: { login: 'outsider' }, headRepositoryOwner: { login: 'outsider' }, files }),
  ], [{ url: URL, repository: { nameWithOwner: 'acme/widget' } }])
  expect(theirs(read)(w.db, w.root, 1, TARGET)).toEqual(PASS)
})

test('D4 an open PR in another repo of the org naming the issue is flagged', () => {
  const w = ours()
  const other = 'https://github.com/acme/gadget/pull/3'
  const read = canned([], [{ url: other, repository: { nameWithOwner: 'acme/gadget' } }])
  expect(theirs(read)(w.db, w.root, 1, TARGET)).toMatchObject({ ok: false, says: `pr ${other} names #12` })
})

test('D5 a recent upstream branch on our file is flagged with its tree link, main never', () => {
  const w = ours()
  const dir = srcDir(w.root, 1)
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'hello'])
  git(dir, ['push', '-q', 'upstream', 'HEAD:refs/heads/fix-hello'])
  expect(theirs(canned([]))(w.db, w.root, 1, TARGET)).toEqual({ check: 'their work', ok: false,
    says: 'branch https://github.com/acme/widget/tree/fix-hello touches src/hello.ts' })
})

test('D6 an orphan upstream branch with no history in common with main passes', () => {
  const w = ours()
  const dir = srcDir(w.root, 1)
  const tree = git(dir, ['hash-object', '-t', 'tree', '-w', '/dev/null']).trim()
  const orphan = git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit-tree', tree, '-m', 'badges']).trim()
  git(dir, ['push', '-q', 'upstream', `${orphan}:refs/heads/badges`])
  expect(theirs(canned([]))(w.db, w.root, 1, TARGET)).toEqual(PASS)
})
