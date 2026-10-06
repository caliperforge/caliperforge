import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import { approve as approveCard } from '../../cli/batch.ts'
import type { Pr } from '../../cli/gh.ts'
import { record as recordVerdict } from '../../rails/record.ts'
import { decide } from '../../store/approvals.ts'
import { deliverablesOf, newest, pushedRow } from '../../store/deliverables.ts'
import { addPart, partAt, partsOf } from '../../store/parts.ts'
import { end, planRows, type PlanRow, putPlan, requeue, stampHead } from '../../store/plans.ts'
import { record, type SignalRow } from '../../store/signals.ts'
import { verdictRows } from '../../store/verdict.ts'
import { approve as approvePublish } from '../card.ts'
import { tick } from '../index.ts'
import { kernelPlan } from '../home.ts'
import type { Wire } from '../push.ts'
import { repoOf } from '../ready.ts'
import { started } from '../signals.ts'
import { checkout, diffOf, fetchMain, FORK, get, maybe, put, SELF, srcDir } from '../workspace.ts'
import { built, CARRIED, plan, PR, REFUSE, stub, tip, watched, world, type World } from './world.ts'

const ID = 2

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

interface Assembly { w: World; fork: string; upstream: string }

function part(w: World, id: number, n: number, state: PlanRow['state'] = 'queued'): void {
  const url = `https://github.com/${SELF}/issues/${String(899 + id)}`
  putPlan(w.db, { id, pipe_id: 1, target_id: 1, template: 'pr_path', state, queued_at: '2026-09-18T00:00:00.000Z', step: 0, retries: 0,
    lane: 'machine', seat: 'typescript_specialist', origin: url })
  addPart(w.db, { parent: 1, n, url, title: 'part', body: '', plan: id })
  put(w.root, id, 'ask.md', '# hello part\n\n- **D1** add `hello()` in `src/hello.ts`\n')
}

function assembling(ci = false): Assembly {
  const w = world()
  end(w.db, 1, 'done')
  part(w, ID, 0)
  const fork = join(w.root, 'remotes', FORK, 'widget')
  git(fork, ['checkout', '-q', '-b', 'asm/1'])
  writeFileSync(join(fork, 'src/asm.ts'), 'export const asm = 1\n')
  if (ci) {
    mkdirSync(join(fork, '.github/workflows'), { recursive: true })
    writeFileSync(join(fork, '.github/workflows/ci.yml'), 'name: CI\non: push\njobs: {}\n')
  }
  git(fork, ['add', '-A'])
  git(fork, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'asm'])
  git(fork, ['checkout', '-q', 'main'])
  return { w, fork, upstream: join(w.root, 'remotes/acme/widget') }
}

/** The watched log with a real push, so a landing moves the fork's branch. */
function pushing(log: string[], a: Assembly, id = ID): Wire {
  return { ...watched(log, a.w.root, id), send: (dir, branch) => {
    log.push(`send ${basename(dir)} ${branch}`)
    git(dir, ['push', '-q', 'origin', branch])
  } }
}

async function laps(a: Assembly, n: number, wire: Wire, review?: string): Promise<void> {
  for (let at = 0; at < n; at += 1) await tick(a.w.db, a.w.root, stub(CARRIED, 0, review), undefined, undefined, wire)
}

test('D1 D4 a part lands on fork asm/1, nothing upstream, no PR', async () => {
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
  expect(newest(a.w.db, ID)).toMatchObject({ evidence: `https://github.com/${FORK}/widget/commit/${head}` })
})

test('D3 cf.base fetches MAIN from the fork, else upstream main', async () => {
  const a = assembling()
  await laps(a, 2, watched([], a.w.root, ID))
  const src = srcDir(a.w.root, ID)
  expect(git(src, ['config', 'cf.base'])).toBe('asm/1')
  expect(fetchMain(src)).toBe(git(a.fork, ['rev-parse', 'asm/1']))

  const plain = checkout(a.w.root, 1, 'acme/widget', 'widget-12-a1')
  expect(() => git(plain.dir, ['config', 'cf.base'])).toThrow()
  expect(fetchMain(plain.dir)).toBe(git(a.upstream, ['rev-parse', 'main']))
})

test('D2 a refused part rebuilds; sibling and asm/1 untouched', async () => {
  const a = assembling()
  part(a.w, 3, 1, 'blocked_on_ceo')
  const sibling = planRows(a.w.db).find((r) => r.id === 3)
  const tip = git(a.fork, ['rev-parse', 'asm/1'])
  const wire = pushing([], a)

  await laps(a, 3, wire)
  built(a.w.root, ID, 'export const landed = true')
  await laps(a, 2, wire, REFUSE)
  expect(plan(a.w.db, ID).step).toBe(2)
  expect(planRows(a.w.db).find((r) => r.id === 3)).toEqual(sibling)
  expect(git(a.fork, ['rev-parse', 'asm/1'])).toBe(tip)
})

