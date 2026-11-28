import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { admitted } from '../../../providers/kind.ts'
import { refuse } from '../../../runner/index.ts'
import { rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

test('D7: the manifest runs uv and writes only .cf/measure', () => {
  expect(seat(root, 'measurer').manifest).toEqual({
    seat: 'measurer', model: 'claude-opus-5-5', effort: 'medium',
    tools: ['Read', 'Grep', 'Glob', 'Write', 'Bash(uv run:*)', 'Bash(forge:*)', 'Bash(medusa:*)', 'Bash(node src/cli.ts:*)'], write_paths: ['.cf/measure'],
  })
})

test('runs fuzz-rig\'s CLI and no other node command', () => {
  const tools = seat(root, 'measurer').manifest.tools
  expect(admitted(tools, 'node src/cli.ts run --suite suite --workers 4')).toBe(true)
  for (const command of ['node scripts/x.ts', 'node src/cli.ts; rm x', 'node']) expect(admitted(tools, command)).toBe(false)
})

test('a clone folder fence admits only writes inside it', () => {
  const measure = mkdtempSync(join(tmpdir(), 'cf-measure-'))
  const clone = join(measure, 'plan-1')
  mkdirSync(clone)
  mkdirSync(join(measure, 'plan-2'))
  expect(refuse(clone, [clone], 'out/run.json')).toBeNull()
  expect(refuse(clone, [clone], '../plan-2/run.json')).toMatchObject({ origin_ref: 'seat.write_paths' })
})

test('D2: a write under .cf/measure is admitted', () => {
  const fence = seat(root, 'measurer').manifest.write_paths
  expect(refuse(root, fence, '.cf/measure/suite/test/euler-earn-m01/invariant_Vault.sol')).toBeNull()
})

test('D3: a write outside .cf/measure is refused', () => {
  const fence = seat(root, 'measurer').manifest.write_paths
  for (const path of ['src/EulerEarn.sol', '.cf/draft.md']) expect(refuse(root, fence, path)).toMatchObject({ origin_ref: 'seat.write_paths' })
})

test('D7: the prompt opens with its name and closes on a run fence', () => {
  const prompt = seat(root, 'measurer').prompt
  expect(prompt.startsWith('# measurer\n')).toBe(true)
  for (const part of ['## Citing', '## Quote', '- run:', 'command:', 'commit:', 'quote:', 'claim:', '# HEAD', '.cf/measure/']) expect(prompt).toContain(part)
})

test('D2: the prompt runs forge and medusa', () => {
  const prompt = seat(root, 'measurer').prompt
  for (const part of ['`uv run`', '`forge`', '`medusa`', '`node src/cli.ts`', 'fuzz-rig', '`~/cf_work/measure/<plan>/`']) expect(prompt).toContain(part)
})

test('D3: the prompt answers needs_build for network or writes', () => {
  const prompt = seat(root, 'measurer').prompt
  for (const part of ['## Needs a build', 'outcome: needs_build', 'network', 'outside `.cf/measure/`', '`# Output`', 'never a re-run']) expect(prompt).toContain(part)
})

test('the prompt names a Run command for a job past one call', () => {
  const prompt = seat(root, 'measurer').prompt
  for (const part of ['## Long job', '600 s', '**Run:**', '**Output:**', '`job.log`', '`# Long job`', '`cf bench medusa <checkout> --suite <dir> --workers <n> --out <path>`',
    '`compile_s`', '`fuzz_s`', 'after `compile_s:`']) {
    expect(prompt).toContain(part)
  }
})

test('D7: the digests hold and measurer is a card row', () => {
  expect(check(root, '2026-10-20')).toEqual([])
  expect(rules(root).find((r) => r.id === 'measurer')).toMatchObject({ kind: 'card', path: 'rules/roster/measurer.yaml' })
})
