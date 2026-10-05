import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parse } from 'yaml'
import type { Packet } from '../../providers/kind.ts'
import { seat } from '../../runner/rules.ts'
import { newestMode, runRows } from '../../store/events.ts'
import { at } from '../../templates/pr-path.ts'
import { fireLanded, ran } from '../seat.ts'
import { staffing } from '../staffing.ts'
import { checkout, put } from '../workspace.ts'
import { built, CARRIED, PASS, plan, stub, world } from './world.ts'

async function fired(step: number, language: string | null = null): Promise<{ prompt: string; mode: unknown; root: string }> {
  const w = world()
  const seen: Packet[] = []
  await ran(w.db, w.root, plan(w.db, 1), at(step, language), stub(CARRIED, 0, PASS, (p) => seen.push(p)), 'the ask', false)
  return { prompt: seen[0]?.prompt ?? '', mode: newestMode(w.db), root: w.root }
}

test.each(['swift', 'kotlin', 'python', 'ruby', 'rust', 'go', 'php', 'lua', 'typescript', 'outside'])(
  'D2 D4 a step-2 %s build carries build.md, mode build', async (language) => {
    const { prompt, mode, root } = await fired(2, language)
    const own = readFileSync(join(root, 'seats', `${language}_specialist`, 'prompt.md'), 'utf8')
    const build = readFileSync(join(root, 'seats/modes/build.md'), 'utf8')
    expect(seat(root, `${language}_specialist`).prompt).toBe(own)
    expect(prompt).toContain(`${own}\n${build}`)
    expect(prompt.indexOf(build)).toBeLessThan(prompt.indexOf('\n# Issue\n'))
    expect(mode).toBe('build')
  })

const REVIEWING = [...new Set(staffing(join(import.meta.dirname, '../..')).flatMap((r) => r.mode === 'review' ? [r.seat] : []))]

test.each(REVIEWING)('D1 D4 %s leaves build framing to build.md', (name) => {
  const own = readFileSync(join(import.meta.dirname, '../../seats', name, 'prompt.md'), 'utf8')
  expect(own).not.toContain('You build')
  expect(own).not.toContain('- id: D1')
})

test.each([{ step: 1, seat: 'brief_writer' }])(
  'D3 $seat at step $step carries no mode', async (c) => {
    const { prompt, mode, root } = await fired(c.step)
    expect(prompt).not.toContain(readFileSync(join(root, 'seats/modes/build.md'), 'utf8'))
    expect(mode).toBeNull()
  })

test('D3 a step carrying mode ship records ship', async () => {
  const w = world()
  writeFileSync(join(w.root, 'seats/modes/ship.md'), 'ship\n')
  await ran(w.db, w.root, plan(w.db, 1), { ...at(2), mode: 'ship' }, stub(CARRIED), 'the ask', false)
  expect(newestMode(w.db)).toBe('ship')
})

test.each(['swift', 'kotlin', 'typescript'])('D1 at(4, %s) is the builder in review mode', (language) => {
  expect(at(4, language)).toMatchObject({ seat: `${language}_specialist`, runs: 'code_quality', mode: 'review' })
  expect(at(2, language).mode).toBe('build')
  expect(at(5, language).mode).toBeUndefined()
  expect(at(4, 'lua').mode).toBeUndefined()
})

async function reviewed(language: string, origin: string | null = null):
  Promise<{ prompt: string; root: string; seat: string | undefined; mode: unknown }> {
  const w = world()
  checkout(w.root, 1, 'acme/widget', 'widget-12-a1')
  built(w.root, 1, 'export const two = 2')
  put(w.root, 1, 'issue.md', '# hello\n\n- D1 add `hello()` in `src/hello.ts`\n')
  const row = { ...plan(w.db, 1), origin }
  await ran(w.db, w.root, row, at(2, language), stub(CARRIED), 'the ask', false)
  writeFileSync(runRows(w.db).at(-1)?.transcript_path ?? '', 'TRANSCRIPT_MARKER\n')
  put(w.root, 1, 'step-2.handback.md', 'HANDBACK_MARKER\n')
  const seen: Packet[] = []
  await fireLanded(w.db, w.root, row, at(4, language), stub(CARRIED, 0, PASS, (p) => seen.push(p)))
  return { prompt: seen[0]?.prompt ?? '', root: w.root, seat: runRows(w.db).at(-1)?.seat, mode: newestMode(w.db) }
}

test.each(['swift', 'kotlin'])('D2 D3 outside %s step 4 fires its seat in review', async (language) => {
  const r = await reviewed(language)
  const own = readFileSync(join(r.root, 'seats', `${language}_specialist`, 'prompt.md'), 'utf8')
  const review = readFileSync(join(r.root, 'seats/modes/review.md'), 'utf8')
  expect(r).toMatchObject({ seat: `${language}_specialist`, mode: 'review' })
  expect(r.prompt).toContain(`${own}\n${review}`)
  expect(r.prompt).not.toContain(readFileSync(join(r.root, 'reviews/code_quality/spec.md'), 'utf8'))
  expect(r.prompt).not.toMatch(/TRANSCRIPT_MARKER|HANDBACK_MARKER/)
})

test('D4 an internal plan keeps code_quality at step 4', async () => {
  const r = await reviewed('swift', 'https://github.com/caliperforge/cf/issues/1')
  expect(r).toMatchObject({ seat: 'code_quality', mode: null })
})

test('D3 an outside typescript plan keeps code_quality at step 4', async () => {
  expect(await reviewed('typescript')).toMatchObject({ seat: 'code_quality', mode: null })
})

test('D5 each moded seat has its review-mode registry entry', () => {
  const entries = parse(readFileSync(join(import.meta.dirname, '../../rules/registry.yaml'), 'utf8')) as Record<string, unknown>[]
  for (const name of REVIEWING) {
    const where = `seat = '${name}' AND mode = 'review'`
    expect(entries.filter((e) => e.table === 'runs' && e.column === 'at' && e.where === where && e.gap === '7d')).toHaveLength(1)
  }
})
