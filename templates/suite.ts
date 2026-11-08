import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type At, below, called, entries, type Member, membersOf, type Node } from './extract.ts'
import { FIELD, filled, parsed, type Refused } from './handoff.ts'
import { RANGE } from './map.ts'
import { covered } from './reach.ts'
import { rows } from './slices.ts'

export interface Suite {
  deployed: (At & { contract: string; args: string[]; via?: 'factory' })[]
  actors: (At & { name: string; roles: string[] })[]
  handlers: (At & { name: string; clamped: boolean; target: string | null; clamps: { text: string; range: string }[] })[]
  standIns: (At & { name: string; replaces: string; limits: { limit: string; map: string | null }[] })[]
  probes: (At & { name: string; cites: string | null; trackers: string[]; calls: string[] })[]
  trackers: (At & { name: string; type: string; writers: string[] })[]
  build: { command: string | null; via_ir: string | null; optimizer: string | null }
}

interface Solc extends Node { arguments?: Node[]; stateMutability?: string; rightExpression?: Node; rightHandSide?: Node }

interface Part extends Member { bytes: (node: Node) => string }

interface Contract { name: string; at: At; text: string; members: Part[] }

interface Medusa { compilation?: { platform?: string; platformConfig?: { target?: string; args?: string[] } } }

const HARNESS = 'test/fizz/'
const CONTRACT = 'contract '
const CLAMPED = '_clamped'
const STAND_IN = /^(?:Mock|StandIn)(.+)$/
const PROBE = /^Probe./
const CITES = /^\s*\/\/ probe:\s*(\S.*?)\s*$/m
const ADDRESS = /^address(?: payable)?$/
const PROPERTY = /^(?:invariant|property|echidna)_/
const LIMITS = /^\s*\/\/ stand-in limits:(.*)$/
const LIMIT = /^\s*\/\/ - (.*)$/
const MAPPED = / \| map: (.+)$/
const NONE = 'none'
const CLAMPS = new Set(['bound', 'between'])
const ACTORS = new Set(['address', 'address[]'])

const type = (node: Node | undefined): string => node?.typeDescriptions?.typeString ?? ''

const contractOf = (node: Node | undefined): string => type(node).startsWith(CONTRACT) ? type(node).slice(CONTRACT.length) : ''

const calls = (node: Node): Solc[] => below(node).filter((n) => n.nodeType === 'FunctionCall')

const read = (path: string): string | null => existsSync(path) ? readFileSync(path, 'utf8') : null

function contracts(root: string, file: string, unit: Node): Contract[] {
  const source = readFileSync(join(root, file))
  const bytes = (node: Node): string => {
    const [start = 0, length = 0] = node.src.split(':').map(Number)
    return source.subarray(start, start + length).toString()
  }
  return membersOf(file, source, { ...unit, nodes: [{ ...unit, nodeType: 'ContractDefinition' }] })
    .filter((c) => c.node.nodeType === 'ContractDefinition')
    .map((c) => ({ name: c.node.name ?? '', at: c.at(c.node), text: bytes(c.node), members: membersOf(file, source, { ...unit, nodes: [c.node] }).map((m) => ({ ...m, bytes })) }))
}

