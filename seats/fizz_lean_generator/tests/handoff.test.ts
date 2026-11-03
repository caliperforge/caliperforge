import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, test } from 'vitest'
import { type At, compiled, extract, type Node } from '../../../templates/extract.ts'
import { handoff, layered, ranged } from '../../../templates/handoff.ts'

const skill = join(import.meta.dirname, '../skill')
const READ = '- x-ray/x-ray.md, Vault.deposit and Vault.redeem — the entry points to call'
const FACT = {
  Signatures: '- Vault.deposit(uint256 assets, address to) returns (uint256) | at: src/Vault.sol L40-L52',
  Guards: '- Vault.deposit | reverts: assets == 0 with ZeroAssets() | at: src/Vault.sol L41-L42',
  Roles: '- onlyOwner | holds: deployer | gates: Vault.setCap',
  Limits: '- Vault.cap | bound: totalAssets at most cap | at: src/Vault.sol L44-L44',
}
const FACTS = Object.entries(FACT).map(([name, row]) => `\n## ${name}\n\n${row}\n`).join('')
const TRACKED = ['Conversion points', 'Aggregates', 'Not tracked'].map((name) => `\n## ${name}\n\n- none\n`).join('')
const FILLED: Record<string, string> = {
  context: `phase: context\nnext: scaffold\nmode: automatic\nagent_model: opus\n\n## Reads\n\n${READ}\n${FACTS}${TRACKED}`,
  scaffold: `phase: scaffold\nnext: coverage\n\n## Reads\n\n${READ}\n${FACTS}\n## Stand-ins\n\n- MockStrategy | limits: max interest 1e15 per call, only vault mints\n`,
  coverage: `phase: coverage\nnext: invariants\nfuzz_build_cmd: forge build\n\n## Reads\n\n${READ}\n${FACTS}`,
  invariants: `phase: invariants\nnext: campaigns\n\n## Reads\n\n${READ}\n${FACTS}\n## Converted values\n\n- property_redeemConserves | tolerance: 2 wei × 3\n`,
  campaigns: 'phase: campaigns\nnext: none\nfuzzer: medusa\n',
}

const changed = (phase: string, from: string, to: string): string => {
  const text = FILLED[phase] ?? ''
  expect(text).toContain(from)
  return text.replace(from, to)
}

