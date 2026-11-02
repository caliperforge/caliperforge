import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { extract } from '../../../templates/extract.ts'
import { drawn, excerpts } from '../../../templates/map.ts'
import { type Fire, phased } from '../../../templates/phases.ts'

vi.mock('../../../templates/extract.ts', async (importOriginal) => ({ ...await importOriginal<object>(), compiled: () => [] }))

const skill = join(import.meta.dirname, '../skill')
const fixtures = join(import.meta.dirname, 'fixtures')
const V = readFileSync(join(fixtures, 'V.sol'))
const SELECTION = readFileSync(join(fixtures, 'entry-point-selection.json'), 'utf8')
const CONTEXT = Object.entries({
  Roles: '- none',
  Guards: '- V.deposit | reverts: totalAssets + assets > CAP with "cap" | at: src/V.sol L9-L9',
  Limits: '- V.CAP | bound: totalAssets at most 1e24 | at: src/V.sol L5-L5',
  'Outside dependencies': '- none',
  'Conversion points': '- V.convertToAssets | converts: shares to assets, rounding down at the division | at: src/V.sol L17-L19',
  Aggregates: '- V.totalAssets | parts: deposits less withdrawals | movers: V.deposit, V.withdraw | at: src/V.sol L6-L6',
  'Not tracked': '- none',
}).map(([name, row]) => `## ${name}\n\n${row}\n`).join('\n')
const MACHINE = [
  '## Signatures\n\n- V.deposit(uint256 assets) | at: src/V.sol L8-L11\n- V.withdraw(uint256 assets) | at: src/V.sol L13-L15\n'
  + '- V.convertToAssets(uint256 shares) returns (uint256) | at: src/V.sol L17-L19\n',
  '## Selected entry points\n\n- V.deposit(uint256 assets) | tier: primary\n- V.withdraw(uint256 assets) | tier: primary\n'
  + '- V.convertToAssets(uint256 shares) | tier: secondary\n',
  '## Modifiers\n\n- none\n',
].join('\n')
const HANDED = { context: 'phase: context\nnext: scaffold\nmode: automatic\nagent_model: opus\n\n## Reads\n\n- x-ray/x-ray.md — the entry points\n',
  scaffold: `phase: scaffold\nnext: coverage\n\n## Reads\n\n- x-ray/x-ray.md — the entry points\n${['Signatures', 'Guards', 'Roles', 'Limits', 'Stand-ins'].map((name) => `\n## ${name}\n\n- none\n`).join('')}` }

function project(selection = true): { root: string; handoffs: string } {
  const root = mkdtempSync(join(tmpdir(), 'cf-fizz-map-'))
  const handoffs = join(root, 'test/fizz/fizz_data/handoff')
  for (const dir of [join(root, 'out/V.sol'), join(root, 'src'), handoffs]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'src/V.sol'), V)
  copyFileSync(join(fixtures, 'V.ast.json'), join(root, 'out/V.sol/V.json'))
  if (selection) writeFileSync(join(handoffs, '../entry-point-selection.json'), SELECTION)
  return { root, handoffs }
}

const lines = (start: number, end: number): Buffer => Buffer.from(V.toString().split('\n').slice(start - 1, end).map((l) => `${l}\n`).join(''))

async function ran(handoffs: string, maps: Record<string, string>) {
  const fires: { phase: string; issue: string }[] = []
  const fire: Fire = (...args) => {
    const [, issue, sum, phase = ''] = args
    fires.push({ phase, issue })
    writeFileSync(join(handoffs, `${phase}.md`), HANDED[phase as keyof typeof HANDED])
    if (maps[phase] !== undefined) writeFileSync(join(handoffs, 'map.md'), maps[phase])
    return Promise.resolve({ ...sum, tokens: sum.tokens + 1 })
  }
  return { fires, outcome: await phased(fire, skill, handoffs, 'Generate.', () => [], 'scaffold') }
}

test('D1: drawn writes the machine layer, keeps the agent\'s', () => {
  const { root } = project()
  expect(drawn(extract(root), SELECTION, `## Signatures\n\n- V.bogus() | at: src/V.sol L1-L1\n\n${CONTEXT}`)).toBe(`${MACHINE}\n${CONTEXT}`)
})

test('D2: excerpts are V.sol\'s bytes for the cited lines', () => {
  const { root, handoffs } = project()
  const dir = join(handoffs, 'excerpts')
  excerpts(root, `${MACHINE}\n${CONTEXT}`, dir)
  expect(readFileSync(join(dir, 'guards-1.sol.txt'))).toEqual(lines(9, 9))
  expect(readFileSync(join(dir, 'conversion-points-1.sol.txt'))).toEqual(lines(17, 19))
})

test('D5: a context run with no selection is handoff.map', async () => {
  const { handoffs } = project(false)
  expect((await ran(handoffs, { context: CONTEXT })).outcome).toMatchObject({ outcome: 'refuse', spans: ['handoff.map'] })
})

test('D6: scaffold names map and excerpts, Guards rewrite refused', async () => {
  const { handoffs } = project()
  const { fires, outcome } = await ran(handoffs, { context: CONTEXT, scaffold: `${MACHINE}\n${CONTEXT.replace('L9-L9', 'L9-L10')}` })
  const cut = readdirSync(join(handoffs, 'excerpts'))
  expect(cut).toContain('guards-1.sol.txt')
  for (const file of ['map.md', ...cut.map((f) => join('excerpts', f))]) expect(fires[1]?.issue).toContain(join(handoffs, file))
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'scaffold'])
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['handoff.layer'] })
})
