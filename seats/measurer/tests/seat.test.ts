import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

test('D7: the manifest runs uv and writes only .cf/measure', () => {
  expect(seat(root, 'measurer').manifest).toEqual({
    seat: 'measurer', model: 'claude-opus-5-5', effort: 'medium', tools: ['Read', 'Grep', 'Glob', 'Bash(uv run:*)'], write_paths: ['.cf/measure'],
  })
})

test('D7: the prompt opens with its name and closes on a run fence', () => {
  const prompt = seat(root, 'measurer').prompt
  expect(prompt.startsWith('# measurer\n')).toBe(true)
  for (const part of ['## Citing', '## Quote', '- run:', 'command:', 'commit:', 'quote:', 'claim:', '# HEAD', '.cf/measure/']) expect(prompt).toContain(part)
})

test('D3: the prompt answers needs_build for network or writes', () => {
  const prompt = seat(root, 'measurer').prompt
  for (const part of ['## Needs a build', 'outcome: needs_build', 'network', 'outside `.cf/measure/`']) expect(prompt).toContain(part)
})

test('D7: the digests hold and measurer is a card row', () => {
  expect(check(root, '2026-10-20')).toEqual([])
  expect(rules(root).find((r) => r.id === 'measurer')).toMatchObject({ kind: 'card', path: 'rules/roster/measurer.yaml' })
})
