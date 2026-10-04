import { join } from 'node:path'
import { expect, test } from 'vitest'
import { seat } from '../../../runner/rules.ts'
import { languageSeat } from '../../../runner/tests/language-seat.ts'

const root = join(import.meta.dirname, '../../..')

languageSeat({
  seat: 'web_specialist',
  language: 'web',
  commands: ['Bash(node --check:*)'],
  allowed: ['node --check public/app.js'],
  listed: 'public/app.js',
  beside: 'public/index.html',
})

test('D3 the six checks come before the answer fence', () => {
  const [rules] = seat(root, 'web_specialist').prompt.split(/^Answer the /m)
  for (const line of [
    '- No catch-all "other" or "no target" grouping; every item is named from labelled data.',
    '- An issue number is never small and grey.',
    '- Long text expands and is never cut off.',
    '- A job page opens with the ask or the decision.',
    '- Every chart value is labelled.',
    '- Costs are in tokens, broken down by type.',
  ]) expect(rules).toContain(`\n${line}\n`)
})
