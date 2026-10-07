import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { rehearsed } from '../findings.ts'
import { tick } from '../index.ts'
import { maybe, put } from '../workspace.ts'
import { approve, CARRIED, PASS, scored, stub, world, type World } from './world.ts'

const FOUND = '- G11 src/hello.ts:1 a mint change is lost\n- G12 src/hello.ts:2 the name is wrong\n'

const answering = (ids: string[]): string =>
  CARRIED.replace(/---\n$/, `${ids.map((id) => `  - id: ${id}\n    status: done\n    pointer: src/hello.ts:1\n`).join('')}---\n`)

/** Ticks until step 3 has judged the build, with FOUND stored at the checkout HEAD once the brief is asked for, and `score` recorded there unless null. */
async function built(score: number | null, handback = CARRIED): Promise<{ w: World; packets: Packet[] }> {
  const w = world()
  approve(w.db, w.target)
  const packets: Packet[] = []
  const provider = stub(handback, 0, PASS, (p) => {
    if (p.tools.includes('Write')) packets.push(p)
    else if (p.prompt.includes('# brief_writer')) {
      if (score !== null) scored(w.root, 1, score)
      put(w.root, 1, `findings-${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.cwd, encoding: 'utf8' }).trim()}.md`, FOUND)
    }
  })
  for (let at = 0; at < 6 && audited(w).length === 0; at += 1) await tick(w.db, w.root, provider)
  return { w, packets }
}

function audited(w: World): { outcome: string }[] {
  return w.db.prepare("SELECT outcome FROM verdicts WHERE rail_id = 'completion-audit'").all() as { outcome: string }[]
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

test('D3 a 5/5 or no score at HEAD: no findings, no findings.md', async () => {
  for (const score of [5, null]) {
    const { w, packets } = await built(score)
    expect(packets[0]?.prompt).not.toContain('# Bot review findings')
    expect(maybe(w.root, 1, 'findings.md')).toBeNull()
  }
})

test('D4 answering one of two findings refuses; both passes', async () => {
  const one = await built(4, answering(['G11']))
  expect(audited(one.w)).toEqual([{ outcome: 'refuse' }])
  expect(maybe(one.w.root, 1, 'refusal.md')).toContain('- G12')
  const both = await built(4, answering(['G11', 'G12']))
  expect(audited(both.w)).toEqual([{ outcome: 'pass' }])
})