test('D1: one block per phase in order, each filled one passes', () => {
  const blocks = readFileSync(join(skill, 'phases/handoff/templates.md'), 'utf8').match(/^# Handoff: .*$/gm)
  expect(blocks).toEqual(Object.keys(FILLED).map((phase) => `# Handoff: ${phase}`))
  for (const [phase, text] of Object.entries(FILLED)) expect(handoff(skill, phase, text)).toEqual([])
  expect(() => handoff(skill, 'deploy', '')).toThrow(/deploy/)
})

test.each([
  ['mode', 'mode: automatic\n', ''],
  ['agent_model', 'agent_model: opus', 'agent_model: <sonnet or opus>'],
  ['phase', 'phase: context', 'phase: scaffold'],
])('D2: a context %s left unfilled is handoff.field', (key, from, to) => {
  const refused = handoff(skill, 'context', changed('context', from, to))
  expect(refused).toEqual([{ rule: 'handoff.field', note: expect.stringContaining(`context: ${key} `) as string }])
})

test('D3: scaffold without ## Stand-ins is handoff.field', () => {
  const text = changed('scaffold', '## Stand-ins\n\n- MockStrategy | limits: max interest 1e15 per call, only vault mints\n', '')
  expect(handoff(skill, 'scaffold', text)).toEqual([{ rule: 'handoff.field', note: 'scaffold: ## Stand-ins is missing or has no row' }])
})

test.each(Object.entries(FACT))('D2: no coverage ## %s is refused; - none passes', (name, row) => {
  const section = `\n## ${name}\n\n${row}\n`
  expect(handoff(skill, 'coverage', changed('coverage', section, ''))).toEqual([{ rule: 'handoff.field', note: `coverage: ## ${name} is missing or has no row` }])
  expect(handoff(skill, 'coverage', changed('coverage', row, '- none'))).toEqual([])
})

test.each(['', '- none'])('D4: coverage ## Reads holding %j is handoff.reads', (to) => {
  expect(handoff(skill, 'coverage', changed('coverage', READ, to))).toMatchObject([{ rule: 'handoff.reads', note: expect.stringContaining('## Reads') as string }])
})

test('D5: a converted value needs a tolerance or a delta', () => {
  const bare = changed('invariants', 'tolerance: 2 wei × 3', 'tolerance:')
  expect(handoff(skill, 'invariants', bare)).toEqual([{ rule: 'handoff.converted', note: expect.stringContaining('property_redeemConserves') as string }])
  expect(handoff(skill, 'invariants', changed('invariants', 'tolerance: 2 wei × 3', 'tolerance: | delta: asset.balanceOf(vault)'))).toEqual([])
})

test('D6: a stand-in needs its limits, - none passes', () => {
  const row = '- MockStrategy | limits: max interest 1e15 per call, only vault mints'
  expect(handoff(skill, 'scaffold', changed('scaffold', row, '- MockStrategy'))).toEqual([{ rule: 'handoff.stand_in', note: expect.stringContaining('MockStrategy') as string }])
  expect(handoff(skill, 'scaffold', changed('scaffold', row, '- none'))).toEqual([])
})

test('D7: campaigns passes without ## Reads', () => {
  expect(FILLED.campaigns).not.toContain('## Reads')
  expect(handoff(skill, 'campaigns', FILLED.campaigns ?? '')).toEqual([])
})

const fixtures = join(import.meta.dirname, 'fixtures')
const V = readFileSync(join(fixtures, 'V.sol'))
const AST = readFileSync(join(fixtures, 'V.ast.json'), 'utf8')
const ROWS = {
  checks: [{ file: 'src/V.sol', start: 9, end: 9, name: 'V.deposit', kind: 'require' }],
  state: [{ file: 'src/V.sol', start: 5, end: 5, name: 'V.CAP', constant: true, writers: [] },
    { file: 'src/V.sol', start: 6, end: 6, name: 'V.totalAssets', constant: false, writers: ['V.deposit', 'V.withdraw'] }],
  conversions: [{ file: 'src/V.sol', start: 17, end: 19, name: 'V.convertToAssets', divisions: [18] }],
  aggregates: ['V.totalAssets'],
}
const CITED = {
  Signatures: '- V.deposit(uint256 assets) | at: src/V.sol L8-L11',
  Guards: '- V.deposit | reverts: totalAssets + assets > CAP with "cap" | at: src/V.sol L9-L9',
  Roles: '- none',
  Limits: '- V.CAP | bound: totalAssets at most 1e24 | at: src/V.sol L5-L5',
  'Conversion points': '- V.convertToAssets | converts: shares to assets, rounding down at the division | at: src/V.sol L17-L19',
  Aggregates: '- V.totalAssets | parts: deposits less withdrawals | movers: V.deposit, V.withdraw | at: src/V.sol L6-L6',
  'Not tracked': '- none',
  'Outside dependencies': '- none',
}
const HANDED = Object.entries(CITED).map(([name, row]) => `## ${name}\n\n${row}\n`).join('\n')

function project(source: Buffer = V, ast = AST, name = 'V'): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-fizz-extract-'))
  mkdirSync(join(root, `out/${name}.sol`), { recursive: true })
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, `src/${name}.sol`), source)
  writeFileSync(join(root, `out/${name}.sol/${name}.json`), ast)
  return root
}

const root = project()
const facts = extract(root)
const cut = (from: string, to: string): string => {
  expect(HANDED).toContain(from)
  return HANDED.replace(from, to)
}

test('1753a D1: extract pins the four rows of V.sol', () => {
  expect(facts).toMatchObject(ROWS)
  expect(ranged(root, HANDED, facts)).toEqual([])
})

test('1753a D2: a Guards row on L13-L15 is handoff.cited', () => {
  expect(ranged(root, cut('L9-L9', 'L13-L15'), facts)).toEqual([{ rule: 'handoff.cited',
    note: 'context: V.deposit under ## Guards cites src/V.sol L13-L15, which hold no require, revert or custom error' }])
})

test('an Aggregates row is matched on its bare symbol', () => {
  const cited = (name: string, at: string): string[] => ranged(root, cut('V.totalAssets | parts', `${name} | parts`).replace('L6-L6', at), facts)
    .filter((r) => r.rule === 'handoff.cited').map((r) => r.note)
  expect(cited('A2 V.totalAssets write sites in deposit', 'L10-L10')).toEqual([])
  expect(cited('A2b totalAssets (deposits)', 'L10-L10')).toEqual([])
  const view = 'A4 V.convertToAssets() (view)'
  expect(cited(view, 'L17-L19')).toEqual([`context: ${view} under ## Aggregates cites src/V.sol L17-L19, which hold no declaration of or write to ${view}`])
})

