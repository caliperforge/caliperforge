import { filled, type Refused } from './handoff.ts'
import { callee, listed, NONE, type Row, rows, shown } from './slices.ts'

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
      ...refuse('plan.tracker', planned.flatMap((r) => listed(r.cells.get('reads')).filter((name) => !suite.includes(name))
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

export function packets(plan: string, map: string, cut: string, guide: string, suite: string[]): Record<Implementer, string> {
  const [planned, mapped] = [planRows(plan), [...rows(map).values()].flat()]
  const trailing = [guide, `## Suite\n\n${suite.map((name) => `- ${name}\n`).join('')}`]
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
