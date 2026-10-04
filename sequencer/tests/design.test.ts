import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, test } from 'vitest'
import type { Verdict } from '../../store/verdict.ts'
import { design, screens } from '../design.ts'

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
