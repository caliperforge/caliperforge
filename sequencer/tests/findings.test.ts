import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { greptileFacts } from '../../store/facts.ts'
import { record, since } from '../../store/signals.ts'
import { verdictRows } from '../../store/verdict.ts'
import { blinded, rehearsed } from '../findings.ts'
import { tick } from '../index.ts'
import type { Fired } from '../kind.ts'
import { headOf } from '../push.ts'
import { verdict } from '../signoff.ts'
import { headSha, maybe, planDir, put, srcDir } from '../workspace.ts'
import { approve, CARRIED, once, PASS, plan, scored, stub, watched, world, type World } from './world.ts'

const FOUND = '- G11 src/hello.ts:1 a mint change is lost\n- G12 src/hello.ts:2 the name is wrong\n'

const answering = (ids: string[]): string =>
  CARRIED.replace(/---\n$/, `${ids.map((id) => `  - id: ${id}\n    status: done\n    pointer: src/hello.ts:1\n`).join('')}---\n`)

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** Ticks until step 3 has judged the build, with FOUND stored at the checkout HEAD and `blind` at its tree once the brief is asked for, and `score` recorded there unless null. */
async function built(score: number | null, handback = CARRIED, ask = false, blind = ''): Promise<{ w: World; packets: Packet[] }> {
  const w = world()
  approve(w.db, w.target)
  const packets: Packet[] = []
  const provider = stub(handback, 0, PASS, (p) => {
    if (p.tools.includes('Write')) packets.push(p)
    else if (p.prompt.includes('# brief_writer')) {
      if (score !== null) scored(w.root, 1, score)
      if (ask) {
        record(w.db, { repo: 'acme/widget', pr: 7, kind: 'review', author: 'maintainer', at: new Date().toISOString(),
          external_id: 'r1', score: null, plan: 1, body: 'Name it\n  greet.', state: 'CHANGES_REQUESTED' })
      }
      put(w.root, 1, `findings-${git(p.cwd, ['rev-parse', 'HEAD'])}.md`, FOUND)
      if (blind !== '') put(w.root, 1, `findings-${git(p.cwd, ['rev-parse', 'HEAD^{tree}'])}.md`, blind)
    }
  })
  for (let at = 0; at < 6 && audited(w).length === 0; at += 1) await tick(w.db, w.root, provider)
  return { w, packets }
}

function audited(w: World): { outcome: string }[] {
  return verdictRows(w.db, 1).filter((v) => v.rail_id === 'completion-audit').map(({ outcome }) => ({ outcome }))
}

test('D2 a 4/5 review at HEAD puts both findings in the packet', async () => {
  const { packets } = await built(4)
  expect(packets[0]?.prompt).toContain(`# Bot review findings\n\nGreptile scored this head 4/5.`)
  expect(packets[0]?.prompt).toContain(FOUND)
})

test('D1 D2 a bot comment is filed only under its own head', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-findings-'))
  const [a, b] = ['a'.repeat(40), 'b'.repeat(40)]
  const comments = [
    { id: 11, commit_id: b, original_commit_id: a, path: 'src/hello.ts', line: 1, original_line: 1, body: 'lost', user: { login: 'greptile-apps[bot]' } },
    { id: 12, commit_id: a, original_commit_id: a, path: 'src/hello.ts', line: 2, original_line: 2, body: 'rename', user: { login: 'maintainer' } },
  ]
  const signal = (head: string) => ({ repo: 'caliperforge/widget', pr: 3, kind: 'bot_review' as const, author: 'greptile-apps[bot]',
    at: '2026-10-01T09:00:00Z', external_id: 'g1', score: 3, plan: 1, head })
  rehearsed({ root, list: () => comments }, 1, 'caliperforge/widget', 3, [signal(a), signal(b)])
  expect(maybe(root, 1, `findings-${a}.md`)).toBe('- G11 src/hello.ts:1 lost\n')
  expect(maybe(root, 1, `findings-${b}.md`)).toBeNull()
  expect(maybe(root, 1, 'findings.paths')).toBe('G11 src/hello.ts\n')
})

const TREE = 'e'.repeat(40)
const BLIND = '- B1 P2 src/hello.ts:1 the name is lost\n- B2 P3 src/hello.ts:2 a nit\n'

