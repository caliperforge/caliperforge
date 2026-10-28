import { expect, test } from 'vitest'
import { answers } from '../answers.ts'

const FENCE = '---\ndone:\n  - id: D1\n    status: done\n    pointer: src/hello.ts:1\n---\n'
const handback = (above: string, after = ''): string => `built\n\n${above}\n\n${FENCE}${after}`

test('D4 every open id answered passes', () => {
  const v = answers(handback('## Findings answered\n\n- F1 fixed: takes a name\n- F2 disputed: the test pins it'), ['F1', 'F2'])
  expect(v).toMatchObject({ outcome: 'pass', spans: [], message: '2 finding(s) answered' })
})

test.each([
  { name: 'a missing id', text: handback('## Findings answered\n\n- F2 fixed: takes a name') },
  { name: 'a row outside the section', text: handback('- F1 fixed: takes a name\n\n## Findings answered\n\n- F2 fixed: x') },
  { name: 'a row after the fence', text: handback('## Findings answered\n\n- F2 fixed: x', '- F1 fixed: takes a name\n') },
  { name: 'a word other than fixed or disputed', text: handback('## Findings answered\n\n- F1 maybe: takes a name\n- F2 fixed: x') },
])('D5 $name refuses naming F1', ({ text }) => {
  expect(answers(text, ['F1', 'F2'])).toMatchObject({
    outcome: 'refuse', origin_kind: 'rail', origin_ref: 'completion-audit', spans: ['F1'],
    message: 'F1 open from the last review refuse, with no fixed: or disputed: row under ## Findings answered',
  })
})
