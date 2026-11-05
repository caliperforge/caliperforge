import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Refused } from './handoff.ts'

export interface At { file: string; start: number; end: number }

type Check = 'require' | 'revert' | 'error' | 'modifier' | 'internal'

export interface Extracted {
  sources: Record<string, number>
  signatures: (At & { name: string; signature: string; modifiers: string[] })[]
  modifiers: (At & { name: string })[]
  checks: (At & { name: string; kind: Check })[]
  state: (At & { name: string; constant: boolean; writers: string[]; writes: At[] })[]
  conversions: (At & { name: string; divisions: number[] })[]
  aggregates: string[]
  inherited: Extracted['signatures']
}

export interface Node {
  nodeType: string; src: string; id: number; name?: string; memberName?: string; kind?: string; visibility?: string; operator?: string
  constant?: boolean; stateVariable?: boolean; implemented?: boolean; referencedDeclaration?: number; absolutePath?: string; nodes?: Node[]
  typeName?: Node; typeDescriptions?: { typeString?: string }
  modifiers?: (Node & { modifierName: { name: string; referencedDeclaration?: number } })[]
  parameters?: { parameters: Node[] }; returnParameters?: { parameters: Node[] }
  leftHandSide?: Node; subExpression?: Node; baseExpression?: Node; expression?: Node
  functionSelector?: string; storageLocation?: string; declarations?: (Node | null)[]; initialValue?: Node; linearizedBaseContracts?: number[]
}

export interface Member { node: Node; name: string; at: (node: Node) => At }

interface Write { id: number; additive: boolean; at: At }

interface Entry { name: string; writes: Write[] }

const STANDARD = new Set(['convertToShares', 'convertToAssets', 'previewDeposit', 'previewMint', 'previewWithdraw', 'previewRedeem'])
const WRITE = new Set(['++', '--', 'delete'])
const ADD = new Set(['+=', '-=', '++', '--'])
const CALLS = new Map<string, Check>([['require', 'require'], ['revert', 'revert']])
const AGGREGATE = /^(total|sum)/i
const REFERENCE = new Set(['Mapping', 'ArrayTypeName'])

export const CAP = 60 * 60 * 1000

export function compiled(root: string, phase = 'context'): Refused[] {
  const built = spawnSync('forge', ['build', '--ast'], { cwd: root, encoding: 'utf8', timeout: CAP })
  if (built.status === 0) return []
  return [{ rule: 'handoff.ast', note: `${phase}: forge build --ast failed: ${built.error?.message ?? built.stderr.split('\n')[0] ?? ''}` }]
}

const breaks = (source: Buffer): number[] => [...source.keys()].filter((i) => source[i] === 0x0a)

export const lineCount = (source: Buffer): number => breaks(source).length + (source.length === 0 || source.at(-1) === 0x0a ? 0 : 1)

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && 'nodeType' in value

export const below = (node: Node): Node[] =>
  Object.values(node).flatMap((value: unknown) => (Array.isArray(value) ? value as unknown[] : [value])).filter(isNode).flatMap((child) => [child, ...below(child)])

export const called = (node: Node): string => node.nodeType === 'FunctionCall' ? node.expression?.name ?? node.expression?.memberName ?? '' : ''

export function membersOf(file: string, source: Buffer, unit: Node): Member[] {
  const newlines = breaks(source)
  const line = (offset: number): number => newlines.filter((b) => b < offset).length + 1
  const at = (node: Node): At => {
    const [start = 0, length = 0] = node.src.split(':').map(Number)
    return { file, start: line(start), end: line(start + length - 1) }
  }
  return (unit.nodes ?? []).filter((c) => c.nodeType === 'ContractDefinition')
    .flatMap((c) => (c.nodes ?? []).map((node) => ({ node, name: `${c.name ?? ''}.${node.name === '' ? node.kind ?? '' : node.name ?? ''}`, at })))
}

function target(node: Node | undefined, aliases: Map<number, number>): number | undefined {
  if (node?.nodeType === 'Identifier') return aliases.get(node.referencedDeclaration ?? 0) ?? node.referencedDeclaration
  if (node?.nodeType === 'IndexAccess') return target(node.baseExpression, aliases)
  return node?.nodeType === 'MemberAccess' ? target(node.expression, aliases) : undefined
}

