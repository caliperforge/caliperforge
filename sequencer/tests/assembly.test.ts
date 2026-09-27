import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import { approve as approveCard } from '../../cli/batch.ts'
import { approve as approvePublish } from '../card.ts'
import { tick } from '../index.ts'
import { kernelPlan } from '../home.ts'
import type { Wire } from '../push.ts'
import { repoOf } from '../ready.ts'
import { checkout, diffOf, fetchMain, FORK, get, put, SELF, srcDir } from '../workspace.ts'
import { built, CARRIED, plan, REFUSE, stub, watched, world, type World } from './world.ts'

const ID = 2

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

interface Assembly { w: World; fork: string; upstream: string }

function part(w: World, id: number, n: number, state = 'queued'): void {
  const url = `https://github.com/${SELF}/issues/${String(899 + id)}`
  w.db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
    VALUES (?, 1, 1, 'pr_path', ?, '2026-09-18T00:00:00.000Z', 0, 0, 1, 'machine', 'typescript_specialist', ?)`).run(id, state, url)
  w.db.prepare("INSERT INTO parts (parent, n, url, title, body, plan) VALUES (1, ?, ?, 'part', '', ?)").run(n, url, id)
  put(w.root, id, 'ask.md', '# hello part\n\n- **D1** add `hello()` in `src/hello.ts`\n')
}

function assembling(): Assembly {
  const w = world()
  w.db.prepare("UPDATE plans SET state = 'done' WHERE id = 1").run()
  part(w, ID, 0)
  const fork = join(w.root, 'remotes', FORK, 'widget')
  git(fork, ['checkout', '-q', '-b', 'asm/1'])
  writeFileSync(join(fork, 'src/asm.ts'), 'export const asm = 1\n')
  git(fork, ['add', '-A'])
  git(fork, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'asm'])
  git(fork, ['checkout', '-q', 'main'])
  return { w, fork, upstream: join(w.root, 'remotes/acme/widget') }
}

/** The watched log with a real push, so a landing moves the fork's branch. */
function pushing(log: string[], a: Assembly): Wire {
  return { ...watched(log, a.w.root, ID), send: (dir, branch) => {
    log.push(`send ${basename(dir)} ${branch}`)
    git(dir, ['push', '-q', 'origin', branch])
  } }
}

async function laps(a: Assembly, n: number, wire: Wire, review?: string): Promise<void> {
  for (let at = 0; at < n; at += 1) await tick(a.w.db, a.w.root, stub(CARRIED, 0, review), undefined, undefined, wire)
}

test('D1 D4 a part cuts from asm/1 on the fork and lands there, with nothing sent upstream and no PR', async () => {
  const a = assembling()
  const log: string[] = []
  const wire = pushing(log, a)
  const tip = git(a.fork, ['rev-parse', 'asm/1'])
  const main = git(a.upstream, ['rev-parse', 'main'])

  await laps(a, 3, wire)
  expect(get(a.w.root, ID, 'base.sha').trim()).toBe(tip)
  built(a.w.root, ID, 'export const landed = true')
  await laps(a, 4, wire)
  expect(plan(a.w.db, ID).step).toBe(7)

  await laps(a, 2, wire)
  const head = git(srcDir(a.w.root, ID), ['rev-parse', 'HEAD'])
  expect(plan(a.w.db, ID).state).toBe('done')
  expect(git(a.fork, ['rev-parse', 'asm/1'])).toBe(head)
  expect(git(a.fork, ['rev-parse', 'main'])).toBe(main)
  expect(git(a.upstream, ['rev-parse', 'main'])).toBe(main)
  expect(git(a.upstream, ['branch', '--list', 'asm/1'])).toBe('')
  expect(log).toEqual(['send src main:refs/heads/asm/1', `close ${SELF}#901 ${head.slice(0, 7)}`])
  expect(a.w.db.prepare('SELECT evidence FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1').get(ID))
    .toEqual({ evidence: `https://github.com/${FORK}/widget/commit/${head}` })
})

