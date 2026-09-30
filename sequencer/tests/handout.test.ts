import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet, Provider } from '../../providers/kind.ts'
import { pointed, STANDING } from '../brief.ts'
import { handout, WHOLE } from '../handout.ts'
import { tick } from '../index.ts'
import { PlanRow } from '../../store/plans.ts'
import { rule } from '../rule.ts'
import { stopped } from '../seat.ts'
import { put, ruled } from '../workspace.ts'
import { HANDOUT } from './bases.ts'
import { approve, CARRIED, PASS, stub, watched, world, type World } from './world.ts'

const BRIEF = ['# hello', '',
  '**What:** add `hello()`.', '**Why:** the ask asks for it.', '**When it ends:** it is exported.', '',
  '## Approach', '', 'Write it in `src/hello.ts`.', '',
  '## Settled facts', '', '- none: every name the change uses is in this checkout', '',
  '## Cases', '', '- D1 add `hello()` in `src/hello.ts`', '- D2 a call with no name is refused', '',
  '## Must not break', '', '- the exports already in the file', '',
  '## Files', '', '- `src/hello.ts`, `src/bye.ts:1`', '',
  '## Files to read', '', '- src/hello.ts — what it exports today', '',
  '## Who else reads what this changes', '', '- nobody else: the ask names these files', '',
  '## Tests', '', '- src/hello.ts — a call with no name is refused', '',
  '## Out of scope', '', '- everything the ask does not name', '',
  '## Standing', '', ...STANDING, ''].join('\n')

const LONG = ['function a(): number {', '  return 1', '}', '',
  ...[...Array(WHOLE).keys()].map((i) => `const filler${String(i)} = ${String(i)}`), '',
  'function b(): number {', '  return 2', '}', ''].join('\n')

const B = WHOLE + 6

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-handout-'))
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body)
  return dir
}

function briefed(): World {
  const w = world('warm', undefined, HANDOUT)
  approve(w.db, w.target)
  return w
}

/** The builder's packets, in order; `write` is what each build leaves in the checkout. */
function builds(packets: Packet[], write?: (cwd: string) => void): Provider {
  return stub(CARRIED, 0, PASS, (p) => {
    if (!p.tools.includes('Write')) return
    packets.push(p)
    write?.(p.cwd)
  }, BRIEF)
}

test('short whole, long by named block, long unnamed by length', () => {
  const src = tree({ 'long.ts': LONG, 'short.ts': 'export const short = 1\n' })
  expect(handout(src, [{ path: 'short.ts', line: null }])).toContain('## short.ts\n\n````\nexport const short = 1')

  const block = handout(src, [{ path: 'long.ts', line: B }, { path: 'long.ts', line: B + 1 }])
  expect(block).toContain(`## long.ts:${String(B)}-${String(B + 2)}`)
  expect(block).toContain('function b(): number {\n  return 2\n}')
  expect(block).not.toContain('function a')

  const unnamed = handout(src, [{ path: 'long.ts', line: null }])
  expect(unnamed).toContain(`${String(LONG.split('\n').length)} lines and no line named`)
  expect(unnamed).not.toContain('filler1 =')
})

test('a file the checkout does not hold is handed nothing', () => {
  expect(handout(tree({}), [{ path: 'gone.ts', line: null }])).toBe('')
})

test('the brief points a file at its line', () => {
  expect(pointed(BRIEF)).toEqual([{ path: 'src/bye.ts', line: 1 }])
})

test('a build is handed the files its brief lists', async () => {
  const w = briefed()
  const packets: Packet[] = []
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, builds(packets))
  expect(packets[0]?.prompt).toContain('## src/hello.ts\n')
  expect(packets[0]?.prompt).toContain('export const hello')
  expect(packets[0]?.prompt).toContain('export const bye')
})

test('a build packet opens with the map of the checkout', async () => {
  const w = briefed()
  const packets: Packet[] = []
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, builds(packets))
  expect(packets[0]?.prompt).toMatch(/^# MAP\.md — written by `cf map`\n/)
})

test('a rebuild is handed its refusal, diff and only touched files', async () => {
  const w = briefed()
  const packets: Packet[] = []
  const provider = builds(packets, (cwd) => { writeFileSync(join(cwd, 'src/extra.ts'), 'export const extra = 1\n') })
  for (let at = 0; at < 5 && packets.length < 2; at += 1) await tick(w.db, w.root, provider)
  const again = packets[1]?.prompt ?? ''
  expect(again).toContain('# Refused — rebuild only these spans')
  expect(again).toContain('+++ b/src/extra.ts')
  expect(again).toContain('## src/extra.ts\n')
  expect(again).not.toContain('export const bye')
})

test('a ruling added to ask.md after a build reaches the rebuild', async () => {
  const w = briefed()
  const packets: Packet[] = []
  const provider = builds(packets, (cwd) => {
    writeFileSync(join(cwd, 'src/extra.ts'), 'export const extra = 1\n')
    appendFileSync(join(cwd, '..', 'ask.md'), '## Ruling\n\nuse bye()\n')
  })
  for (let at = 0; at < 5 && packets.length < 2; at += 1) await tick(w.db, w.root, provider)
  expect(packets[1]?.prompt).toContain('# What the ask holds beyond this brief\n\n## Ruling\n\nuse bye()')
  expect(packets[0]?.prompt).not.toContain('use bye()')
})

