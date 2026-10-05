import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, test } from 'vitest'
import { load } from '../../runner/rules.ts'
import { runRows } from '../../store/events.ts'
import { verdictRows, type Verdict } from '../../store/verdict.ts'
import { at } from '../../templates/pr-path.ts'
import { design, screens } from '../design.ts'
import type { Outcome } from '../kind.ts'
import { fireLanded } from '../seat.ts'
import { planDir, put, srcDir } from '../workspace.ts'
import { CARRIED, plan, stub, world, type World } from './world.ts'

// headless launches chromium-headless-shell, whose path executablePath() does not report
const missing = await chromium.launch({ headless: true }).then(
  async (browser) => { await browser.close(); return null },
  (e: unknown) => `no Chromium: ${String(e).split('\n')[0] ?? ''}`,
)

const page = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`

const run = async (body: string): Promise<{ verdict: Verdict; out: string }> => {
  const src = mkdtempSync(join(tmpdir(), 'design-src-'))
  const out = mkdtempSync(join(tmpdir(), 'design-out-'))
  writeFileSync(join(src, 'index.html'), page(body))
  return { verdict: await design(src, out, ['index.html']), out }
}

const browsed = (name: string, fn: () => Promise<void>): void => {
  test(name, { timeout: 60_000 }, async ({ skip }) => {
    if (missing !== null) skip(missing)
    await fn()
  })
}

browsed('D1 a 1200 px table at 400 px refuses with overflow', async () => {
  const { verdict } = await run('<table style="width:1200px"><tr><td>wide</td></tr></table>')
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toContain('index.html design.overflow 400 light')
})

browsed('D2 "Other" as a group label refuses with catchall', async () => {
  const { verdict } = await run('<fieldset><legend>Other</legend></fieldset>')
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toContain('index.html design.catchall 1440 light Other')
})

browsed('D3 a clean page passes and leaves four screenshots', async () => {
  const { verdict, out } = await run('<h1>Plans</h1>')
  expect(verdict).toMatchObject({ outcome: 'pass', spans: [] })
  expect(readdirSync(join(out, 'design'))).toHaveLength(4)
})

browsed('D4 console.error and clipped text refuse', async () => {
  const logged = await run('<script>console.error("boom")</script>')
  expect(logged.verdict.spans).toContain('index.html design.console 1440 dark boom')
  const cut = await run('<p style="width:80px;overflow:hidden;white-space:nowrap">a label far too long to fit</p>')
  expect(cut.verdict.spans).toContain('index.html design.clipped 400 light a label far too long to fit')
})

const file = (from: string, to: string): string => [`--- ${from}`, `+++ ${to}`, '@@ -1 +1 @@', '-a', '+b'].join('\n')

test('D5 screens skips deleted html; css alone means index.html', () => {
  expect(screens([file('a/old.html', '/dev/null'), file('a/app/plans.html', 'b/app/plans.html')].join('\n'))).toEqual(['app/plans.html'])
  expect(screens(file('a/style.css', 'b/style.css'))).toEqual(['index.html'])
})

const stepped = async (name: string, body: string, language: string): Promise<{ w: World; outcome: Outcome; seats: string[] }> => {
  const w = world()
  load(w.db, w.root)
  writeFileSync(join(srcDir(w.root, 1), name), body)
  put(w.root, 1, 'issue.md', '# a screen\n\n- D1 add a screen\n')
  const row = { ...plan(w.db, 1), origin: 'https://github.com/caliperforge/atelier-web/issues/1' }
  const outcome = await fireLanded(w.db, w.root, row, at(4, language), stub(CARRIED))
  return { w, outcome, seats: runRows(w.db).map((r) => r.seat) }
}

test('D1 at(4, web) alone is marked for design', () => {
  expect(at(4, 'web')).toMatchObject({ seat: 'web_specialist', runs: 'code_quality', design: true })
  for (const language of [null, 'typescript', 'swift', 'kotlin', 'outside']) expect(at(4, language).design).toBeUndefined()
  for (const step of [0, 1, 2, 3, 5, 6, 7, 8]) expect(at(step, 'web').design).toBeUndefined()
})

browsed('D2 web step 4 leaves screenshots, a design run and verdict', async () => {
  const { w, outcome, seats } = await stepped('index.html', page('<h1>Plans</h1>'), 'web')
  expect(outcome).toMatchObject({ outcome: 'pass', note: 'design pass' })
  expect(readdirSync(join(planDir(w.root, 1), 'design'))).toHaveLength(4)
  expect(seats).toContain('design')
  expect(verdictRows(w.db, 1).filter((v) => v.step === 4 && v.kind === 'review')).toHaveLength(2)
})

browsed('D3 an Other label refuses though the design review passes', async () => {
  const { outcome } = await stepped('index.html', page('<fieldset><legend>Other</legend></fieldset>'), 'web')
  expect(outcome).toMatchObject({ outcome: 'refuse', note: 'design refuse' })
  expect(outcome.spans).toContain('index.html design.catchall 1440 light Other')
})

test('D4 a typescript step 4 runs no design review', async () => {
  const { w, outcome, seats } = await stepped('index.html', page('<h1>Plans</h1>'), 'typescript')
  expect(outcome.outcome).toBe('pass')
  expect(seats).not.toContain('design')
  expect(existsSync(join(planDir(w.root, 1), 'design'))).toBe(false)
})

test('D5 a web diff with no screen passes uncaptured', async () => {
  const { w, outcome, seats } = await stepped('logo.svg', '<svg/>', 'web')
  expect(outcome).toEqual({ outcome: 'pass', spans: [], note: 'design: the diff changes no screen' })
  expect(seats).not.toContain('design')
  expect(existsSync(join(planDir(w.root, 1), 'design'))).toBe(false)
})
