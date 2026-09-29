import type { Refused } from './brief.ts'

const CALLED = /\b(?:word[- ]for[- ]word|byte[- ]for[- ]byte|verbatim)\b/i

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