function harness(root: string): Contract[] {
  const units = new Map<string, Node>()
  for (const path of readdirSync(join(root, 'out'), { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.json'))) {
    const { ast } = JSON.parse(readFileSync(join(root, 'out', path), 'utf8')) as { ast?: Node }
    if (ast?.absolutePath?.startsWith(HARNESS) === true) units.set(ast.absolutePath, ast)
  }
  return [...units].flatMap(([file, unit]) => contracts(root, file, unit))
}

function made(setup: Part, n: Solc): Suite['deployed'] {
  const [contract, cast] = [contractOf(n.leftHandSide), n.rightHandSide]
  const call = cast?.kind === 'typeConversion' && contract !== '' && contractOf(cast) === contract
    ? calls(cast).find((c) => c.kind === 'functionCall' && c.expression?.nodeType !== 'NewExpression') : undefined
  return call === undefined ? [] : [{ ...setup.at(n), contract, args: (call.arguments ?? []).map(setup.bytes), via: 'factory' }]
}

const deploys = (setup: Part): Suite['deployed'] => [
  ...calls(setup.node).filter((n) => n.expression?.nodeType === 'NewExpression' && contractOf(n) !== '')
    .map((n) => ({ ...setup.at(n), contract: contractOf(n), args: (n.arguments ?? []).map(setup.bytes) })),
  ...below(setup.node).filter((n) => n.nodeType === 'Assignment').flatMap((n) => made(setup, n)),
]

const roles = (setup: Part, who: string): string[] => calls(setup.node).filter((n) => called(n) === 'grantRole')
  .flatMap(({ arguments: [role, holder] = [] }) => role !== undefined && holder !== undefined && setup.bytes(holder) === who ? [setup.bytes(role)] : [])

const handler = ({ node }: Part): boolean => ['public', 'external'].includes(node.visibility ?? '') && !['view', 'pure'].includes((node as Solc).stateMutability ?? '')
  && node.name !== 'setup' && !PROPERTY.test(node.name ?? '')

function aimed(f: Part, functions: Part[], live: Set<string>, seen = new Set<number>()): string | null {
  seen.add(f.node.id)
  const callees = calls(f.node).map((n) => n.expression)
  const direct = callees.find((e) => e?.nodeType === 'MemberAccess' && live.has(contractOf(e.expression)) && !/\b(?:view|pure)\b/.test(type(e)))
  if (direct !== undefined) return `${contractOf(direct.expression)}.${direct.memberName ?? ''}`
  return callees.map((e) => functions.find((g) => g.node.id === e?.referencedDeclaration)).filter((g): g is Part => g !== undefined && !seen.has(g.node.id))
    .map((g) => aimed(g, functions, live, seen)).find((t) => t !== null) ?? null
}

function range(n: Solc): Node | undefined {
  if (CLAMPS.has(called(n))) return n.arguments?.at(-1)
  return n.nodeType === 'BinaryOperation' && n.operator === '%' ? n.rightExpression : undefined
}

const clamps = (h: Part): Suite['handlers'][number]['clamps'] => below(h.node).flatMap((n) => {
  const r = range(n)
  return r === undefined ? [] : [{ text: h.bytes(n), range: h.bytes(r) }]
})

function limitsOf(text: string): string[] {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => LIMITS.test(l))
  if (at < 0) return []
  const after = lines.slice(at + 1)
  const end = after.findIndex((l) => !LIMIT.test(l))
  return [LIMITS.exec(lines[at] ?? '')?.[1] ?? '', ...after.slice(0, end < 0 ? after.length : end).map((l) => LIMIT.exec(l)?.[1] ?? '')]
    .map((l) => l.trim()).filter((l) => l !== '')
}

const standIn = (c: Contract): Suite['standIns'][number] => ({ ...c.at, name: c.name, replaces: STAND_IN.exec(c.name)?.[1] ?? '',
  limits: limitsOf(c.text).map((l) => { const m = MAPPED.exec(l); return { limit: m === null ? l : l.slice(0, m.index), map: m?.[1] ?? null } }) })

const external = (n: Solc): boolean => n.expression?.nodeType === 'MemberAccess'
  && (contractOf(n.expression.expression) !== '' || ADDRESS.test(type(n.expression.expression)))

const probe = (c: Contract): Suite['probes'][number] => ({ ...c.at, name: c.name, cites: CITES.exec(c.text)?.[1] ?? null,
  trackers: c.members.filter((m) => m.node.nodeType === 'VariableDeclaration' && m.node.constant !== true && contractOf(m.node) === '').map((m) => m.name),
  calls: c.members.flatMap((m) => calls(m.node).filter(external).map(m.bytes)) })

const profile = (toml: string, name: string, key: string): string | undefined => toml.split(/^(?=[ \t]*\[)/m)
  .find((s) => s.trimStart().startsWith(`[profile.${name}]`))?.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`, 'm'))?.[1]

function build(root: string): Suite['build'] {
  const { compilation: { platform, platformConfig: { target, args } = {} } = {} } = JSON.parse(read(join(root, 'medusa.json')) ?? '{}') as Medusa
  const toml = read(join(root, 'foundry.toml')) ?? ''
  const key = (k: string): string | null => profile(toml, 'fuzz', k) ?? profile(toml, 'default', k) ?? null
  return { command: platform === undefined || target === undefined || args === undefined ? null : [platform, target, ...args].join(' '), via_ir: key('via_ir'), optimizer: key('optimizer') }
}

export function suite(root: string): Suite {
  const found = harness(root)
  const standIns = found.filter((c) => STAND_IN.test(c.name))
  const probes = found.filter((c) => PROBE.test(c.name))
  const parts = found.filter((c) => !standIns.includes(c) && !probes.includes(c)).flatMap((c) => c.members)
  const functions = parts.filter((p) => p.node.nodeType === 'FunctionDefinition' && p.node.kind === 'function')
  const setups = functions.filter((f) => f.node.name === 'setup')
  const deployed = setups.flatMap(deploys)
  const live = new Set(deployed.map((d) => d.contract).filter((name) => !standIns.some((s) => s.name === name)))
  const vars = parts.filter((p) => p.node.nodeType === 'VariableDeclaration' && p.node.stateVariable === true)
  const actors = vars.filter((v) => ACTORS.has(type(v.node)))
  const writers = entries(functions)
  return {
    deployed,
    actors: actors.map((a) => ({ ...a.at(a.node), name: a.name, roles: setups.flatMap((s) => roles(s, a.node.name ?? '')) })),
    handlers: functions.filter(handler).map((h) => ({ ...h.at(h.node), name: h.name, clamped: h.name.endsWith(CLAMPED), target: aimed(h, functions, live), clamps: clamps(h) })),
    standIns: standIns.map(standIn),
    probes: probes.map(probe),
    trackers: vars.filter((v) => v.node.constant !== true && !actors.includes(v) && contractOf(v.node) === '').map((v) => ({ ...v.at(v.node), name: v.name, type: type(v.node),
      writers: writers.filter((e) => e.writes.some((w) => w.id === v.node.id)).map((e) => e.name) })),
    build: build(root),
  }
}

const listed = (map: string, section: string): string[] => (parsed(map).sections.get(section) ?? []).filter((r) => r !== NONE)

const named = (map: string, section: string): string[] => listed(map, section).map((r) => r.split(' | ')[0] ?? '')

const excused = (map: string, section: string): string[] => listed(map, section).map((r) => r.split(' | '))
  .filter(([, ...cells]) => cells.some((c) => { const m = FIELD.exec(c); return m?.[1] === 'reason' && filled(m[2]) })).map(([name = '']) => name)

const entered = (map: string): string[] => named(map, 'Selected entry points').map((row) => row.split('(')[0] ?? '')
  .filter((name) => !excused(map, 'Skipped entry points').includes(name))

const aims = (found: Suite, name: string, clamped: boolean): boolean => found.handlers.some((h) => h.target === name && h.clamped === clamped)

export function harnessed(found: Suite, map: string): Refused[] {
  const [unclamped, outside] = [excused(map, 'Unclamped'), named(map, 'Outside dependencies')]
  const cited = [...named(map, 'Limits'), ...outside]
  return [
    ...entered(map).flatMap((name) => [
      ...(aims(found, name, false) ? [] : [`scaffold: ${name} has no raw handler`]),
      ...(aims(found, name, true) || unclamped.includes(name) ? [] : [`scaffold: ${name} has no clamped handler and no ## Unclamped row`]),
    ]).map((note) => ({ rule: 'suite.clamped', note })),
    ...outside.filter((name) => !found.standIns.some((s) => s.replaces === name) && !found.deployed.some((d) => d.contract === name))
      .map((name) => ({ rule: 'suite.outside', note: `scaffold: ${name} under ## Outside dependencies has no stand-in and is not deployed in setup()` })),
    ...found.standIns.flatMap((s) => s.limits.filter((l) => l.map === null || !cited.includes(l.map))
      .map((l) => ({ rule: 'suite.stand_in', note: `scaffold: ${s.name} limit "${l.limit}" cites no ## Limits or ## Outside dependencies row` }))),
  ]
}

