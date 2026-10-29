import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { handoff } from '../../../templates/handoff.ts'

const skill = join(import.meta.dirname, '../skill')
const READ = '- x-ray/x-ray.md, Vault.deposit and Vault.redeem — the entry points to call'
const FILLED: Record<string, string> = {
  context: `phase: context\nnext: scaffold\nmode: automatic\nagent_model: opus\n\n## Reads\n\n${READ}\n`,
  scaffold: `phase: scaffold\nnext: coverage\n\n## Reads\n\n${READ}\n\n## Stand-ins\n\n- MockStrategy | limits: max interest 1e15 per call, only vault mints\n`,
  coverage: `phase: coverage\nnext: invariants\nfuzz_build_cmd: forge build\n\n## Reads\n\n${READ}\n`,
  invariants: `phase: invariants\nnext: campaigns\n\n## Reads\n\n${READ}\n\n## Converted values\n\n- property_redeemConserves | tolerance: 2 wei × 3\n`,
  campaigns: 'phase: campaigns\nnext: none\nfuzzer: medusa\n',
}

const changed = (phase: string, from: string, to: string): string => {
  const text = FILLED[phase] ?? ''
  expect(text).toContain(from)
  return text.replace(from, to)
}

test('D1: one block per phase in order, each filled one passes', () => {
  const blocks = readFileSync(join(skill, 'phases/handoff/templates.md'), 'utf8').match(/^# Handoff: .*$/gm)
  expect(blocks).toEqual(Object.keys(FILLED).map((phase) => `# Handoff: ${phase}`))
  for (const [phase, text] of Object.entries(FILLED)) expect(handoff(skill, phase, text)).toEqual([])
  expect(() => handoff(skill, 'deploy', '')).toThrow(/deploy/)
})

test.each([
  ['mode', 'mode: automatic\n', ''],
  ['agent_model', 'agent_model: opus', 'agent_model: <sonnet or opus>'],
  ['phase', 'phase: context', 'phase: scaffold'],
])('D2: a context %s left unfilled is handoff.field', (key, from, to) => {
  const refused = handoff(skill, 'context', changed('context', from, to))
  expect(refused).toEqual([{ rule: 'handoff.field', note: expect.stringContaining(`context: ${key} `) as string }])
})

test('D3: scaffold without ## Stand-ins is handoff.field', () => {
  const text = changed('scaffold', '## Stand-ins\n\n- MockStrategy | limits: max interest 1e15 per call, only vault mints\n', '')
  expect(handoff(skill, 'scaffold', text)).toEqual([{ rule: 'handoff.field', note: 'scaffold: ## Stand-ins is missing or has no row' }])
})

test.each(['', '- none'])('D4: coverage ## Reads holding %j is handoff.reads', (to) => {
  expect(handoff(skill, 'coverage', changed('coverage', READ, to))).toMatchObject([{ rule: 'handoff.reads', note: expect.stringContaining('## Reads') as string }])
})

test('D5: a converted value needs a tolerance or a delta', () => {
  const bare = changed('invariants', 'tolerance: 2 wei × 3', 'tolerance:')
  expect(handoff(skill, 'invariants', bare)).toEqual([{ rule: 'handoff.converted', note: expect.stringContaining('property_redeemConserves') as string }])
  expect(handoff(skill, 'invariants', changed('invariants', 'tolerance: 2 wei × 3', 'tolerance: | delta: asset.balanceOf(vault)'))).toEqual([])
})

test('D6: a stand-in needs its limits, - none passes', () => {
  const row = '- MockStrategy | limits: max interest 1e15 per call, only vault mints'
  expect(handoff(skill, 'scaffold', changed('scaffold', row, '- MockStrategy'))).toEqual([{ rule: 'handoff.stand_in', note: expect.stringContaining('MockStrategy') as string }])
  expect(handoff(skill, 'scaffold', changed('scaffold', row, '- none'))).toEqual([])
})

test('D7: campaigns passes without ## Reads', () => {
  expect(FILLED.campaigns).not.toContain('## Reads')
  expect(handoff(skill, 'campaigns', FILLED.campaigns ?? '')).toEqual([])
})