test('1753a D3: an untracked aggregate needs a reason', () => {
  const untracked = [{ rule: 'handoff.untracked', note: 'context: V.totalAssets is an aggregate candidate in neither ## Aggregates nor ## Not tracked with a reason' }]
  const none = cut(CITED.Aggregates, '- none')
  expect(ranged(root, none, facts)).toEqual(untracked)
  const reason = (why: string): string => none.replace('## Not tracked\n\n- none', `## Not tracked\n\n- V.totalAssets | reason:${why}`)
  expect(ranged(root, reason(''), facts)).toEqual(untracked)
  expect(ranged(root, reason(' read only by the conversion'), facts)).toEqual([])
})

test('1753a D3: a total* user-defined value type is a candidate', () => {
  const typed = AST.replace('"nodeType": "ElementaryTypeName", "src": "115:7:0"', '"nodeType": "UserDefinedTypeName", "src": "115:7:0"')
  expect(typed).not.toBe(AST)
  expect(extract(project(V, typed)).aggregates).toEqual(['V.totalAssets'])
})

test('1753a D4: movers missing V.withdraw is handoff.movers', () => {
  expect(ranged(root, cut('movers: V.deposit, V.withdraw', 'movers: V.deposit'), facts))
    .toEqual([{ rule: 'handoff.movers', note: expect.stringContaining('missing movers V.withdraw') as string }])
})

const outside = `${relative(root, join(fixtures, 'V.sol'))} L1-L1`
test.each(['src/V.sol L0-L3', 'src/V.sol L9-L99', 'src/W.sol L1-L1', 'src L1-L1', outside])('1753a D5: Guards at %s is handoff.range', (at) => {
  expect(ranged(root, cut('src/V.sol L9-L9', at), facts)).toEqual([{ rule: 'handoff.range', note: expect.stringContaining(at) as string }])
})

test('1753a D6: a multi-byte comment leaves the lines', () => {
  const blank = V.indexOf('\n\n    function deposit') + 1
  const comment = Buffer.from('    // dépôt ≤ CAP — ü')
  expect(comment.length).toBeGreaterThan(comment.toString().length + 1)
  const ast = AST.replace(/(?<="src": ")\d+:\d+(?=:0")/g, (src) => {
    const [start = 0, length = 0] = src.split(':').map(Number)
    return `${String(start >= blank ? start + comment.length : start)}:${String(start < blank && start + length > blank ? length + comment.length : length)}`
  })
  expect(extract(project(Buffer.concat([V.subarray(0, blank), comment, V.subarray(blank)]), ast))).toMatchObject(ROWS)
})

test('1753b D3: a scaffold editing ## Guards is handoff.layer', () => {
  expect(layered('scaffold', HANDED, cut('L9-L9', 'L9-L10'))).toEqual([{ rule: 'handoff.layer', note: 'scaffold: ## Guards is the context layer\'s and changed' }])
  expect(layered('scaffold', HANDED, `${HANDED}\n## Known holes\n\n- MockStrategy interest | reason: only vault mints\n`)).toEqual([])
})

test('1753b D4: a map with no ## Outside dependencies is refused', () => {
  expect(ranged(root, cut(`## Outside dependencies\n\n${CITED['Outside dependencies']}\n`, ''), facts))
    .toEqual([{ rule: 'handoff.field', note: 'context: ## Outside dependencies is missing from map.md or has no row' }])
})

test.runIf(process.env.CF_BENCH_LIVE === '1')('1753a D7: forge on a fresh V.sol gives the D1 rows', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'cf-fizz-forge-'))
  mkdirSync(join(fresh, 'src'))
  writeFileSync(join(fresh, 'src/V.sol'), V)
  expect(compiled(fresh)).toEqual([])
  expect(extract(fresh)).toMatchObject(ROWS)
})

const P = readFileSync(join(fixtures, 'P.sol'))
const P_AST = readFileSync(join(fixtures, 'P.ast.json'), 'utf8')
const pRoot = project(P, P_AST, 'P')
const pFacts = extract(pRoot)
const MOVERS = 'P.accept, P.reallocate, A.reallocateTo'
const pMap = (movers: string, at = 'src/P.sol L14-L14'): string => ['Roles', 'Guards', 'Limits', 'Outside dependencies', 'Conversion points', 'Not tracked']
  .map((name) => `## ${name}\n\n- none\n`).join('\n') + `\n## Aggregates\n\n- P.cfg | parts: caps and balances | movers: ${movers} | at: ${at}\n`
const line = (n: number): At => ({ file: 'src/P.sol', start: n, end: n })

test('2065 D1: a write through a storage local is a write', () => {
  expect(pFacts.state.find((v) => v.name === 'P.cfg')?.writes).toEqual([line(23), line(27)])
})

test('2065 D2: a call through an interface is a mover', () => {
  expect(pFacts.state.find((v) => v.name === 'P.cfg')?.writers).toEqual(MOVERS.split(', '))
  expect(ranged(pRoot, pMap(MOVERS), pFacts)).toEqual([])
})

