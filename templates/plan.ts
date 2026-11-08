import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { scan } from '../rails/tight/braces.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { compiled } from './extract.ts'
import { filled, handoff, type Refused } from './handoff.ts'
import type { Fire, Phase, Sum } from './phases.ts'
import { callee, listed, NONE, type Row, rows, shown } from './slices.ts'

export const BATCHES = 'batches.json'

const FUZZ_TESTER = 'test/fizz/FuzzTester.sol'

type Implementer = 'global' | 'specific'

const IMPLEMENTERS: string[] = ['global', 'specific'] satisfies Implementer[]
const USED = ['Aggregates', 'Conversion points']

const planRows = (plan: string): Row[] => (rows(plan).get('Rows') ?? []).filter((r) => r.name !== NONE)

const refuse = (rule: string, notes: string[]): Refused[] => notes.map((note) => ({ rule, note }))

export function planned(plan: string, map: string, suite: string[], unreached: string[]): { refused: Refused[]; flagged: string[] } {
  const [planned, mapped] = [planRows(plan), rows(map)]
  const relied = new Set(planned.flatMap((r) => listed(r.cells.get('relies'))))
  const skipped = (rows(plan).get('Skipped') ?? []).filter((r) => filled(r.cells.get('reason'))).map((r) => r.name)
  const named = new Map([...mapped.values()].flat().map((r) => [r.id, r.name]))
  return {
    refused: [
      ...refuse('plan.unused', USED.flatMap((section) => (mapped.get(section) ?? [])
        .filter((r) => r.name !== NONE && !relied.has(r.id) && !skipped.includes(r.id))
        .map((r) => `plan: ${r.id} is in no row's relies: and in no ## Skipped row with a reason`))),
      ...refuse('plan.tracker', planned.flatMap((r) => listed(r.cells.get('reads')).filter((name) => !suite.some((s) => s === name || s.endsWith(`.${name}`)))
        .map((name) => `plan: ${r.name} reads ${name}, which the suite does not hold`))),
      ...refuse('plan.converted', planned.filter((r) => r.cells.get('converted') === 'yes' && !filled(r.cells.get('tolerance')) && !filled(r.cells.get('delta')))
        .map((r) => `plan: ${r.name} is converted with no filled tolerance: or delta:`)),
      ...refuse('plan.implementer', planned.filter((r) => !IMPLEMENTERS.includes(r.cells.get('implementer') ?? ''))
        .map((r) => `plan: ${r.name} has implementer ${r.cells.get('implementer') ?? NONE}, not global or specific`)),
    ],
    flagged: planned.filter((r) => listed(r.cells.get('relies')).some((id) => unreached.includes(callee(named.get(id) ?? '')))).map((r) => r.name),
  }
}

function packet(own: Row[], mapped: Row[], cut: string, trailing: string[]): string {
  const relied = new Set(own.flatMap((r) => listed(r.cells.get('relies'))))
  return [
    `## Rows\n\n${own.map((r) => `- ${r.text}\n`).join('')}`,
    ...mapped.filter((r) => relied.has(r.id)).map((r) => `### ${r.id}\n\n${shown(cut, r)}`),
    ...trailing,
  ].join('\n')
}

const roster = (suite: string[]): string => `## Suite\n\n${suite.map((name) => `- ${name}\n`).join('')}`

export function packets(plan: string, map: string, cut: string, guide: string, suite: string[]): Record<Implementer, string> {
  const [planned, mapped] = [planRows(plan), [...rows(map).values()].flat()]
  const trailing = [guide, roster(suite)]
  const own = (implementer: Implementer): string => packet(planned.filter((r) => r.cells.get('implementer') === implementer), mapped, cut, trailing)
  return { global: own('global'), specific: own('specific') }
}

export function batches(plan: string, map: string, cut: string, skeleton: string, helpers: string): string[] {
  const mapped = [...rows(map).values()].flat()
  const named = new Map(mapped.map((r) => [r.id, r.name]))
  const key = (r: Row): string => {
    const name = named.get(listed(r.cells.get('relies'))[0] ?? '')
    return name === undefined ? listed(r.cells.get('reads'))[0] ?? NONE : name.split('.')[0] ?? NONE
  }
  const packed: Row[][] = []
  for (const group of Map.groupBy(planRows(plan), key).values()) {
    const open = packed.at(-1)
    if (open !== undefined && open.length < 10 && open.length + group.length <= 15) open.push(...group)
    else packed.push(group)
  }
  return packed.map((own) => packet(own, mapped, cut, [skeleton, helpers]))
}

const read = (path: string): string => existsSync(path) ? readFileSync(path, 'utf8') : ''

export const skeleton = (root: string, suite: string[]): string =>
  `## Harness skeleton\n\n\`\`\`solidity\n${read(join(root, FUZZ_TESTER)).trimEnd()}\n\`\`\`\n\n${roster(suite)}`

const declared = (text: string): string[] => [...text.matchAll(/\bfunction\s+(\w+)/g)].map((m) => m[1] ?? '')

export function duplicated(global: string, specific: string): Refused[] {
  const theirs = declared(specific)
  return refuse('plan.duplicate', [...new Set(declared(global))].filter((name) => theirs.includes(name))
    .map((name) => `plan: function ${name} is declared by both implementers`))
}

export function collided(manifest: Record<string, string>): Refused[] {
  const owners = new Map<string, string[]>()
  for (const [path, source] of Object.entries(manifest)) for (const name of new Set(declared(source))) owners.set(name, [...owners.get(name) ?? [], path])
  return refuse('plan.duplicate', [...owners].filter(([, paths]) => paths.length > 1)
    .map(([name, paths]) => `plan: function ${name} is declared by ${paths.join(', ')}`))
}