test('D3 a checkout with cf.base fetches MAIN from the fork branch; one without fetches upstream main', async () => {
  const a = assembling()
  await laps(a, 2, watched([], a.w.root, ID))
  const src = srcDir(a.w.root, ID)
  expect(git(src, ['config', 'cf.base'])).toBe('asm/1')
  expect(fetchMain(src)).toBe(git(a.fork, ['rev-parse', 'asm/1']))

  const plain = checkout(a.w.root, 1, 'acme/widget', 'widget-12-a1')
  expect(() => git(plain.dir, ['config', 'cf.base'])).toThrow()
  expect(fetchMain(plain.dir)).toBe(git(a.upstream, ['rev-parse', 'main']))
})

test('D2 a part refused at review goes back to its own build, its sibling and asm/1 untouched', async () => {
  const a = assembling()
  part(a.w, 3, 1, 'blocked_on_ceo')
  const sibling = a.w.db.prepare('SELECT * FROM plans WHERE id = 3').get()
  const tip = git(a.fork, ['rev-parse', 'asm/1'])
  const wire = pushing([], a)

  await laps(a, 3, wire)
  built(a.w.root, ID, 'export const landed = true')
  await laps(a, 2, wire, REFUSE)
  expect(plan(a.w.db, ID).step).toBe(2)
  expect(a.w.db.prepare('SELECT * FROM plans WHERE id = 3').get()).toEqual(sibling)
  expect(git(a.fork, ['rev-parse', 'asm/1'])).toBe(tip)
})

/** The part landed on asm/1, and the parent holding the `base.sha` its brief was written against. */
async function landed(): Promise<Assembly> {
  const a = assembling()
  put(a.w.root, 1, 'base.sha', `${git(a.upstream, ['rev-parse', 'main'])}\n`)
  const wire = pushing([], a)
  await laps(a, 3, wire)
  built(a.w.root, ID, 'export const landed = true')
  await laps(a, 5, wire)
  return a
}

test('D1 landing the only part leaves the parent at senior with the parts and both cases in its brief', async () => {
  const a = await landed()
  expect(plan(a.w.db, 1)).toMatchObject({ step: 5, state: expect.stringMatching(/^(queued|running)$/) as unknown, retries: 0 })
  expect(get(a.w.root, 1, 'issue.md')).toBe(['# hello', '', '- **D1** add `hello()` in `src/hello.ts`', '', '## Parts, joined on asm/1', '',
    '- part', '', '## Cases', '', '- D1 every part\'s cases hold together on asm/1',
    '- D2 a gap between parts is refused: a case no part answers, a name one part adds and no part uses, a change two parts make twice', ''].join('\n'))
})

test('D2 D3 the parent reviews asm/1 against its base and opens one pull request from it, only after approval', async () => {
  const a = await landed()
  const log: string[] = []
  const wire = watched(log, a.w.root, 1)
  await laps(a, 4, wire)
  expect(git(srcDir(a.w.root, 1), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('asm/1')
  expect(diffOf(a.w.root, 1)).toContain('src/asm.ts')
  expect(plan(a.w.db, 1)).toMatchObject({ step: 7, wait_reason: 'ceo_batch' })
  expect(log.filter((l) => l.startsWith('open '))).toEqual([])

  approveCard(a.w.db, a.w.root, 'plan', 1)
  await laps(a, 2, wire)
  approvePublish(a.w.db, a.w.root, 1)
  await laps(a, 1, wire)
  expect(log.filter((l) => l.startsWith('open '))).toEqual(['open acme/widget caliperforge:asm/1'])
})

test('D4 a part whose last pre_review refused leaves the parent waiting on the ready proof', async () => {
  const a = await landed()
  a.w.db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds)
    VALUES ('pre_review', 'rail', ?, ?, 3, 'refuse', 'authority', 'rail', 'authority', 0, 0)`).run('0'.repeat(64), ID)
  await laps(a, 3, watched([], a.w.root, 1))
  expect(plan(a.w.db, 1)).toMatchObject({ step: 6, wait_reason: 'ready_proof' })
  expect(a.w.db.prepare('SELECT tests_pass FROM deliverables WHERE plan_id = 1 ORDER BY id DESC LIMIT 1').get()).toEqual({ tests_pass: 0 })
})

test('D5 a part plan is not the kernel\'s, and its repo is the target\'s', () => {
  const a = assembling()
  expect(kernelPlan(plan(a.w.db, ID))).toBe(false)
  expect(repoOf(a.w.db, plan(a.w.db, ID))).toBe('acme/widget')
})