test('2065 D3: movers stay one exact set', () => {
  expect(ranged(pRoot, pMap('P.accept, P.reallocate'), pFacts))
    .toEqual([{ rule: 'handoff.movers', note: expect.stringContaining('missing movers A.reallocateTo and has extra movers none') as string }])
  expect(ranged(pRoot, pMap(`${MOVERS}, A.peek`), pFacts))
    .toEqual([{ rule: 'handoff.movers', note: expect.stringContaining('missing movers none and has extra movers A.peek') as string }])
})

test('2065 D4: an Aggregates row at the aliased write is cited', () => {
  expect(ranged(pRoot, pMap(MOVERS, 'src/P.sol L23-L23'), pFacts)).toEqual([])
})

test('2065 D5: a caller in another contract is no second path', () => {
  expect(pFacts.state.find((v) => v.name === 'P.moves')?.writers).toEqual(['P.reallocate', 'A.reallocateTo'])
  expect(pFacts.aggregates).toEqual([])
})

test('2065 D5: a writer inherited from a base contract counts', () => {
  const { ast } = JSON.parse(P_AST) as { ast: Node }
  const p = ast.nodes?.find((n) => n.name === 'P')?.nodes ?? []
  p.push(...p.filter((n) => n.name === 'reallocate').map((n) => ({ ...n, id: 160, name: 'rebalance', functionSelector: '5e6f7a8b' })))
  ast.nodes?.push({ id: 90, name: 'Base', nodeType: 'ContractDefinition', src: '0:0:0', nodes: p.splice(p.findIndex((n) => n.name === 'moves'), 1) })
  expect(extract(project(P, JSON.stringify({ ast }), 'P')).aggregates).toEqual(['Base.moves'])
})

type Body = Node & { body: { statements: object[] } }
const REVERT = { id: 170, nodeType: 'RevertStatement', src: '442:9:0' }

function guard(at: string, edit: (of: (name: string) => Body[], p: Body[]) => void): string[] {
  const { ast } = JSON.parse(P_AST) as { ast: Node }
  const p = (ast.nodes?.find((n) => n.name === 'P')?.nodes ?? []) as Body[]
  edit((name) => p.filter((n) => n.name === name), p)
  const guarded = project(P, JSON.stringify({ ast }), 'P')
  const map = pMap(MOVERS).replace('## Guards\n\n- none', `## Guards\n\n- P.accept | reverts: v over cap | at: src/P.sol ${at}`)
  return ranged(guarded, map, extract(guarded)).map((r) => r.note)
}

test('a guard reached through a modifier or internal call is cited', () => {
  const refused = (at: string): string[] => [`context: P.accept under ## Guards cites src/P.sol ${at}, which hold no require, revert or custom error`]
  expect(guard('L18-L18', () => undefined)).toEqual(refused('L18-L18'))
  expect(guard('L18-L18', (of) => { of('_set').forEach((n) => n.body.statements.push(REVERT)) })).toEqual([])
  expect(guard('L18-L18', (of, p) => {
    p.push(...of('_set').map((n) => ({ ...n, id: 180, name: '_guard', body: { ...n.body, statements: [REVERT] } })))
    of('_set').forEach((n) => n.body.statements.push({ id: 181, nodeType: 'FunctionCall', src: '442:9:0',
      expression: { id: 182, name: '_guard', nodeType: 'Identifier', referencedDeclaration: 180, src: '442:4:0' } }))
  })).toEqual([])
  const modifier = (statements: object[]) => (of: (name: string) => Body[], p: Body[]): void => {
    p.push(...of('_set').map((n) => ({ ...n, id: 190, name: 'capped', nodeType: 'ModifierDefinition', body: { ...n.body, statements } })))
    of('reallocate').forEach((n) => n.modifiers?.push({ id: 191, nodeType: 'ModifierInvocation', src: '483:11:0', modifierName: { name: 'capped', referencedDeclaration: 190 } }))
  }
  expect(guard('L26-L26', modifier([REVERT]))).toEqual([])
  expect(guard('L26-L26', modifier([]))).toEqual(refused('L26-L26'))
})

test.runIf(process.env.CF_BENCH_LIVE === '1')('2065: forge on a fresh P.sol gives the D1/D2 writers', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'cf-fizz-forge-'))
  mkdirSync(join(fresh, 'src'))
  writeFileSync(join(fresh, 'src/P.sol'), P)
  expect(compiled(fresh)).toEqual([])
  expect(extract(fresh).state.find((v) => v.name === 'P.cfg')).toMatchObject({ writers: MOVERS.split(', '), writes: [line(23), line(27)] })
})
