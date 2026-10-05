import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { bare } from '../../../providers/kind.ts'
import { Seat, WRITERS, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const modeFile = (mode: string): string => readFileSync(join(root, 'seats/modes', `${mode}.md`), 'utf8')
const examples = (mode: string): string[] => modeFile(mode).split(/### Example \d\n/).slice(1)

test('D1: the manifest holds Read and no write tool or path', () => {
  const card = Seat.parse(seat(root, 'writer').manifest)
  expect(card).toEqual({ seat: 'writer', model: 'claude-opus-5-5', effort: 'medium', tools: ['Read'], write_paths: [] })
  expect(card.tools.filter((t) => WRITERS.has(bare(t)))).toEqual([])
})

test('D2: the roster carries the writer, loaded as a rules row', () => {
  expect(rules(root).find((r) => r.id === 'writer')).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('D6: the items fence, each status, no "Read nothing else"', () => {
  const prompt = seat(root, 'writer', 'log').prompt
  for (const part of ['items:', 'fixed', 'open', 'ruled', 'noted']) expect(prompt).toContain(part)
  expect(prompt).not.toContain('Read nothing else')
})

test('sources D6: the lead, tagless body and sources refs', () => {
  const prompt = seat(root, 'writer').prompt
  for (const part of ['comms.story_dir', '`learned`', '`learnings`', '`story`', 'no `[landed:N]`', '`landed:N`', '`refusal:N`']) expect(prompt).toContain(part)
})

test('D5: the citations, the fence and each kind of post', () => {
  const prompt = seat(root, 'writer', 'log').prompt
  for (const part of ['[landed:', '[refusal:', 'learnings:', 'dest:', 'dek:', 'sources:', 'checks:', 'daily', 'ship', 'weekly', 'substack', 'note']) expect(prompt).toContain(part)
})

test('weekly D5: script, 2–4 minutes, substack, sources', () => {
  const prompt = seat(root, 'writer', 'weekly').prompt
  for (const part of ['## Script', '2–4 minute', 'substack', 'never names an individual', 'Every number has a `sources` entry']) {
    expect(prompt).toContain(part)
  }
  expect(prompt).not.toContain('Read nothing else')
})

test('weekly D4: the CEO\'s voice and dest: substack', () => {
  const prompt = seat(root, 'writer', 'weekly').prompt
  for (const part of ['## Weekly', 'CEO\'s voice', 'dest: substack']) expect(prompt).toContain(part)
})

test.each(['log', 'ship', 'weekly'] as const)('modes D1–D3: %s joins the prompt with 2–3 examples', (mode) => {
  const prompt = seat(root, 'writer', mode).prompt
  expect(prompt).toBe(`${seat(root, 'writer').prompt}\n${modeFile(mode)}`)
  expect(modeFile(mode).split('\n')[0]).toBe(`# ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`)
  expect(examples(mode).length).toBeGreaterThanOrEqual(2)
  expect(examples(mode).length).toBeLessThanOrEqual(3)
})

test('modes D2: ship examples go to site and name no plan', () => {
  for (const example of examples('ship')) {
    expect(example).toContain('dest: site')
    expect(example.split('\n---\n')[0]).not.toMatch(/\d|\bplan\b|\bstep\b|refusal/i)
  }
})

test('modes D3: weekly examples are first person, for substack', () => {
  expect(modeFile('weekly')).toContain('comms/voice-notes.md')
  for (const example of examples('weekly')) for (const part of [/\bI\b/, /## Script/, /dest: substack/]) expect(example).toMatch(part)
})

test('modes D4: weekly keeps its refusal word for word', () => {
  expect(modeFile('weekly')).toContain('a weekly reply with any other dest, or no `## Script`, is refused.')
})

test('modes D5: the own prompt drops the moved sections', () => {
  const prompt = seat(root, 'writer').prompt
  for (const part of ['## Kinds of post', '## Daily', '## Weekly', 'items:']) expect(prompt).not.toContain(part)
  for (const part of ['# writer', '## Voice', '## Sources', '## Closing fence']) expect(prompt).toContain(part)
})