function blindRow(w: World, tree: string | null): number {
  w.db.exec(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, origin_kind, origin_ref, tokens, seconds, tree)
    VALUES ('blind_review', 'review', '${'d'.repeat(64)}', 1, 5, 'refuse', 'ruling', 'reviewers.verdict', 0, 0, ${tree === null ? 'NULL' : `'${tree}'`})`)
  return verdictRows(w.db, 1).at(-1)?.id ?? 0
}

test('D1 D2 blinded keeps only B rows at the verdict tree', () => {
  const w = world()
  const message = `prose\n${BLIND}- B3 P4 src/hello.ts:3 no such priority\n- a prose bullet\n- G11 src/hello.ts:1 a bot row\n`
  blinded(w.db, w.root, 1, { verdict: blindRow(w, TREE), outcome: { message } })
  expect(maybe(w.root, 1, `findings-${TREE}.md`)).toBe(BLIND)
  blinded(w.db, w.root, 1, { verdict: blindRow(w, TREE), outcome: { message: '- B3 P4 src/hello.ts:3 x\n- a bullet' } })
  expect(maybe(w.root, 1, `findings-${TREE}.md`)).toBeNull()
  blinded(w.db, w.root, 1, { verdict: blindRow(w, null), outcome: { message: BLIND } })
  expect(readdirSync(planDir(w.root, 1)).filter((f) => f.startsWith('findings-'))).toEqual([])
})

test('D3 a 5/5 or no score at HEAD: no findings, no findings.md', async () => {
  for (const score of [5, null]) {
    const { w, packets } = await built(score)
    expect(packets[0]?.prompt).not.toContain('# Bot review findings')
    expect(maybe(w.root, 1, 'findings.md')).toBeNull()
  }
})

test('a 5/5 head still hands the builder its blind review rows', async () => {
  const { packets } = await built(5, CARRIED, false, BLIND)
  expect(packets[0]?.prompt).not.toContain('# Bot review findings')
  expect(packets[0]?.prompt).toContain(`# Blind review findings\n\nUnder \`## Findings answered\` in your hand-back, above the fence, write one row per id: \`- B1 fixed: <how>\` or \`- B1 disputed: <why>\`.\n\n${BLIND}`)
})

test('D4 a reviewer ask reaches the packet under its R id', async () => {
  const { w, packets } = await built(null, CARRIED, true)
  const id = since(w.db, 1).find((s) => s.kind === 'review')?.id
  expect(packets[0]?.prompt).toContain("# Reviewer asks\n\nAnswer each ask under its id in your hand-back's done rows, with a pointer.\n\n"
    + `- R${String(id)} maintainer (review, CHANGES_REQUESTED): Name it greet.\n`)
  expect((await built(null)).packets[0]?.prompt).not.toContain('# Reviewer asks')
})

test('D4 answering one of two findings refuses; both passes', async () => {
  const one = await built(4, answering(['G11']))
  expect(audited(one.w)).toEqual([{ outcome: 'refuse' }])
  expect(maybe(one.w.root, 1, 'refusal.md')).toContain('- G12')
  const both = await built(4, answering(['G11', 'G12']))
  expect(audited(both.w)).toEqual([{ outcome: 'pass' }])
})

const lap = async (w: World, handback: string): Promise<Fired | undefined> =>
  (await tick(w.db, w.root, stub(handback), undefined, undefined, watched([], w.root, 1)))[0]

/** An approved outside plan at step 6 on `handback`, its head scored 5/5 at each rehearsal, with BLIND filed at the head's tree. */
async function atReady(handback: string): Promise<World> {
  const w = world()
  await tick(w.db, w.root, stub(handback))
  approve(w.db, w.target)
  for (let at = 0; at < 5; at += 1) await lap(w, handback)
  expect(plan(w.db, 1).step).toBe(6)
  const { dir, sha } = headOf(w.root, 1)
  put(w.root, 1, `findings-${git(dir, ['rev-parse', `${sha}^{tree}`])}.md`, BLIND)
  return w
}

const UNANSWERED = once(() => atReady(CARRIED))

test('an unanswered blind B P2 at the head holds ready', async () => {
  const w = await UNANSWERED()
  expect(await lap(w, CARRIED)).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', spans: ['greptile.unhandled'] })
  expect(plan(w.db, 1).step).toBe(2)
})

test('a B1 fixed: row in the hand-back lets ready pass', async () => {
  const handback = CARRIED.replace('- F1 fixed: hello takes a name\n', '$&- B1 fixed: hello keeps the name\n')
  const w = await atReady(handback)
  expect(await lap(w, handback)).toMatchObject({ step: 6, name: 'ready', outcome: 'pass' })
  expect(plan(w.db, 1).step).toBe(7)
})

test('an open blind B P3 fails the fact sheet as blind review', async () => {
  const w = await UNANSWERED()
  const facts = greptileFacts(w.db, w.root, 1, headSha(srcDir(w.root, 1)))
  expect(facts).toContainEqual({ name: 'blind review', ok: false, says: 'B2 P3 src/hello.ts:2 a nit' })
  expect(verdict(facts)).toBe('Open: blind review: `B1 P2 src/hello.ts:1 the name is lost`')
})
