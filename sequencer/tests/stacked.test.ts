import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { CARD } from '../../cli/queue.ts'
import { verdictRows } from '../../store/verdict.ts'
import { tick } from '../index.ts'
import type { Fired } from '../kind.ts'
import { headOf } from '../push.ts'
import { stacked } from '../stacked.ts'
import { put, srcDir } from '../workspace.ts'
import { git } from './bases.ts'
import { approve, built, builds, plan, watched, world, type World } from './world.ts'

const URL = 'https://github.com/acme/widget/pull/350'

const listed = (files: string[], over: object = {}): object[] => [{ number: 350, url: URL, headRefName: 'p350',
  headRepositoryOwner: { login: 'caliperforge' }, files: files.map((path) => ({ path })), ...over }]

/** Our open pull request on the fork: a different last line on `src/hello.ts` than the job appends. */
function open350(root: string): void {
  const fork = join(root, 'remotes/caliperforge/widget')
  git(fork, ['checkout', '-qb', 'p350'])
  const path = join(fork, 'src/hello.ts')
  writeFileSync(path, `${readFileSync(path, 'utf8')}export const stay = 2\n`)
  git(fork, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'ours on hello'])
  git(fork, ['checkout', '-q', 'main'])
}

const atReady = async (files: string[], ask?: string): Promise<[World, () => Promise<Fired | undefined>]> => {
  const w = world()
  approve(w.db, w.target)
  if (ask !== undefined) put(w.root, 1, 'ask.md', ask)
  open350(w.root)
  const wire = { ...watched([], w.root, 1), merged: () => listed(files) }
  const provider = builds(() => { built(w.root, 1, 'export const bye = 1') })
  const lap = async (): Promise<Fired | undefined> => (await tick(w.db, w.root, provider, undefined, undefined, wire))[0]
  for (let at = 0; at < 6; at += 1) await lap()
  expect(plan(w.db, 1).step).toBe(6)
  return [w, lap]
}

const inSrc = (w: World, args: string[]): string => execFileSync('git', args, { cwd: srcDir(w.root, 1), encoding: 'utf8' })

const readyVerdicts = (w: World): number => verdictRows(w.db, 1).filter((v) => v.rail_id === 'ready').length

test('D1 D6 a conflict with our open PR goes back to the build', async () => {
  const [w, lap] = await atReady(['src/hello.ts'])
  const head = headOf(w.root, 1).sha
  const fired = await lap()
  expect(fired).toMatchObject({ step: 6, outcome: 'refuse', spans: [URL, 'src/hello.ts'] })
  expect(fired?.note).toContain(`${URL} conflicts on src/hello.ts`)
  expect(plan(w.db, 1).step).toBe(2)
  expect(inSrc(w, ['status', '--porcelain'])).toBe('')
  expect(inSrc(w, ['rev-parse', 'HEAD']).trim()).toBe(head)
})

test('D2 a card that stacks on the PR passes', async () => {
  const [w, lap] = await atReady(['src/hello.ts'], `# hello\n\nStacks on #350.\n\n${CARD}\n\n### hello\n\n- **D1** add \`hello()\`\n`)
  await lap()
  expect(readyVerdicts(w)).toBe(1)
  expect(inSrc(w, ['for-each-ref', 'refs/stack'])).toBe('')
})

test('D3 a PR sharing no file is not merged against', async () => {
  const [w, lap] = await atReady(['src/other.ts'])
  await lap()
  expect(readyVerdicts(w)).toBe(1)
  expect(inSrc(w, ['for-each-ref', 'refs/stack'])).toBe('')
})

test('D4 the job\'s own PR and a PR not ours are left alone', async () => {
  const [w] = await atReady(['src/other.ts'])
  const branch = headOf(w.root, 1).branch
  const read = (): object[] => [...listed(['src/hello.ts'], { headRefName: branch }),
    ...listed(['src/hello.ts'], { number: 351, headRepositoryOwner: { login: 'acme' } })]
  expect(stacked(w.root, plan(w.db, 1), 'acme/widget', read)).toBeNull()
  expect(inSrc(w, ['for-each-ref', 'refs/stack'])).toBe('')
})
