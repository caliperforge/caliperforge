import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type At, type Extracted, lineCount } from './extract.ts'

export interface Refused { rule: string; note: string }

interface Parsed { fields: Map<string, string>; sections: Map<string, string[]> }

interface Cited { section: string; name: string; cells: Map<string, string>; at: At | string | undefined }

const FIELD = /^(\w+):\s*(.*)$/
const PLACEHOLDER = /<\w[^<>]*>/
const RANGE = /^(\S+) L(\d+)-L(\d+)$/
const READS = 'Reads'
const NONE = 'none'
const CONTEXT = 'context'

function parsed(text: string): Parsed {
  const lines = (part: string): string[] => part.split('\n').map((l) => l.trimEnd())
  const [, ...sections] = text.split(/^## /m)
  return {
    fields: new Map(lines(text).map((l) => FIELD.exec(l)).filter((m) => m !== null).map((m) => [m[1] ?? '', m[2] ?? ''])),
    sections: new Map(sections.map(lines).map(([name = '', ...rest]) => [name, rest.filter((l) => l.startsWith('- ')).map((l) => l.slice(2))])),
  }
}

function block(skill: string, phase: string): Parsed {
  const blocks = readFileSync(join(skill, 'phases/handoff/templates.md'), 'utf8').split(/^# Handoff: /m)
  const found = blocks.find((b) => b.startsWith(`${phase}\n`))
  if (found === undefined) throw new Error(`no handoff template for phase ${phase}`)
  return parsed(found)
}

const filled = (value: string | undefined): boolean => value !== undefined && value !== '' && !PLACEHOLDER.test(value)

function field(phase: string, key: string, want: string, got: string | undefined): string[] {
  if (got === undefined || got === '') return [`${phase}: ${key} is missing or empty`]
  if (PLACEHOLDER.test(want)) return filled(got) ? [] : [`${phase}: ${key} still holds ${got}`]
  return got === want ? [] : [`${phase}: ${key} is ${got}, not ${want}`]
}

function fields(phase: string, template: Parsed, given: Parsed): string[] {
  return [
    ...[...template.fields].flatMap(([key, want]) => field(phase, key, want, given.fields.get(key))),
    ...[...template.sections.keys()].filter((name) => name !== READS && !given.sections.get(name)?.length)
      .map((name) => `${phase}: ## ${name} is missing or has no row`),
  ]
}

function unfilled(given: Parsed, section: string, keys: string[]): string[] {
  return (given.sections.get(section) ?? []).filter((r) => r !== NONE).map((r) => r.split(' | '))
    .filter(([, ...pairs]) => !pairs.some((pair) => { const m = FIELD.exec(pair); return keys.includes(m?.[1] ?? '') && filled(m?.[2]) }))
    .map(([name = '']) => name)
}

const refuse = (rule: string, notes: string[]): Refused[] => notes.map((note) => ({ rule, note }))

export function handoff(skill: string, phase: string, text: string): Refused[] {
  const [template, given] = [block(skill, phase), parsed(text)]
  const unread = template.sections.has(READS) && (given.sections.get(READS) ?? []).every((r) => r === NONE)
  return [
    ...refuse('handoff.field', fields(phase, template, given)),
    ...refuse('handoff.reads', unread ? [`${phase}: ## ${READS} is missing, has no row or holds only - ${NONE}`] : []),
    ...refuse('handoff.converted', unfilled(given, 'Converted values', ['tolerance', 'delta'])
      .map((name) => `${phase}: ${name} under ## Converted values has no filled tolerance: or delta:`)),
    ...refuse('handoff.stand_in', unfilled(given, 'Stand-ins', ['limits']).map((name) => `${phase}: ${name} under ## Stand-ins has no filled limits:`)),
  ]
}

function span(root: string, cited: string, facts: Extracted): At | string {
  const [, file = '', start = '', end = ''] = RANGE.exec(cited) ?? []
  if (file === '') return 'not <file> L<start>-L<end>'
  const last = facts.sources[file] ?? (existsSync(join(root, file)) ? lineCount(readFileSync(join(root, file))) : undefined)
  if (last === undefined) return `a file not under ${root}`
  const [s, e] = [Number(start), Number(end)]
  return s < 1 || s > e || e > last ? `not a range inside its ${String(last)} lines` : { file, start: s, end: e }
}

function cites(root: string, given: Parsed, facts: Extracted): Cited[] {
  return [...given.sections].flatMap(([section, rows]) => rows.filter((r) => r !== NONE).map((r) => r.split(' | ')).flatMap(([name = '', ...pairs]) => {
    const cells = new Map(pairs.map((pair) => FIELD.exec(pair)).filter((m) => m !== null).map((m) => [m[1] ?? '', m[2] ?? '']))
    const at = cells.get('at')
    return [{ section, name, cells, at: at === undefined ? undefined : span(root, at, facts) }]
  }))
}

const HOLDS: Record<string, (facts: Extracted, name: string) => [At[], string]> = {
  Guards: (facts) => [facts.checks, 'no require, revert or custom error'],
  Limits: (facts) => [[...facts.state, ...facts.checks], 'no state declaration or check'],
  Aggregates: (facts, name) => {
    const state = facts.state.find((v) => v.name === name)
    return [state === undefined ? [] : [state, ...state.writes], `no declaration of or write to ${name}`]
  },
}

function uncited(facts: Extracted, { section, name, at }: Cited): string[] {
  const holds = HOLDS[section]
  if (typeof at !== 'object' || holds === undefined || !at.file.startsWith('src/')) return []
  const [held, none] = holds(facts, name)
  return held.some((f) => f.file === at.file && f.start >= at.start && f.start <= at.end) ? []
    : [`${CONTEXT}: ${name} under ## ${section} cites ${at.file} L${String(at.start)}-L${String(at.end)}, which hold ${none}`]
}

function moved(facts: Extracted, { section, name, cells }: Cited): string[] {
  const writers = facts.state.find((v) => v.name === name)?.writers
  if (section !== 'Aggregates' || writers === undefined) return []
  const named = (cells.get('movers') ?? '').split(',').map((m) => m.trim()).filter((m) => m !== '')
  const [missing, extra] = [writers.filter((w) => !named.includes(w)), named.filter((m) => !writers.includes(m))]
  return missing.length + extra.length === 0 ? []
    : [`${CONTEXT}: ${name} under ## Aggregates is missing movers ${missing.join(', ') || NONE} and has extra movers ${extra.join(', ') || NONE}`]
}

function untracked(given: Parsed, facts: Extracted): string[] {
  const named = (section: string): string[] => (given.sections.get(section) ?? []).map((r) => r.split(' | ')[0] ?? '')
  const reasoned = named('Not tracked').filter((name) => !unfilled(given, 'Not tracked', ['reason']).includes(name))
  const missing = (section: string, names: string[], what: string): string[] => names.filter((name) => ![...named(section), ...reasoned].includes(name))
    .map((name) => `${CONTEXT}: ${name} is ${what} in neither ## ${section} nor ## Not tracked with a reason`)
  return [...missing('Conversion points', facts.conversions.map((c) => c.name), 'a conversion point'), ...missing('Aggregates', facts.aggregates, 'an aggregate candidate')]
}

export function ranged(root: string, text: string, facts: Extracted): Refused[] {
  const given = parsed(text)
  const cited = cites(root, given, facts)
  return [
    ...refuse('handoff.range', cited.flatMap(({ section, name, cells, at }) => typeof at === 'string'
      ? [`${CONTEXT}: ${name} under ## ${section} cites ${cells.get('at') ?? ''}, ${at}`] : [])),
    ...refuse('handoff.cited', cited.flatMap((c) => uncited(facts, c))),
    ...refuse('handoff.movers', cited.flatMap((c) => moved(facts, c))),
    ...refuse('handoff.untracked', untracked(given, facts)),
  ]
}
