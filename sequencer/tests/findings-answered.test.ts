import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet, Provider } from '../../providers/kind.ts'
import { verdictRows } from '../../store/verdict.ts'
import { tick } from '../index.ts'
import { maybe } from '../workspace.ts'
import { approve, CARRIED, PASS, REFUSE, stub, watched, world } from './world.ts'

const ROW = '- F1 src/hello.ts:1 tight: hello() takes a name; verify: npm run test -- src/hello.test.ts\n'
const BARE = CARRIED.replace(/## Findings answered\n\n.*\n\n/, '')

test('D6 a rebuild without F1 is refused, with F1 passes', async () => {
  const w = world()
  approve(w.db, w.target)
  const builds: Packet[] = []
  const open: (string | null)[] = []
  const refusals: (string | null)[] = []
  let reviews = 0
  const provider: Provider = {
    name: 'claude-agent-sdk',
    fire: (p) => {
      const builder = p.tools.includes('Write')
      if (builder) {
        builds.push(p)
        open.push(maybe(w.root, 1, 'findings.open.md'))
        refusals.push(maybe(w.root, 1, 'refusal.md'))
        writeFileSync(join(p.cwd, 'src/hello.ts'), `export const hello = (): string => "hey ${String(builds.length)}"\n`)
      } else if (!p.prompt.includes('# brief_writer')) reviews += 1
      return stub(builds.length === 2 ? BARE : CARRIED, 0, reviews === 1 ? REFUSE : PASS).fire(p)
    },
  }
  for (let at = 0; at < 20 && reviews < 2; at += 1) await tick(w.db, w.root, provider, undefined, undefined, watched([], w.root, 1))
  expect(open).toEqual([null, ROW, ROW])
  for (const p of builds.slice(1)) expect(p.prompt).toContain(`# Review findings\n\nUnder \`## Findings answered\` in your hand-back`)
  expect(builds[1]?.prompt).toContain(ROW)
  expect(refusals[2]).toContain('completion-audit: F1 open from the last review refuse')
  const audits = verdictRows(w.db, 1).filter((v) => v.rail_id === 'completion-audit')
  expect(audits.map((v) => v.outcome)).toEqual(['pass', 'pass', 'refuse', 'pass', 'pass'])
  expect(refusals[2]).toContain('spans:\n  - F1\n')
  expect(verdictRows(w.db, 1).filter((v) => v.kind === 'review' && v.step === 4).map((v) => v.outcome)).toEqual(['refuse', 'pass'])
  expect(maybe(w.root, 1, 'findings.open.md')).toBeNull()
}, 120_000)
