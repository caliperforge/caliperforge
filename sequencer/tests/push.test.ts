import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { flag } from '../../store/precedent-findings.ts'
import { profile } from '../../store/profile.ts'
import { setEvidence } from '../../store/targets.ts'
import { tick } from '../index.ts'
import { owed } from '../owed.ts'
import { forkCi, messageOf, sent, type Wire } from '../push.ts'
import { get, put, srcDir } from '../workspace.ts'
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

const DAILY = 'name: daily\n\non:\n  schedule:\n    - cron: "0 11 * * *"\n  workflow_dispatch:\n'

test('a ci row on a schedule-only workflow is not owed', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-owed-'))
  const src = join(root, 'tree')
  mkdirSync(join(src, '.github/workflows'), { recursive: true })
  const flows = { 'daily.yml': DAILY, 'push.yml': 'on: push\n', 'pr.yml': 'on: [pull_request, workflow_dispatch]\n',
    'beside.yml': `${DAILY}  push:\n`, 'broken.yml': 'on: [push\n' }
  for (const [name, body] of Object.entries(flows)) writeFileSync(join(src, '.github/workflows', name), body)
  const files = [...Object.keys(flows), 'gone.yml'].map((f) => `.github/workflows/${f}`)
  const rows = files.map((f, at) => `  - id: D${String(at + 1)}\n    status: ci\n    pointer: ${f}:1\n`).join('')
  put(root, 1, 'step-2.handback.md', `built\n\n---\nsummary: s\ndone:\n${rows}---\n`)
  expect(owed(root, 1, src)).toEqual(files.slice(1).map((file) => ({ file, name: file.endsWith('beside.yml') ? 'daily' : file })))
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
  expect(base).toBe(get(w.root, 1, 'base.sha').trim())
  expect(git(['rev-list', '--parents', '-1', 'HEAD'])).toBe(`${git(['rev-parse', 'HEAD'])} ${String(base)}`)
  expect(git(['log', '-1', '--format=%B'])).toBe(messageOf(w.root, 1, profile(w.root, 'acme/widget')))
  expect(git(['ls-remote', 'origin', 'refs/heads/widget-12-a1-2']).split('\t')[0]).toBe(held)
  expect(sends.slice(before).filter((l) => l.startsWith('send '))).toEqual([`send src ${made}:refs/heads/widget-12-a1-next`])
})

test('a fold over a base.sha that main lacks is sent as it stands', { timeout: 90_000 }, async () => {
  const w = world()
  approve(w.db, w.target)
  const git = (args: string[]): string => execFileSync('git', args, { cwd: srcDir(w.root, 1), encoding: 'utf8' }).trim()
  const wire = watched([], w.root, 1)
  for (let at = 0; at < 20 && plan(w.db, 1).step !== 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, 1).step).toBe(6)
  const old = get(w.root, 1, 'base.sha').trim()
  const main = git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit-tree', `${old}^{tree}`, '-p', old, '-m', 'main'])
  put(w.root, 1, 'base.sha', `${main}\n`)
  const message = messageOf(w.root, 1, profile(w.root, 'acme/widget'))
  git(['reset', '-q', '--hard', git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit-tree', 'HEAD^{tree}', '-p', main, '-m', message])])
  const folded = git(['rev-parse', 'HEAD'])
  const { base } = sent(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)
  expect(git(['rev-parse', 'HEAD'])).toBe(folded)
  expect(git(['rev-parse', 'HEAD^'])).toBe(main)
  expect(base).toBe(main)
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)?.spans ?? []).not.toContain('fold')
})

test('an open pull request folds over the fork head, not base.sha', { timeout: 90_000 }, async () => {
  const w = world()
  approve(w.db, w.target)
  const git = (args: string[]): string => execFileSync('git', args, { cwd: srcDir(w.root, 1), encoding: 'utf8' }).trim()
  const as = ['-c', 'user.email=t@t', '-c', 'user.name=t']
  const sends: string[] = []
  const log = watched(sends, w.root, 1)
  let amend = false
  const wire: Wire = { ...log, send: (dir, ref) => {
    log.send(dir, ref)
    execFileSync('git', ['push', '-q', 'origin', ref], { cwd: dir })
    if (amend) git([...as, 'commit', '--amend', '-qm', 'fix: rename hello'])
    amend = false
  } }
  for (let at = 0; at < 20 && plan(w.db, 1).step !== 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, 1).step).toBe(6)
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  git([...as, 'commit', '--allow-empty', '-qm', 'opened'])
  const fork = git(['rev-parse', 'HEAD'])
  git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`])
  setEvidence(w.db, w.target, 'https://github.com/acme/widget/pull/9')
  const message = messageOf(w.root, 1, profile(w.root, 'acme/widget'))
  git(['reset', '-q', '--hard', get(w.root, 1, 'base.sha').trim()])
  writeFileSync(join(srcDir(w.root, 1), 'src/hello.ts'), 'export const hello = (): string => "fold"\n')
  git([...as, 'commit', '-qam', message])
  const before = sends.length
  amend = true
  const first = forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)
  expect(first?.spans).toEqual(['fold'])
  expect(first?.note).toContain(`one commit over caliperforge/widget:${branch}'s head ${fork.slice(0, 12)} with the brief's message`)
  expect([git(['rev-parse', 'HEAD^']), git(['log', '-1', '--format=%B'])]).toEqual([fork, message])
  const head = git(['rev-parse', 'HEAD'])
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)?.spans ?? []).not.toContain('fold')
  expect(git(['rev-parse', 'HEAD'])).toBe(head)
  expect(git(['ls-remote', 'origin', `refs/heads/${branch}`]).split('\t')[0]).toBe(fork)
  const pushed = sends.slice(before).filter((l) => l.startsWith('send '))
  expect(pushed.length).toBeGreaterThan(0)
  expect(pushed.filter((l) => !l.endsWith(`:refs/heads/${branch}-next`))).toEqual([])
})
