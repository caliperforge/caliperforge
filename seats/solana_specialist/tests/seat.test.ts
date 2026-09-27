import { join } from 'node:path'
import { expect, test } from 'vitest'
import { askFor, cites } from '../../../cli/proposal.ts'
import { MERGED, OPEN, rows, world } from '../../../cli/tests/proposal-world.ts'
import { gate, offered } from '../../../providers/claude-agent-sdk/index.ts'
import { packet } from '../../../runner/index.ts'
import { Seat, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

const card = { seat: 'solana_specialist', model: 'claude-opus-5-5', effort: 'high', tools: ['Read', 'Glob', 'Grep'], write_paths: [] }

test('D1: the manifest holds Read, Glob and Grep, and no write path', () => {
  expect(seat(root, 'solana_specialist').manifest).toEqual(card)
})

test('D2: the roster carries the seat and the loader gives it a rules row', () => {
  expect(rules(root).find((r) => r.id === 'solana_specialist')).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('D3: the prompt names the four card lines, the Shape rule and the refusal to act', () => {
  const prompt = seat(root, 'solana_specialist').prompt.replace(/\s+/g, ' ')
  for (const part of ['**What:**', '**Why:**', '**When it ends:**', '**Shape:**']) expect(prompt).toContain(part)
  expect(prompt).toContain('The Shape line opens with a MERGED pull request url from `# Record`')
  expect(prompt).toContain('You never queue, approve or file a plan')
})

test('D4: a card whose Shape line opens with the MERGED url of the ask is cited, and one citing OPEN is refused', () => {
  const { db, ready } = world()
  const line = askFor(db, ready).split('\n').find((l) => l.includes('\tMERGED\t')) ?? ''
  const url = /https:\/\/\S+/.exec(line)?.[0] ?? ''
  const shaped = (cited: string) =>
    `**What:** fix the widget\n**Why:** the widget breaks\n**When it ends:** the widget test passes\n**Shape:** ${cited} in one file\n`
  expect(cites(shaped(url), rows(db))).toBe(MERGED)
  expect(() => cites(shaped(OPEN), rows(db))).toThrow('the card cites no merged pull request on record')
})

test('D5: the seat is offered no Bash and every command that would queue, file or approve is refused', () => {
  const { manifest, prompt } = seat(root, 'solana_specialist')
  const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'))
  expect(offered(p.tools)).not.toContain('Bash')
  for (const command of [
    'cf queue add acme/widget https://github.com/acme/widget/issues/1',
    'cf plan add --issue acme/widget#1',
    'cf approve target 1',
    'node cli/cf.ts approve target 1',
  ]) {
    expect(gate(p, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } as never)).toMatchObject({
      continue: true,
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: `ruling:seat.tools refuses the command ${JSON.stringify(command)}` },
    })
  }
})

test('D6: the manifest with Bash(node:*) or Write added does not load', () => {
  expect(Seat.safeParse({ ...card, tools: [...card.tools, 'Bash(node:*)'] }).success).toBe(false)
  expect(Seat.safeParse({ ...card, tools: [...card.tools, 'Write'] }).success).toBe(false)
})
