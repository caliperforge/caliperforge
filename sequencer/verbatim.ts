import { section, type Refused } from './brief.ts'

const CALLED = /\b(?:word[- ]for[- ]word|byte[- ]for[- ]byte|verbatim)\b/i
const RULED = /^## (?:Ruling|Answer from the director)/
const FIELD = /^(?:applies to|instruction|files|resume at|verify): /

/** Each fenced block of the ask, fence lines included; none when the ask's prose does not call its blocks word for word. */
function fenced(ask: string): string[] {
  const lines = ask.split('\n')
  const fences = lines.flatMap((l, i) => (l.startsWith('```') ? [i] : []))
  const blocks = fences.flatMap((open, k) => {
    const close = fences[k + 1]
    return k % 2 === 0 && close !== undefined ? [lines.slice(open, close + 1).join('\n')] : []
  })
  const prose = blocks.reduce((rest, block) => rest.replace(block, ''), ask)
  return CALLED.test(prose) ? blocks : []
}

/** The field lines of each ruling section of the ask. */
function ruled(ask: string): string[] {
  return ask.split(/^(?=## )/m).filter((s) => RULED.test(s))
    .map((s) => s.split('\n').filter((l) => FIELD.test(l)).join('\n'))
    .filter((block) => block !== '')
}

/** The first fenced block of the ask, fence lines included, that the ask's prose calls word for word and the brief does not carry unchanged. */
export function kept(brief: string, ask: string): Refused | null {
  const missing = fenced(ask).find((block) => !brief.includes(block))
  return missing === undefined
    ? null
    : { span: missing.split('\n')[1] ?? '', reason: 'the ask calls this block word for word; copy it under ## Approach, fence lines included' }
}

/** The first ruling block of the ask that the brief's `## Rulings` does not carry unchanged. */
export function copied(brief: string, ask: string): Refused | null {
  const rulings = section(brief, '## Rulings')
  const missing = ruled(ask).find((block) => !rulings.includes(block))?.split('\n')
  return missing === undefined
    ? null
    : { span: missing.find((l) => l.startsWith('instruction: ')) ?? missing[0] ?? '', reason: 'this ruling is not under ## Rulings word for word; copy each ruling block there unchanged' }
}

/** The blocks {@link kept} and {@link copied} demand that the brief carries unchanged, each once. */
function copies(brief: string, ask: string): string[] {
  const rulings = section(brief, '## Rulings')
  return [...new Set([...fenced(ask).filter((block) => brief.includes(block)), ...ruled(ask).filter((block) => rulings.includes(block))])]
}

/** The brief's own lines: its length less each block it carries unchanged from the ask. */
export function counted(brief: string, ask: string): number {
  return copies(brief, ask).reduce((lines, block) => lines - block.split('\n').length, brief.trimEnd().split('\n').length)
}

export function caps(brief: string, ask: string, ceiling: number): Refused | null {
  const lines = counted(brief, ask)
  if (lines <= ceiling) return null
  const copy = brief.trimEnd().split('\n').length - lines
  return { span: `${String(ceiling)} lines`, reason: `the brief is ${String(lines)} lines${copy > 0 ? `, besides the ${String(copy)} it copies from the ask` : ''}` }
}
