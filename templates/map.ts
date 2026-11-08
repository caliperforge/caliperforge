import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { At, Extracted } from './extract.ts'
import type { Suite } from './suite.ts'

interface Selection { name: string; functions: { name: string; inputs: { type: string; name: string }[]; tier: string }[] }

const MACHINE = ['Signatures', 'Selected entry points', 'Modifiers']

const SUITE = ['Deployed', 'Actors', 'Handlers', 'Stand-ins', 'Trackers', 'Build']

export const LAYERS: [string, string[]][] = [
  ['machine', MACHINE],
  ['context', ['Roles', 'Guards', 'Limits', 'Outside dependencies', 'Conversion points', 'Aggregates', 'Not tracked']],
  ['suite', SUITE],
  ['scaffold', ['Known holes', 'Skipped entry points', 'Unclamped']],
  ['reach', ['Reach']],
  ['coverage', ['Unreachable']],
]

export const RANGE = /^(\S+) L(\d+)-L(\d+)$/

const AT = /^at:\s*(.*)$/

export function ranges(text: string): At[] {
  return text.split('\n').filter((l) => l.startsWith('- ')).flatMap((row) => {
    const at = row.trimEnd().split(' | ').map((pair) => AT.exec(pair)?.[1]).find((a) => a !== undefined)
    const [, file = '', start = '', end = ''] = RANGE.exec(at ?? '') ?? []
    return file === '' ? [] : [{ file, start: Number(start), end: Number(end) }]
  })
}

const cited = ({ file, start, end }: At): string => `at: ${file} L${String(start)}-L${String(end)}`

export const sections = (text: string): [string, string][] =>
  text.split(/^(?=## )/m).filter((s) => s.startsWith('## ')).map((s) => [s.slice(3).split('\n')[0]?.trimEnd() ?? '', s])

export function laid(text: string, name: string, rows: string[]): string {
  const section = `## ${name}\n\n${rows.map((r) => `- ${r}\n`).join('') || '- none\n'}`
  const at = sections(text).find(([n]) => n === name)?.[1]
  return at === undefined ? `${text.trimEnd()}\n\n${section}` : text.replace(at, () => `${section}${at.slice(at.trimEnd().length + 1)}`)
}

export const idOf = (section: string, n: number): string => `${section.toLowerCase().replaceAll(' ', '-')}-${String(n)}`

export function selected(json: string): string[] {
  return (JSON.parse(json) as Selection[]).flatMap((c) => c.functions.map((f) =>
    `${c.name}.${f.name}(${f.inputs.map((i) => [i.type, i.name].filter((s) => s !== '').join(' ')).join(', ')}) | tier: ${f.tier}`))
}

export function drawn(facts: Extracted, selection: string, text: string): string {
  const rows: Record<string, string[]> = {
    Signatures: [...facts.signatures, ...facts.inherited].map((s) => `${s.signature} | ${cited(s)}`),
    'Selected entry points': selected(selection),
    Modifiers: facts.modifiers.map((m) => `${m.name} | ${cited(m)}`),
  }
  const machine = MACHINE.map((name) => `## ${name}\n\n${(rows[name] ?? []).map((r) => `- ${r}\n`).join('') || '- none\n'}`)
  const kept = sections(text).filter(([name]) => !MACHINE.includes(name)).map(([, s]) => `${s.trimEnd()}\n`)
  return [...machine, ...kept].join('\n')
}

export function suited(found: Suite, text: string): string {
  const rows: Record<string, string[]> = {
    Deployed: found.deployed.map((d) => `${d.contract} | args: ${d.args.join(', ') || 'none'} | ${cited(d)}`),
    Actors: found.actors.map((a) => `${a.name} | roles: ${a.roles.join(', ') || 'none'} | ${cited(a)}`),
    Handlers: found.handlers.map((h) => `${h.name} | target: ${h.targets[0] ?? 'none'} | clamps: ${h.clamps.map((c) => c.text).join('; ') || 'none'} | ${cited(h)}`),
    'Stand-ins': found.standIns.map((s) => `${s.name} | replaces: ${s.replaces} | limits: ${s.limits.map((l) => `${l.limit} (map: ${l.map ?? 'none'})`).join('; ')} | ${cited(s)}`),
    Trackers: found.trackers.map((t) => `${t.name} | type: ${t.type} | writers: ${t.writers.join(', ') || 'none'} | ${cited(t)}`),
    Build: Object.entries(found.build).map(([key, value]) => `${key} | value: ${value ?? 'none'}`),
  }
  const suite = SUITE.map((name) => `## ${name}\n\n${(rows[name] ?? []).map((r) => `- ${r}\n`).join('') || '- none\n'}`)
  const kept = sections(text).filter(([name]) => !SUITE.includes(name)).map(([, s]) => `${s.trimEnd()}\n`)
  return [...kept, ...suite].join('\n')
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
      writeFileSync(join(dir, `${idOf(name, i + 1)}.sol.txt`), source.subarray(starts[Number(start) - 1], starts[Number(end)]))
    }
  }
}
