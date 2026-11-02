import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIELD, parsed } from './handoff.ts'
import { idOf, LAYERS } from './map.ts'

export interface Row { id: string; name: string; text: string; cells: Map<string, string> }

type Rows = Map<string, Row[]>

export const NONE = 'none'

export const listed = (cell: string | undefined): string[] => (cell ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')

export const callee = (name: string): string => name.split('(')[0] ?? ''

export function rows(text: string): Rows {
  return new Map([...parsed(text).sections].map(([section, lines]) => [section, lines.map((text, i) => {
    const [name = '', ...pairs] = text.split(' | ')
    const cells = new Map(pairs.map((pair) => FIELD.exec(pair)).filter((m) => m !== null).map((m) => [m[1] ?? '', m[2] ?? '']))
    return { id: idOf(section, i + 1), name, text, cells }
  })]))
}

export function shown(cut: string, row: Row): string {
  const file = join(cut, `${row.id}.sol.txt`)
  return `- ${row.text}\n${existsSync(file) ? `\`\`\`solidity\n${readFileSync(file, 'utf8').trimEnd()}\n\`\`\`\n` : ''}`
}

const of = (...names: string[]) => (map: Rows): [string, Row[]][] => names.map((name) => [name, map.get(name) ?? []])

export const SLICES: Record<string, (map: Rows) => [string, Row[]][]> = {
  'conservation-auditor': (map) => {
    const movers = (map.get('Aggregates') ?? []).flatMap((r) => listed(r.cells.get('movers')))
    return [...of('Aggregates')(map), ['Signatures', (map.get('Signatures') ?? []).filter((r) => movers.includes(callee(r.name)))]]
  },
  'roundtrip-rounding-analyst': of('Conversion points'),
  'state-transition-mapper': of('Guards', 'Roles', 'Limits'),
  'protocol-type-specialist': of('Signatures', 'Selected entry points'),
  'adversarial-profit-maximizer': of(...LAYERS.flatMap(([, names]) => names)),
}

export function slices(map: string, cut: string, layers: string, dir: string): void {
  const mapped = rows(map)
  const index = [...mapped.values()].flat().filter((r) => r.name !== NONE).map((r) => `- ${r.id} ${r.name}\n`).join('')
  mkdirSync(dir, { recursive: true })
  for (const [agent, slice] of Object.entries(SLICES)) {
    const parts = slice(mapped).map(([name, kept]) => `## ${name}\n\n${kept.map((r) => shown(cut, r)).join('')}`)
    writeFileSync(join(dir, `${agent}.md`), [`## Index\n\n${index}`, ...parts, layers].join('\n'))
  }
}
