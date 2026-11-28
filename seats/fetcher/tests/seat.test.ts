import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { gate } from '../../../providers/claude-agent-sdk/index.ts'
import { packet } from '../../../runner/index.ts'
import { seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

test('D4: the manifest runs node and writes under ~/cf_work', () => {
  expect(seat(root, 'fetcher').manifest).toEqual({
    seat: 'fetcher', model: 'claude-opus-5-5', effort: 'medium',
    tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Write', 'Edit', 'Bash(node:*)', 'Bash(gh api:*)', 'Bash(gh workflow run:*)'], write_paths: ['~/cf_work'],
  })
})

test('the gate admits a gh api GET and refuses gh writes', () => {
  const { manifest, prompt } = seat(root, 'fetcher')
  const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'), true)
  const ran = (command: string) =>
    gate(p, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } as never)
  for (const command of ['gh api repos/o/r/issues/1', "gh api 'search/issues?q=x'"]) expect(ran(command)).toEqual({ continue: true })
  for (const command of ['gh api -X POST repos/o/r/issues', 'gh issue create', 'gh api search/issues?q=x']) {
    expect(ran(command)).toMatchObject({ continue: true, hookSpecificOutput: { permissionDecision: 'deny' } })
  }
})

test('D4: the prompt opens with its name and closes on a run fence', () => {
  const prompt = seat(root, 'fetcher').prompt
  expect(prompt.startsWith('# fetcher\n')).toBe(true)
  for (const part of ['# Output', 'node', '- run:', 'commit:', '# HEAD', 'WebSearch', 'WebFetch', "gh api 'search/issues?q=", '- url:']) expect(prompt).toContain(part)
})

test('the prompt hands back a long job as Run and Output lines', () => {
  const prompt = seat(root, 'fetcher').prompt
  for (const part of ['## Long job', '600 s', '**Run:**', '**Output:**', '`job.log`', '`# Long job`']) expect(prompt).toContain(part)
})

test('D4: the digests hold', () => {
  expect(check(root, '2026-10-21')).toEqual([])
})
