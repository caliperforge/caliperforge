import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { seat } from '../../runner/rules.ts'
import { newestMode } from '../../store/events.ts'
import { at } from '../../templates/pr-path.ts'
import { ran } from '../seat.ts'
import { CARRIED, PASS, plan, stub, world } from './world.ts'

async function fired(step: number, language: string | null = null): Promise<{ prompt: string; mode: unknown; root: string }> {
  const w = world()
  const seen: Packet[] = []
  await ran(w.db, w.root, plan(w.db, 1), at(step, language), stub(CARRIED, 0, PASS, (p) => seen.push(p)), 'the ask', false)
  return { prompt: seen[0]?.prompt ?? '', mode: newestMode(w.db), root: w.root }
}

test.each(['swift', 'kotlin', 'python', 'ruby', 'rust', 'go', 'php'])('D2 D3 a step-2 %s build carries build.md, mode build', async (language) => {
  const { prompt, mode, root } = await fired(2, language)
  const own = readFileSync(join(root, 'seats', `${language}_specialist`, 'prompt.md'), 'utf8')
  const build = readFileSync(join(root, 'seats/modes/build.md'), 'utf8')
  expect(seat(root, `${language}_specialist`).prompt).toBe(own)
  expect(prompt).toContain(`${own}\n${build}`)
  expect(prompt.indexOf(build)).toBeLessThan(prompt.indexOf('\n# Issue\n'))
  expect(mode).toBe('build')
})

test.each([{ step: 2, seat: 'typescript_specialist' }, { step: 1, seat: 'brief_writer' }])(
  'D4 $seat at step $step carries no mode', async (c) => {
    const { prompt, mode, root } = await fired(c.step)
    expect(prompt).not.toContain(readFileSync(join(root, 'seats/modes/build.md'), 'utf8'))
    expect(mode).toBeNull()
  })