function aliasesOf(functions: Member[]): Map<number, number> {
  const aliases = new Map<number, number>()
  for (const n of functions.flatMap((f) => below(f.node)).filter((n) => n.nodeType === 'VariableDeclarationStatement')) {
    const [local, ...rest] = n.declarations ?? []
    const id = target(n.initialValue, aliases)
    if (local?.storageLocation === 'storage' && rest.length === 0 && id !== undefined) aliases.set(local.id, id)
  }
  return aliases
}

function written(node: Node): Node | undefined {
  if (node.nodeType === 'Assignment') return node.leftHandSide
  return node.nodeType === 'UnaryOperation' && WRITE.has(node.operator ?? '') ? node.subExpression : undefined
}

const writesOf = (f: Member, aliases: Map<number, number>): Write[] => below(f.node).flatMap((n) => {
  const id = target(written(n), aliases)
  return id === undefined ? [] : [{ id, additive: ADD.has(n.operator ?? ''), at: f.at(n) }]
})

function reached(id: number, calls: Map<number, number[]>, seen = new Set<number>()): Set<number> {
  if (seen.has(id)) return seen
  seen.add(id)
  for (const next of calls.get(id) ?? []) reached(next, calls, seen)
  return seen
}

function callees(functions: Member[], id: number, across: boolean): number[] {
  const callee = functions.find((f) => f.node.id === id)?.node
  if (callee === undefined) return []
  if (['internal', 'private'].includes(callee.visibility ?? '') || (across && callee.implemented === true)) return [id]
  const selector = callee.functionSelector
  return across && selector !== undefined ? functions.filter((f) => f.node.implemented === true && f.node.functionSelector === selector).map((f) => f.node.id) : []
}

export function entries(functions: Member[], aliases = new Map<number, number>(), across = false): Entry[] {
  const calls = new Map(functions.map((f) => [f.node.id, below(f.node).filter((n) => n.nodeType === 'FunctionCall')
    .flatMap((n) => callees(functions, n.expression?.referencedDeclaration ?? 0, across))]))
  const writes = new Map(functions.map((f) => [f.node.id, writesOf(f, aliases)]))
  return functions.filter((f) => ['public', 'external'].includes(f.node.visibility ?? '') && f.node.kind !== 'constructor')
    .map((f) => ({ name: f.name, writes: [...reached(f.node.id, calls)].flatMap((id) => writes.get(id) ?? []) }))
}

function aggregate(v: Member, writers: Entry[]): boolean {
  const { constant, typeName, typeDescriptions, name = '' } = v.node
  if (constant === true || REFERENCE.has(typeName?.nodeType ?? '') || /^(string|bytes|struct)\b/.test(typeDescriptions?.typeString ?? '')) return false
  return AGGREGATE.test(name) || writers.filter((e) => e.writes.some((w) => w.id === v.node.id && w.additive)).length >= 2
}

function kindOf(node: Node): Check | undefined {
  return node.nodeType === 'RevertStatement' ? 'error' : CALLS.get(called(node))
}

const checksOf = (m: Member): Extracted['checks'] => below(m.node).flatMap((n) => {
  const kind = kindOf(n)
  return kind === undefined ? [] : [{ ...m.at(n), name: m.name, kind }]
})

function guarded(bodies: Member[], functions: Member[]): Extracted['checks'] {
  const hops = (m: Member): [Node, number, Check][] => [
    ...(m.node.modifiers ?? []).map((n): [Node, number, Check] => [n, n.modifierName.referencedDeclaration ?? 0, 'modifier']),
    ...below(m.node).filter((n) => n.nodeType === 'FunctionCall')
      .flatMap((n) => callees(functions, n.expression?.referencedDeclaration ?? 0, false).map((id): [Node, number, Check] => [n, id, 'internal'])),
  ]
  const calls = new Map(bodies.map((m) => [m.node.id, hops(m).map(([, id]) => id)]))
  const direct = new Set(bodies.filter((m) => checksOf(m).length > 0).map((m) => m.node.id))
  return bodies.flatMap((m) => hops(m).filter(([, id]) => [...reached(id, calls)].some((r) => direct.has(r)))
    .map(([n, , kind]) => ({ ...m.at(n), name: m.name, kind })))
}

