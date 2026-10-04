import { join } from 'node:path'
import { expect, test } from 'vitest'
import { bare } from '../../../providers/kind.ts'
import { Seat, WRITERS, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

test('D1: the manifest holds Read and no write tool or path', () => {
  const card = Seat.parse(seat(root, 'writer').manifest)
  expect(card).toEqual({ seat: 'writer', model: 'claude-opus-5-5', effort: 'medium', tools: ['Read'], write_paths: [] })
  expect(card.tools.filter((t) => WRITERS.has(bare(t)))).toEqual([])
})

test('D2: the roster carries the writer, loaded as a rules row', () => {
  expect(rules(root).find((r) => r.id === 'writer')).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('D6: the items fence, each status, no "Read nothing else"', () => {
  const prompt = seat(root, 'writer').prompt
  for (const part of ['items:', 'fixed', 'open', 'ruled', 'noted']) expect(prompt).toContain(part)
  expect(prompt).not.toContain('Read nothing else')
})

test('sources D6: the lead, tagless body and sources refs', () => {
  const prompt = seat(root, 'writer').prompt
  for (const part of ['comms.story_dir', '`learned`', '`learnings`', '`story`', 'no `[landed:N]`', '`landed:N`', '`refusal:N`']) expect(prompt).toContain(part)
})

test('D5: the citations, the fence and each kind of post', () => {
  const prompt = seat(root, 'writer').prompt
  for (const part of ['[landed:', '[refusal:', 'learnings:', 'dest:', 'dek:', 'sources:', 'checks:', 'daily', 'ship', 'weekly', 'substack', 'note']) expect(prompt).toContain(part)
})

test('weekly D5: script, 2–4 minutes, substack, sources', () => {
  const prompt = seat(root, 'writer').prompt
  for (const part of ['## Script', '2–4 minute', 'substack', 'never names an individual', 'Every number has a `sources` entry']) {
    expect(prompt).toContain(part)
  }
  expect(prompt).not.toContain('Read nothing else')
})