export function misaimed(found: Suite, map: string, lcov: string): Refused[] {
  const [signatures, hits] = [rows(map).get('Signatures') ?? [], covered(lcov)]
  return entered(map).filter((name) => !aims(found, name, false)).flatMap((name) => {
    const [, file = '', start = '', end = ''] = RANGE.exec(signatures.find((s) => s.name.startsWith(`${name}(`))?.cells.get('at') ?? '') ?? []
    return file !== '' && [...hits(file)].some(([line, n]) => line >= Number(start) && line <= Number(end) && n > 0)
      ? [{ rule: 'suite.misread', note: `scaffold: ${name} has no raw handler, yet lcov.info hits ${file} L${start}-L${end}` }] : []
  })
}

export function probed(found: Suite, map: string): Refused[] {
  const cited = found.probes.map((p) => p.cites)
  return [
    ...['Limits', 'Conversion points'].flatMap((section) => named(map, section).filter((row) => !cited.includes(row))
      .map((row) => ({ rule: 'suite.probe', note: `scaffold: ## ${section} ${row} has no probe` }))),
    ...found.probes.filter((p) => p.calls.length > 0)
      .map((p) => ({ rule: 'suite.probe_call', note: `scaffold: ${p.name} calls ${p.calls.join(', ')}; a probe makes no external call` })),
  ]
}

export function unsourced(found: Suite, map: string): string[] {
  const sources = [...listed(map, 'Limits'), ...listed(map, 'Outside dependencies')]
  const word = (text: string): RegExp => new RegExp(`(?<!\\w)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`)
  return found.handlers.flatMap((h) => h.clamps.filter((c) => !sources.some((s) => word(c.range).test(s))).map((c) => `${h.name}: ${c.text}`))
}
