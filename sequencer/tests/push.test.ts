import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { flag } from '../../store/precedent-findings.ts'
import { tick } from '../index.ts'
import { srcDir } from '../workspace.ts'
import { GREPTILED, RULED, THEIR_RULE } from './bases.ts'
import { approve, CARRIED, plan, stub, tip, watched, world } from './world.ts'

const SOURCE = 'https://github.com/acme/widget/pull/3#discussion_r1'
const OURS = { rule: `f (${SOURCE})`, scope: ['src/hello.ts'] }

async function tipped(files: Record<string, string>): Promise<{ git: (args: string[]) => string; made: string }> {
  const w = world('warm', undefined, files)
  flag(w.db, 'acme/widget', 3, [{ finding: 'f', area: 'src/hello.ts', acted_on: 'fixed', source: SOURCE }])
  approve(w.db, w.target)
  for (let at = 0; at < 7; at += 1) {
    if (at === 2) writeFileSync(join(srcDir(w.root, 1), 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
    await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  }
  expect(plan(w.db, 1).step).toBe(7)
  const git = (args: string[]): string => execFileSync('git', args, { cwd: srcDir(w.root, 1), encoding: 'utf8' }).trim()
  return { git, made: tip(w.root, 1) }
}

test('D1 D2 D3 .greptile/config.json holds both rule sets', async () => {
  const { git, made } = await tipped(GREPTILED)
  expect(JSON.parse(git(['show', `${made}:.greptile/config.json`])) as unknown)
    .toEqual({ strictness: 2, autoReview: [], rules: [THEIR_RULE, OURS] })
  expect(git(['log', '-1', '--format=%s', made])).toBe('.greptile/config.json: review on request only')
  expect(git(['ls-tree', '-r', '--name-only', made, '--', 'greptile.json'])).toBe('')
  expect(git(['diff', '--name-only', 'refs/remotes/upstream/main', 'widget-12-a1'])).toBe('src/hello.ts')
})

test('D4 a .greptile folder with no config.json gets ours alone', async () => {
  const { git, made } = await tipped(RULED)
  expect(JSON.parse(git(['show', `${made}:.greptile/config.json`])) as unknown).toEqual({ autoReview: [], rules: [OURS] })
})
