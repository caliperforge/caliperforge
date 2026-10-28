import { section, type Refused } from './brief.ts'

const CALLED = /\b(?:word[- ]for[- ]word|byte[- ]for[- ]byte|verbatim)\b/i
const RULED = /^## (?:Ruling|Answer from the director)/
const FIELD = /^(?:applies to|instruction|files|resume at|verify): /

/** The first fenced block of the ask, fence lines included, that the ask's prose calls word for word and the brief does not carry unchanged. */
export function kept(brief: string, ask: string): Refused | null {
  const lines = ask.split('\n')
  const fences = lines.flatMap((l, i) => (l.startsWith('```') ? [i] : []))
  const blocks = fences.flatMap((open, k) => {
    const close = fences[k + 1]
    return k % 2 === 0 && close !== undefined ? [lines.slice(open, close + 1)] : []
  })
  const prose = blocks.reduce((rest, block) => rest.replace(block.join('\n'), ''), ask)
  if (!CALLED.test(prose)) return null
  const missing = blocks.find((block) => !brief.includes(block.join('\n')))
  return missing === undefined
    ? null
    : { span: missing[1] ?? '', reason: 'the ask calls this block word for word; copy it under ## Approach, fence lines included' }
}

/** The first ruling block of the ask that the brief's `## Rulings` does not carry unchanged. */
export function copied(brief: string, ask: string): Refused | null {
  const rulings = section(brief, '## Rulings')
  const missing = ask.split(/^(?=## )/m).filter((s) => RULED.test(s))
    .map((s) => s.split('\n').filter((l) => FIELD.test(l)))
    .find((block) => block.length > 0 && !rulings.includes(block.join('\n')))
  return missing === undefined
    ? null
    : { span: missing.find((l) => l.startsWith('instruction: ')) ?? missing[0] ?? '', reason: 'this ruling is not under ## Rulings word for word; copy each ruling block there unchanged' }
}