export function unbatched(n: number, text: string): Refused[] {
  const name = `PropertiesBatch${String(n)}`
  return refuse('batch.syntax', [
    ...(text.trim() === '' ? [`batch ${String(n)}: ${name}.sol is empty`] : []),
    ...(scan(text).balanced ? [] : [`batch ${String(n)}: ${name}.sol has an unclosed brace or comment`]),
    ...(new RegExp(`\\bcontract\\s+${name}\\b`).test(text) ? [] : [`batch ${String(n)}: ${name}.sol declares no contract ${name}`]),
  ])
}

export function inherits(source: string, contracts: string[]): string | null {
  const tester = /\bcontract\s+FuzzTester\b([^{]*)\{/.exec(source)
  if (tester === null) return null
  const added = contracts.filter((c) => !source.includes(`import "./${c}.sol";`))
  if (added.length === 0) return source
  const lines = source.split('\n')
  const at = lines.findLastIndex((line) => /^\s*(?:import|pragma)\b/.test(line)) + 1
  const parents = tester[1]?.trim() ?? ''
  return [...lines.slice(0, at), ...added.map((c) => `import "./${c}.sol";`), ...lines.slice(at)].join('\n')
    .replace(tester[0], `contract FuzzTester ${parents === '' ? 'is' : `${parents},`} ${added.join(', ')} {`)
}

export const bulleted = (refused: Refused[]): string => refused.map((r) => `- ${r.rule}: ${r.note}`).join('\n')

interface Leg { fire: Fire; at: Phase; end: string }

const batchOf = (n: number): string => `test/fizz/PropertiesBatch${String(n)}.sol`

const spent = new WeakMap<Outcome, Sum>()

export function crashed(outcome: Outcome, sum: Sum): Outcome {
  spent.set(outcome, sum)
  return outcome
}

function spentBy(ran: Sum | Outcome): Sum {
  if (!('outcome' in ran)) return ran
  const sum = spent.get(ran)
  if (sum === undefined) throw new Error(`no session sum for ${ran.note}`)
  return sum
}

async function batch(leg: Leg, packets: string[], n: number, sum: Sum, again = false, refused: Refused[] = []): Promise<Sum | Outcome> {
  const { fire, at, end } = leg
  const [phase, last] = [`invariants-batch-${String(n)}`, n === packets.length]
  const ask = `Run Step 9d for batch ${String(n)} of ${String(packets.length)}: write only ${batchOf(n)} and reports/${phase}.md.`
  const issue = [at.issue.replace(end, last ? `${ask}\n${end}` : ask), `## Batch packet\n\n${packets[n - 1] ?? ''}`,
    ...(refused.length > 0 ? [`Your batch was refused:\n${bulleted(refused)}`] : [])].join('\n')
  const ran = await fire(at.prompt, issue, sum, phase)
  const crashed = 'outcome' in ran ? !ran.spans.includes('bench.ceiling') : ran.wall?.startsWith('ruling:run.repeat_read') === true
  if ('outcome' in ran || ran.wall !== null) return crashed && !again ? batch(leg, packets, n, spentBy(ran), true) : ran
  const handed = [...unbatched(n, read(join(at.root, batchOf(n)))), ...(last ? handoff(at.skill, 'invariants', read(at.path)) : [])]
  if (handed.length === 0) return ran
  if (!again) return batch(leg, packets, n, ran, true, handed)
  return { outcome: 'refuse', spans: [...new Set(handed.map((r) => r.rule))], note: `${phase} refused twice: ${handed.map((r) => r.note).join('; ')}` }
}

function merged(root: string, handoffs: string, count: number, sum: Sum): Sum | Outcome {
  const paths = [...Array(count).keys()].map((i) => batchOf(i + 1))
  writeFileSync(join(handoffs, 'manifest.json'), JSON.stringify(paths))
  const hits = collided(Object.fromEntries(paths.map((path) => [path, read(join(root, path))])))
  if (hits.length > 0) return { outcome: 'refuse', spans: ['plan.duplicate'], note: hits.map((r) => r.note).join('; ') }
  const tester = inherits(read(join(root, FUZZ_TESTER)), paths.map((path) => basename(path, '.sol')))
  if (tester === null) return { outcome: 'refuse', spans: ['batch.fuzz_tester'], note: `merge: ${FUZZ_TESTER} declares no contract FuzzTester` }
  writeFileSync(join(root, FUZZ_TESTER), tester)
  const [broken] = compiled(root, 'merge')
  return broken === undefined ? sum : { outcome: 'refuse', spans: [broken.rule], note: broken.note }
}

export async function implemented(leg: Leg, handoffs: string, sum: Sum, fresh?: string[]): Promise<Sum | Outcome> {
  const path = join(handoffs, BATCHES)
  if (fresh !== undefined) writeFileSync(path, JSON.stringify({ packets: fresh, done: [] }))
  const { packets, done } = JSON.parse(read(path)) as { packets: string[]; done: number[] }
  let ran = sum
  for (const n of [...packets.keys()].map((i) => i + 1).filter((n) => !done.includes(n))) {
    const got = await batch(leg, packets, n, ran)
    if ('outcome' in got || got.wall !== null) return got
    done.push(n)
    writeFileSync(path, JSON.stringify({ packets, done }))
    ran = got
  }
  return merged(leg.at.root, handoffs, packets.length, ran)
}
