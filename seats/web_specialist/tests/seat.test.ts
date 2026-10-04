import { join } from 'node:path'
import { expect, test } from 'vitest'
import { gate } from '../../../providers/claude-agent-sdk/index.ts'
import { packet } from '../../../runner/index.ts'
import { seat } from '../../../runner/rules.ts'
import { languageSeat } from '../../../runner/tests/language-seat.ts'

const root = join(import.meta.dirname, '../../..')

languageSeat({
  seat: 'web_specialist',
  language: 'web',
  commands: ['Bash(node --check:*)', 'Bash(npm test:*)'],
  allowed: ['node --check public/app.js'],
  listed: 'public/app.js',
  beside: 'public/index.html',
})

test('D2 npm test passes the gate on our own repo', () => {
  const { manifest, prompt } = seat(root, 'web_specialist')
  const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'), true)
  expect(gate(p, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } } as never))
    .toEqual({ continue: true })
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
