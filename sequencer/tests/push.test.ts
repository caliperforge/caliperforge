import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { flag } from '../../store/precedent-findings.ts'
import { profile } from '../../store/profile.ts'
import { tick } from '../index.ts'
import { messageOf, sent, type Wire } from '../push.ts'
import { put, srcDir } from '../workspace.ts'
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

test('a held fork branch with no pr goes out squashed over base', { timeout: 90_000 }, async () => {
  const w = world()
  approve(w.db, w.target)
  const git = (args: string[]): string => execFileSync('git', args, { cwd: srcDir(w.root, 1), encoding: 'utf8' }).trim()
  const sends: string[] = []
  const log = watched(sends, w.root, 1)
  const wire: Wire = { ...log, send: (dir, ref) => {
    log.send(dir, ref)
    execFileSync('git', ['push', '-q', 'origin', ref], { cwd: dir })
  } }
  for (let at = 0; at < 20 && plan(w.db, 1).step !== 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, 1).step).toBe(6)
  put(w.root, 1, 'fork.branch', 'widget-12-a1-2')
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'split'])
  const held = git(['rev-parse', 'HEAD'])
  git(['push', '-q', 'origin', 'HEAD:refs/heads/widget-12-a1-2'])
  git(['reset', '-q', '--hard', 'HEAD^'])
  writeFileSync(join(srcDir(w.root, 1), 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
  const before = sends.length
  const { base, tip: made } = sent(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)
  expect(base).toBe(git(['merge-base', 'HEAD', 'refs/remotes/upstream/main']))
  expect(git(['rev-list', '--parents', '-1', 'HEAD'])).toBe(`${git(['rev-parse', 'HEAD'])} ${String(base)}`)
  expect(git(['log', '-1', '--format=%B'])).toBe(messageOf(w.root, 1, profile(w.root, 'acme/widget')))
  expect(git(['ls-remote', 'origin', 'refs/heads/widget-12-a1-2']).split('\t')[0]).toBe(held)
  expect(sends.slice(before).filter((l) => l.startsWith('send '))).toEqual([`send src ${made}:refs/heads/widget-12-a1-next`])
})
