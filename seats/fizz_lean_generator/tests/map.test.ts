import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { extract, type Node } from '../../../templates/extract.ts'
import { drawn, excerpts } from '../../../templates/map.ts'
import { benched } from './benched.ts'

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

async function ran(handoffs: string, maps: Record<string, string | string[]>) {
  const fires: { phase: string; issue: string }[] = []
  const { run } = benched((packet, phase) => {
    fires.push({ phase, issue: packet.prompt })
    writeFileSync(join(handoffs, `${phase}.md`), HANDED[phase as keyof typeof HANDED])
    const map = maps[phase]
    const text = typeof map === 'string' ? map : map?.[fires.filter((f) => f.phase === phase).length - 1]
    if (text !== undefined) writeFileSync(join(handoffs, 'map.md'), text)
    return {}
  })
  return { fires, outcome: await run(skill, handoffs, 'scaffold') }
}

test('D1: drawn writes the machine layer, keeps the agent\'s', () => {
  const { root } = project()
  expect(drawn(extract(root), SELECTION, `## Signatures\n\n- V.bogus() | at: src/V.sol L1-L1\n\n${CONTEXT}`)).toBe(`${MACHINE}\n${CONTEXT}`)
})

test('an inherited function gets its at: from the parent\'s file', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-fizz-map-'))
  for (const dir of ['out/V.sol', 'out/C.sol', 'src', 'lib']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'lib/V.sol'), V)
  writeFileSync(join(root, 'out/V.sol/V.json'), readFileSync(join(fixtures, 'V.ast.json'), 'utf8').replace('"src/V.sol"', '"lib/V.sol"'))
  const { ast } = JSON.parse(readFileSync(join(fixtures, 'V.ast.json'), 'utf8')) as { ast: Node }
  const withdraw = { ...ast.nodes?.[1]?.nodes?.find((n) => n.name === 'withdraw'), id: 70 }
  const c = { id: 60, name: 'C', nodeType: 'ContractDefinition', src: '0:20:1', linearizedBaseContracts: [60, 50], nodes: [withdraw] }
  writeFileSync(join(root, 'src/C.sol'), 'contract C is V {}\n')
  writeFileSync(join(root, 'out/C.sol/C.json'), JSON.stringify({ ast: { absolutePath: 'src/C.sol', id: 61, nodeType: 'SourceUnit', src: '0:20:1', nodes: [c] } }))
  const facts = extract(root)
  expect(facts.inherited.map((s) => s.name)).toEqual(['C.deposit', 'C.convertToAssets'])
  expect(drawn(facts, '[]', '')).toContain('- C.deposit(uint256 assets) | at: lib/V.sol L8-L11\n')
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
  expect((await ran(handoffs, { context: CONTEXT })).outcome).toMatchObject({ outcome: 'needs_coo', spans: ['handoff.map'] })
})

test('D6: scaffold names map and excerpts, Guards rewrite refused', async () => {
  const { handoffs } = project()
  const { fires, outcome } = await ran(handoffs, { context: CONTEXT, scaffold: `${MACHINE}\n${CONTEXT.replace('L9-L9', 'L9-L10')}` })
  const cut = readdirSync(join(handoffs, 'excerpts'))
  expect(cut).toContain('guards-1.sol.txt')
  for (const file of ['map.md', ...cut.map((f) => join('excerpts', f))]) expect(fires[1]?.issue).toContain(join(handoffs, file))
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'scaffold'])
  expect(outcome).toMatchObject({ outcome: 'needs_coo', spans: ['handoff.layer'] })
})

const GUARDS = '- handoff.cited: context: V.deposit under ## Guards cites src/V.sol L13-L15, which hold no require, revert or custom error'
const LIMITS = '- handoff.cited: context: V.CAP under ## Limits cites src/V.sol L13-L15, which hold no state declaration or check'

test('a context map refused twice alike goes to the director', async () => {
  const { handoffs } = project()
  const { fires, outcome } = await ran(handoffs, { context: CONTEXT.replace('L9-L9', 'L13-L15') })
  expect(fires.map((f) => f.phase)).toEqual(['context', 'context'])
  expect(outcome).toEqual({ outcome: 'needs_coo', spans: ['handoff.cited'], note: 'context handoff refused twice on the same span',
    message: `Refused:\n${GUARDS}\n\nRefused again:\n${GUARDS}` })
})

test('a context map refused on new items runs again', async () => {
  const { handoffs } = project()
  const context = [CONTEXT.replace('L9-L9', 'L13-L15'), CONTEXT.replace('L5-L5', 'L13-L15'), CONTEXT]
  const { fires } = await ran(handoffs, { context, scaffold: `${MACHINE}\n${CONTEXT.replace('L9-L9', 'L9-L10')}` })
  expect(fires.map((f) => f.phase)).toEqual(['context', 'context', 'context', 'scaffold', 'scaffold'])
  expect(fires[1]?.issue).toContain(`Your handoff was refused:\n${GUARDS}`)
  expect(fires[2]?.issue).toContain(`Your handoff was refused:\n${LIMITS}`)
  expect(fires[2]?.issue).not.toContain(GUARDS)
})