/** The part landed on asm/1, and the parent holding the `base.sha` its brief was written against. */
async function landed(ci = false): Promise<Assembly> {
  const a = assembling(ci)
  put(a.w.root, 1, 'base.sha', `${git(a.upstream, ['rev-parse', 'main'])}\n`)
  const wire = pushing([], a)
  await laps(a, 3, wire)
  built(a.w.root, ID, 'export const landed = true')
  await laps(a, 5, wire)
  return a
}

test('D1 the parent goes to senior with its parts and cases', async () => {
  const a = await landed()
  expect(plan(a.w.db, 1)).toMatchObject({ step: 5, state: expect.stringMatching(/^(queued|running)$/) as unknown, retries: 0 })
  expect(get(a.w.root, 1, 'issue.md')).toBe(['# hello', '', '- **D1** add `hello()` in `src/hello.ts`', '', '## Parts, joined on asm/1', '',
    '- part', '', '## Cases', '', '- D1 every part\'s cases hold together on asm/1',
    '- D2 a gap between parts is refused: a case no part answers, a name one part adds and no part uses, a change two parts make twice', ''].join('\n'))
})

test('D2 D3 the parent reviews asm/1, opens one PR once approved', async () => {
  const a = await landed()
  const log: string[] = []
  const wire = watched(log, a.w.root, 1)
  await laps(a, 4, wire)
  expect(git(srcDir(a.w.root, 1), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('asm/1')
  expect(diffOf(a.w.root, 1)).toContain('src/asm.ts')
  expect(plan(a.w.db, 1)).toMatchObject({ step: 7, wait_reason: 'ceo_batch' })
  expect(log.filter((l) => l.startsWith('open '))).toEqual([])

  approveCard(a.w.db, a.w.root, 'plan', 1, 'ceo')
  await laps(a, 2, wire)
  approvePublish(a.w.db, a.w.root, 1, 'ceo')
  await laps(a, 1, wire)
  expect(log.filter((l) => l.startsWith('open '))).toEqual(['open acme/widget caliperforge:asm/1'])
})

const ciGreen = (a: Assembly, id: number): string | undefined =>
  verdictRows(a.w.db, id).findLast((v) => v.rail_id === 'ci-green')?.outcome

test('D1 a part under a workflow sends only its landing', async () => {
  const a = assembling(true)
  const log: string[] = []
  const wire = pushing(log, a)
  await laps(a, 3, wire)
  built(a.w.root, ID, 'export const landed = true')
  await laps(a, 4, wire)
  expect(plan(a.w.db, ID).step).toBe(7)
  expect(ciGreen(a, ID)).toBe('pass')

  await laps(a, 2, wire)
  const head = git(srcDir(a.w.root, ID), ['rev-parse', 'HEAD'])
  expect(log).toEqual(['send src main:refs/heads/asm/1', `close ${SELF}#901 ${head.slice(0, 7)}`])
})

test('D3 the parent still sends asm/1-next and judges its runs', async () => {
  const a = await landed(true)
  const log: string[] = []
  await laps(a, 4, watched(log, a.w.root, 1))
  expect(plan(a.w.db, 1).step).toBe(7)
  expect(log).toContain(`send src ${tip(a.w.root, 1)}:refs/heads/asm/1-next`)
  expect(ciGreen(a, 1)).toBe('pass')
})

test('D4 a refused pre_review leaves the parent on ready proof', async () => {
  const a = await landed()
  recordVerdict(a.w.db, join(a.w.root, 'rails/authority'), ID, { outcome: 'refuse', subject_digest: '0'.repeat(64), spans: [],
    origin_kind: 'rail', origin_ref: 'authority', message: '', defect_class: 'authority' }, 0)
  await laps(a, 3, watched([], a.w.root, 1))
  expect(plan(a.w.db, 1)).toMatchObject({ step: 6, wait_reason: 'ready_proof' })
  expect(newest(a.w.db, 1)).toMatchObject({ tests_pass: 0 })
})

/** The parent done, its pull request from asm/1 open. */
function opened(a: Assembly): void {
  const digest = '0'.repeat(64)
  const approval = decide(a.w.db, 'plan', 1, digest, null)
  pushedRow(a.w.db, { plan: 1, step: 8, seat: 'typescript_specialist', diff_digest: digest, evidence: PR }, approval)
  stampHead(a.w.db, 1, digest)
  requeue(a.w.db, 1, 9)
  end(a.w.db, 1, 'done')
}

function said(a: Assembly, kind: 'review' | 'comment', state: string | null): SignalRow {
  const row = record(a.w.db, { repo: 'acme/widget', pr: 7, kind, author: 'maintainer', at: new Date().toISOString(),
    external_id: `${kind}-${String(state)}`, score: null, plan: 1, body: 'rename expires to expiry', state })
  if (row === null) throw new Error('recorded twice')
  return row
}

/** The fix part's issue is its own number, apart from part 1's. */
function filing(log: string[], a: Assembly, id = ID): Wire {
  return { ...pushing(log, a, id), file: (repo, title) => {
    log.push(`file ${repo} ${title}`)
    return `https://github.com/${repo}/issues/950`
  } }
}

const quiet = (): Pr => ({ number: 7, url: PR, state: 'OPEN', mergedAt: null, mergedBy: null, reviewDecision: null,
  comments: [], reviews: [], statusCheckRollup: [] })

test('D1 D2 a change request files p1b queued, parent untouched', async () => {
  const a = await landed()
  opened(a)
  const parent = plan(a.w.db, 1)
  const log: string[] = []
  const fix = started(a.w.db, said(a, 'review', 'CHANGES_REQUESTED'), a.w.root, filing(log, a))
  const id = Number(fix?.plan)
  expect(fix).toMatchObject({ template: 'pr_path', step: 0 })
  expect(log).toEqual([`file ${SELF} p1b: address maintainer's review on acme/widget#7`])
  expect(partAt(a.w.db, 1, 1)).toMatchObject({ n: 1, after: null, plan: id })
  expect(plan(a.w.db, id)).toMatchObject({ step: 0, state: 'queued' })
  expect(get(a.w.root, id, 'ask.md')).toContain('rename expires to expiry')
  expect(plan(a.w.db, 1)).toEqual(parent)
  expect(maybe(a.w.root, 1, 'refusal.md')).toBeNull()
})

test('D3 the fix lands on asm/1 alone, parent at senior, PR kept', async () => {
  const a = await landed()
  opened(a)
  const log: string[] = []
  const id = Number(started(a.w.db, said(a, 'review', 'CHANGES_REQUESTED'), a.w.root, filing(log, a))?.plan)
  const wire = filing(log, a, id)
  const main = git(a.upstream, ['rev-parse', 'main'])
  const branches = git(a.upstream, ['branch', '--list'])
  const lap = (): Promise<unknown> => tick(a.w.db, a.w.root, stub(CARRIED), undefined, quiet, wire)

  for (let at = 0; at < 3; at += 1) await lap()
  built(a.w.root, id, 'export const fixed = true')
  for (let at = 0; at < 8 && plan(a.w.db, 1).step !== 5; at += 1) await lap()
  expect(plan(a.w.db, 1).step).toBe(5)
  expect(git(a.fork, ['rev-parse', 'asm/1'])).toBe(git(srcDir(a.w.root, id), ['rev-parse', 'HEAD']))
  expect(git(a.upstream, ['rev-parse', 'main'])).toBe(main)
  expect(git(a.upstream, ['branch', '--list'])).toBe(branches)
  expect(log.filter((l) => /^(send|open) /.test(l))).toEqual(['send src main:refs/heads/asm/1'])
  expect(deliverablesOf(a.w.db, 1).findLast((d) => d.state === 'pushed')).toMatchObject({ evidence: PR })
})

test('D4 D5 a comment rewinds to 2; a failed filing adds no part', async () => {
  const a = await landed()
  opened(a)
  const wire = { ...watched([], a.w.root, 1), file: (): string => { throw new Error('gh is down') } }
  const parts = (): unknown[] => partsOf(a.w.db, 1)

  started(a.w.db, said(a, 'comment', null), a.w.root, wire)
  expect(plan(a.w.db, 1)).toMatchObject({ step: 2, state: 'blocked_on_ceo' })

  stampHead(a.w.db, 1, '0'.repeat(64))
  requeue(a.w.db, 1, 9)
  end(a.w.db, 1, 'done')
  started(a.w.db, said(a, 'review', 'CHANGES_REQUESTED'), a.w.root, wire)
  expect(plan(a.w.db, 1)).toMatchObject({ step: 2, state: 'blocked_on_ceo' })
  expect(parts()).toHaveLength(1)
  expect(get(a.w.root, 1, 'refusal.md')).toContain('rename expires to expiry')
})

test('D5 a part plan is not the kernel\'s, its repo the target\'s', () => {
  const a = assembling()
  expect(kernelPlan(plan(a.w.db, ID))).toBe(false)
  expect(repoOf(a.w.db, plan(a.w.db, ID))).toBe('acme/widget')
})
