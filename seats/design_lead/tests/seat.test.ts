import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { refuse } from '../../../runner/index.ts'
import { Seat, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const TODAY = '2026-10-11'

test('D1: the manifest writes DESIGN.md and design/tickets', () => {
  expect(seat(root, 'design_lead').manifest).toEqual({
    seat: 'design_lead', model: 'claude-opus-5-5', effort: 'high', tools: ['Read', 'Write', 'Glob', 'Grep'], write_paths: ['DESIGN.md', 'design/tickets'],
  })
})

test('D2: write_paths admit DESIGN.md and tickets, refuse the rest', () => {
  const paths = seat(root, 'design_lead').manifest.write_paths
  for (const path of ['DESIGN.md', 'design/tickets/wave-1-nav.md']) expect(refuse(root, paths, path)).toBeNull()
  for (const path of ['src/app.tsx', 'DESIGN.md.bak', '../DESIGN.md']) expect(refuse(root, paths, path)).toMatchObject({ origin_ref: 'seat.write_paths' })
})

test('D3: the prompt names the system, the canvas and the waves', () => {
  const prompt = seat(root, 'design_lead').prompt
  expect(prompt.startsWith('# design_lead\n')).toBe(true)
  for (const part of [
    'palette', 'type scale', 'spacing', 'component set', 'page inventory', 'a job, a status, a number, a person, a time',
    'claude.ai/artifact/KK7jFr3pvgjySqMd4STJ5p', 'waves', 'names the `DESIGN.md` section it implements',
  ]) expect(prompt).toContain(part)
})

test('D4: the digests hold and design_lead is a card row', () => {
  expect(rules(root).find((r) => r.id === 'design_lead')).toMatchObject({ kind: 'card', path: 'rules/roster/design_lead.yaml' })
  expect(check(root, TODAY)).toEqual([])
})

test('D5: an emptied roster file is stale', () => {
  const tree = mkdtempSync(join(tmpdir(), 'cf-design-lead-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(tree, dir), { recursive: true })
  cpSync(join(root, 'rules.seed.sql'), join(tree, 'rules.seed.sql'))
  writeFileSync(join(tree, 'rules/roster/design_lead.yaml'), '')
  expect(check(tree, TODAY).map((s) => s.path)).toContain('rules/roster/design_lead.yaml')
})

test('D5: the card with no write_paths fails', () => {
  expect(() => Seat.parse({ ...seat(root, 'design_lead').manifest, write_paths: [] })).toThrow()
})
