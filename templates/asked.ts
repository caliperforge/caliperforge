const LINES = [['question', '**Question:**', '**What:**'], ['wrong_if', '**Would be wrong if:**', null], ['done_when', '**Done when:**', '**When it ends:**']] as const

const RULED = /^## (?:Ruling|Answer from the director)/

const PART_WRONG = 'it leaves out what this part asks, or answers what its parent ticket asks'

export const said = (ask: string) => {
  const lines = ask.split('\n')
  const parent = lines.findIndex((l) => l === '## Parent ticket' || l === '## Parent comments')
  const own = parent === -1 ? lines : lines.slice(0, parent)
  const ruled = lines.findLastIndex((l) => RULED.test(l))
  const after = ruled === -1 ? [] : lines.slice(ruled + 1)
  const end = after.findIndex((l) => l.startsWith('## '))
  const block = end === -1 ? after : after.slice(0, end)
  const line = (label: string, from = own): string => from.find((l) => l.startsWith(label))?.slice(label.length).trim() ?? ''
  return LINES.map(([key, label, field]) => {
    if (line(label, block) !== '') return [key, label, line(label, block), lines[ruled]?.slice(3) ?? null] as const
    const from = line(label) !== '' || parent === -1 ? null : field ?? 'the fixed part sentence'
    return [key, label, from === null ? line(label) : field === null ? PART_WRONG : line(field), from] as const
  })
}

export const unasked = (ask: string): string[] => said(ask).filter(([, , rest]) => rest === '').map(([, label]) => label)