const conversionsOf = (f: Member): Extracted['conversions'] => {
  const inner = below(f.node)
  const divisions = inner.filter((n) => (n.nodeType === 'BinaryOperation' && n.operator === '/') || called(n).startsWith('mulDiv')).map((n) => f.at(n).start)
  const converts = STANDARD.has(f.node.name ?? '') || (inner.some((n) => STANDARD.has(called(n))) && divisions.length > 0)
  return f.node.implemented === true && converts ? [{ ...f.at(f.node), name: f.name, divisions }] : []
}

const typed = (list: { parameters: Node[] } | undefined): string =>
  (list?.parameters ?? []).map((p) => [p.typeDescriptions?.typeString ?? '', p.name ?? ''].filter((s) => s !== '').join(' ')).join(', ')

function signatureOf(f: Member): Extracted['signatures'][number] {
  const returns = typed(f.node.returnParameters)
  return { ...f.at(f.node), name: f.name, signature: `${f.name}(${typed(f.node.parameters)})${returns === '' ? '' : ` returns (${returns})`}`,
    modifiers: (f.node.modifiers ?? []).map((m) => m.modifierName.name) }
}

interface Owner { file: string; unit: Node; c: Node }

function inheritedOf(root: string, all: Map<string, Node>): Extracted['signatures'] {
  const owners = new Map([...all].flatMap(([file, unit]) => (unit.nodes ?? []).filter((c) => c.nodeType === 'ContractDefinition').map((c): [number, Owner] => [c.id, { file, unit, c }])))
  const read = new Map<string, Member[]>()
  const membersIn = (file: string, unit: Node): Member[] => read.get(file) ?? read.set(file, membersOf(file, readFileSync(join(root, file)), unit)).get(file) ?? []
  return [...owners.values()].filter(({ file }) => file.startsWith('src/')).flatMap(({ c }) => {
    const firsts = new Map<string, [Owner, Node]>()
    for (const base of (c.linearizedBaseContracts ?? []).flatMap((id) => owners.get(id) ?? [])) {
      for (const f of (base.c.nodes ?? []).filter((n) => n.implemented === true && n.functionSelector !== undefined)) {
        if (!firsts.has(f.functionSelector ?? '')) firsts.set(f.functionSelector ?? '', [base, f])
      }
    }
    return [...firsts.values()].filter(([base]) => base.c !== c).flatMap(([{ file, unit }, f]) => membersIn(file, unit).filter((m) => m.node.id === f.id)
      .map((m) => signatureOf({ ...m, name: `${c.name ?? ''}.${f.name ?? ''}` })))
  })
}

export function extract(root: string): Extracted {
  const all = new Map<string, Node>()
  for (const path of readdirSync(join(root, 'out'), { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.json'))) {
    const { ast } = JSON.parse(readFileSync(join(root, 'out', path), 'utf8')) as { ast?: Node }
    if (ast?.absolutePath !== undefined) all.set(ast.absolutePath, ast)
  }
  const units = new Map([...all].filter(([file]) => file.startsWith('src/')))
  const sources = [...units].map(([file, unit]) => ({ file, unit, source: readFileSync(join(root, file)) }))
  const members = sources.flatMap(({ file, unit, source }) => membersOf(file, source, unit))
  const of = (type: string): Member[] => members.filter((m) => m.node.nodeType === type)
  const [functions, modifiers] = [of('FunctionDefinition'), of('ModifierDefinition')]
  const bodies = [...functions, ...modifiers]
  const vars = of('VariableDeclaration').filter((m) => m.node.stateVariable === true)
  const aliases = aliasesOf(functions)
  const [writers, direct, writes] = [entries(functions, aliases, true), entries(functions, aliases), functions.flatMap((f) => writesOf(f, aliases))]
  return {
    sources: Object.fromEntries(sources.map(({ file, source }) => [file, lineCount(source)])),
    signatures: functions.map(signatureOf),
    modifiers: modifiers.map((m) => ({ ...m.at(m.node), name: m.name })),
    checks: [...bodies.flatMap(checksOf), ...guarded(bodies, functions)],
    state: vars.map((v) => ({ ...v.at(v.node), name: v.name, constant: v.node.constant === true,
      writers: writers.filter((e) => e.writes.some((w) => w.id === v.node.id)).map((e) => e.name), writes: writes.filter((w) => w.id === v.node.id).map((w) => w.at) })),
    conversions: functions.flatMap(conversionsOf),
    aggregates: vars.filter((v) => aggregate(v, direct)).map((v) => v.name),
    inherited: inheritedOf(root, all),
  }
}
