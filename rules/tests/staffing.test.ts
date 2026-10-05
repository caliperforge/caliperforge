import { appendFileSync, cpSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { staffed, staffing } from '../../sequencer/staffing.ts'
import { steps as comms } from '../../templates/comms.ts'
import { at, steps } from '../../templates/pr-path.ts'

const root = join(import.meta.dirname, '../..')

test('every pr_path step and key is staffed as at() picks it', () => {
  const keys = [...new Set(staffing(root).flatMap((r) => r.template === 'pr_path' && r.key !== undefined ? [r.key] : [])), null]
  for (const { step } of steps) for (const key of keys) {
    const { seat, mode } = at(step, key)
    expect(staffed(root, 'pr_path', step, key)).toEqual({ seat, mode })
  }
})

test('every comms step is staffed by its seat with no mode', () => {
  for (const s of comms) expect(staffed(root, 'comms', s.step, null)).toEqual({ seat: s.seat })
})

test('an unknown key is staffed by nobody', () => {
  expect(staffed(root, 'pr_path', 2, 'cobol')).toBeNull()
})

test('a seat with no seats/ folder is refused', () => {
  const tree = mkdtempSync(join(tmpdir(), 'cf-staffing-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(tree, dir), { recursive: true })
  appendFileSync(join(tree, 'rules/staffing.yaml'), '- { template: pr_path, step: 0, key: cobol, seat: nobody }\n')
  expect(() => staffing(tree)).toThrow(/no seats\/nobody folder/)
})

test('every staffed seat has its seats/ folder', () => {
  for (const { seat } of staffing(root)) expect(existsSync(join(root, 'seats', seat))).toBe(true)
})
