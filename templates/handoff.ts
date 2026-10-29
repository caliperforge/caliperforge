import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Refused { rule: string; note: string }

interface Parsed { fields: Map<string, string>; sections: Map<string, string[]> }

const FIELD = /^(\w+):\s*(.*)$/
const PLACEHOLDER = /<\w[^<>]*>/
const READS = 'Reads'
const NONE = 'none'

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