test('a fixer answer in issue.md after a build reaches the rebuild', async () => {
  const w = briefed()
  const packets: Packet[] = []
  const provider = builds(packets, (cwd) => { writeFileSync(join(cwd, 'src/extra.ts'), 'export const extra = 1\n') })
  for (let at = 0; at < 5 && packets.length < 1; at += 1) await tick(w.db, w.root, provider)
  expect(rule(w.db, w.root, PlanRow.parse(w.db.prepare('SELECT * FROM plans WHERE id = 1').get()), 'fixer', 'use bye()')).toBe('issue.md')
  for (let at = 0; at < 5 && packets.length < 2; at += 1) await tick(w.db, w.root, provider)
  expect(packets[1]?.prompt).toMatch(/## Answer from the fixer \(\d{4}-\d{2}-\d{2}\)\n\nuse bye\(\)\n\n## Standing/)
  expect(packets[0]?.prompt).not.toContain('use bye()')
})

test('D1 rulings.md reaches the builder right after the brief', async () => {
  const w = briefed()
  put(w.root, 1, 'rulings.md', 'use bye()\n')
  const packets: Packet[] = []
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, builds(packets))
  expect(packets[0]?.prompt).toContain(`${BRIEF}\n\n# Rulings\n\nuse bye()`)
})

/** Every packet of a plan walked through senior review, with `rulings` as its `rulings.md` when given. */
async function walked(rulings?: string): Promise<Packet[]> {
  const w = world()
  approve(w.db, w.target)
  if (rulings !== undefined) put(w.root, 1, 'rulings.md', rulings)
  const packets: Packet[] = []
  const wire = watched([], w.root, 1)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => packets.push(p)), undefined, undefined, wire)
  return packets
}

test('rulings.md reaches both reviewers between # Issue and # Diff', async () => {
  const packets = await walked('use bye()\n')
  for (const seat of ['# code_quality', '# senior_review']) {
    const prompt = packets.find((p) => !p.tools.includes('Write') && p.prompt.includes(seat))?.prompt ?? ''
    expect(prompt.split('\n# Issue\n')[1]?.split('\n# Diff\n')[0]).toContain('\n\n# Rulings\n\nuse bye()')
  }
})

test('a missing or blank rulings.md puts no # Rulings in a packet', async () => {
  for (const rulings of [undefined, ' \n']) {
    const packets = await walked(rulings)
    expect(packets.filter((p) => p.prompt.includes('# senior_review'))).toHaveLength(1)
    expect(packets.filter((p) => p.prompt.includes('\n# Rulings\n'))).toEqual([])
  }
})

test('ruled: the tail past the copy, or the whole ask if it moved', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-ruled-'))
  put(root, 1, 'ask.md', '# ask\n')
  expect(ruled(root, 1)).toBeNull()
  put(root, 1, 'ask.briefed.md', '# ask\n')
  expect(ruled(root, 1)).toBeNull()
  put(root, 1, 'ask.md', '# ask\nruling\n')
  expect(ruled(root, 1)).toBe('ruling\n')
  put(root, 1, 'ask.md', '# moved\nruling\n')
  expect(ruled(root, 1)).toBe('# moved\nruling\n')
})

test('a stopped build resumes with its diff and no re-handed files', async () => {
  const w = briefed()
  const packets: Packet[] = []
  let fired = 0
  const inner = builds(packets, (cwd) => { writeFileSync(join(cwd, 'src/hello.ts'), 'export const hello = (): string => "hey"\n') })
  const provider: Provider = {
    ...inner,
    fire: async (packet) => {
      const out = await inner.fire(packet)
      if (!packet.tools.includes('Write')) return out
      fired += 1
      return fired === 1 ? { ...out, ended: 'stopped', exit: 1, stop_reason: 'ruling:run.token_wall stopped the run' } : out
    },
  }
  for (let at = 0; at < 5 && packets.length < 2; at += 1) await tick(w.db, w.root, provider)
  const again = packets[1]?.prompt ?? ''
  expect(again).toContain('# Your last fire stopped before it finished')
  expect(again).toContain('Not written yet: `src/bye.ts`')
  expect(again).toContain('+++ b/src/hello.ts')
  expect(again).not.toContain('# Refused — rebuild only these spans')
  expect(again).not.toContain('## src/hello.ts\n')
  expect(again).toContain('export const bye')
})

test('only a builder exit reads as stopped', () => {
  expect(stopped('step 2 build refused by outside_specialist\n\noutside_specialist stopped\n\nspans:\n  - ruling:run.token_wall\n')).toBe(true)
  expect(stopped('step 2 build refused by outside_specialist\n\nrails: src/a.ts outside the fence\n\nspans:\n  - src/a.ts\n')).toBe(false)
  expect(stopped('step 3 build refused by checks\n\nnpm run lint exit 3\n\nspans:\n  - npm run lint\n')).toBe(false)
  expect(stopped('step 4 review refused by code_quality\n\ncode_quality refuse\n\nspans:\n  - src/a.ts:6\n')).toBe(false)
})
