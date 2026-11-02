import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { At, Extracted } from './extract.ts'

interface Selection { name: string; functions: { name: string; inputs: { type: string; name: string }[]; tier: string }[] }

const MACHINE = ['Signatures', 'Selected entry points', 'Modifiers']

export const LAYERS: [string, string[]][] = [
  ['machine', MACHINE],
  ['context', ['Roles', 'Guards', 'Limits', 'Outside dependencies', 'Conversion points', 'Aggregates', 'Not tracked']],
]

export const RANGE = /^(\S+) L(\d+)-L(\d+)$/

const AT = /^at:\s*(.*)$/

const cited = ({ file, start, end }: At): string => `at: ${file} L${String(start)}-L${String(end)}`

const sections = (text: string): [string, string][] =>
  text.split(/^(?=## )/m).filter((s) => s.startsWith('## ')).map((s) => [s.slice(3).split('\n')[0]?.trimEnd() ?? '', s])

export function selected(json: string): string[] {
  return (JSON.parse(json) as Selection[]).flatMap((c) => c.functions.map((f) =>
    `${c.name}.${f.name}(${f.inputs.map((i) => [i.type, i.name].filter((s) => s !== '').join(' ')).join(', ')}) | tier: ${f.tier}`))
}

export function drawn(facts: Extracted, selection: string, text: string): string {
  const rows: Record<string, string[]> = {
    Signatures: facts.signatures.map((s) => `${s.signature} | ${cited(s)}`),
    'Selected entry points': selected(selection),
    Modifiers: facts.modifiers.map((m) => `${m.name} | ${cited(m)}`),
  }
  const machine = MACHINE.map((name) => `## ${name}\n\n${(rows[name] ?? []).map((r) => `- ${r}\n`).join('') || '- none\n'}`)
  const kept = sections(text).filter(([name]) => !MACHINE.includes(name)).map(([, s]) => `${s.trimEnd()}\n`)
  return [...machine, ...kept].join('\n')
}

export function excerpts(root: string, text: string, dir: string): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const [name, section] of sections(text)) {
    const rows = section.split('\n').filter((l) => l.startsWith('- '))
    for (const [i, row] of rows.entries()) {
      const at = row.trimEnd().split(' | ').map((pair) => AT.exec(pair)?.[1]).find((a) => a !== undefined)
      const [, file = '', start = '', end = ''] = RANGE.exec(at ?? '') ?? []
      if (file === '') continue
      const source = readFileSync(join(root, file))
      const starts = [0, ...[...source.keys()].filter((b) => source[b] === 0x0a).map((b) => b + 1)]
      writeFileSync(join(dir, `${name.toLowerCase().replaceAll(' ', '-')}-${String(i + 1)}.sol.txt`), source.subarray(starts[Number(start) - 1], starts[Number(end)]))
    }
  }
}
