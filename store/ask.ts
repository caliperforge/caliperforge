/** The four-line block an ask_ceo carries, or the first reason it is not one. */
export function decision(text: string): { block: string } | { refused: string } {
  const line = (head: string): string | undefined => new RegExp(`^${head}.*$`, 'm').exec(text)?.[0].trim()
  const [decide, options, recommend, by] = ['Decide:', 'Options:', 'Recommend:', 'If no answer by .+?:'].map(line)
  const labels = [...new Set([...(options ?? '').matchAll(/\(([a-z])\)/g)].map((m) => m[0]))]
  if (decide === undefined) return { refused: 'no Decide line' }
  if (!decide.endsWith('?')) return { refused: 'the Decide line does not end in "?"' }
  if (labels.length < 2) return { refused: 'Options names fewer than two choices' }
  if (labels.length > 3) return { refused: 'Options names more than three choices' }
  if (!labels.some((l) => recommend?.includes(l))) return { refused: 'the Recommend line names no option' }
  if (by === undefined) return { refused: 'no If no answer by line' }
  return { block: [decide, options, recommend, by].join('\n') }
}
