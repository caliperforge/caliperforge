import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { load } from '../../runner/rules.ts'
import { runRows } from '../../store/events.ts'
import { verdictRows, type Verdict } from '../../store/verdict.ts'
import { at } from '../../templates/pr-path.ts'
import { design, screens, serve, waive } from '../design.ts'
import type { Outcome } from '../kind.ts'
import { fireLanded } from '../seat.ts'
import { git, planDir, put, srcDir } from '../workspace.ts'
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

const publicRun = async (href: string, pages: string[], script = ''): Promise<{ verdict: Verdict; out: string }> => {
  const src = mkdtempSync(join(tmpdir(), 'design-src-'))
  const out = mkdtempSync(join(tmpdir(), 'design-out-'))
  mkdirSync(join(src, 'public'))
  writeFileSync(join(src, 'public', 'index.html'), page(`<link rel="stylesheet" href="${href}"><h1>Plans</h1>${script}`))
  writeFileSync(join(src, 'public', 'style.css'), 'h1 { color: #1a1a1a }')
  return { verdict: await design(src, out, pages), out }
}

browsed('D1 public/ is the web root, so /style.css loads', async () => {
  const { verdict, out } = await publicRun('/style.css', ['public/index.html'])
  expect(verdict).toMatchObject({ outcome: 'pass', spans: [] })
  expect(readdirSync(join(out, 'design'))).toHaveLength(4)
})

browsed('D2 the css-only index.html is public/index.html', async () => {
  const { verdict } = await publicRun('/style.css', ['index.html'])
  expect(verdict).toMatchObject({ outcome: 'pass', spans: [] })
})

browsed('D3 a missing asset under public/ still refuses', async () => {
  const { verdict } = await publicRun('/missing.css', ['public/index.html'])
  expect(verdict.spans).toContain('index.html design.console 1440 light Failed to load resource: the server responded with a status of 404 (Not Found)')
})

browsed('D1 a 404 on a fetch under public/ passes', async () => {
  const { verdict } = await publicRun('/style.css', ['public/index.html'], "<script>fetch('/api/missing')</script>")
  expect(verdict).toMatchObject({ outcome: 'pass', spans: [] })
})

const fetched = async (web: string, repo: string, path: string): Promise<{ status: number; type: string | null; body: string }> => {
  const server = await serve(web, repo)
  try {
    const res = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}${path}`)
    return { status: res.status, type: res.headers.get('content-type'), body: await res.text() }
  } finally {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
}

const checkout = (fixtures: Record<string, string>): string => {
  const repo = mkdtempSync(join(tmpdir(), 'design-repo-'))
  mkdirSync(join(repo, 'public'))
  writeFileSync(join(repo, 'public', 'style.css'), 'h1 { color: #1a1a1a }')
  for (const [path, body] of Object.entries(fixtures)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), body)
  }
  return repo
}

test('D1 /api/now answers with the design/api/now.json fixture', async () => {
  const repo = checkout({ 'design/api/now.json': '{"plans":[]}' })
  expect(await fetched(repo, repo, '/api/now')).toEqual({ status: 200, type: 'application/json', body: '{"plans":[]}' })
})

test('D2 /api/now without a fixture is a 404', async () => {
  const repo = checkout({})
  expect((await fetched(repo, repo, '/api/now')).status).toBe(404)
})

test('D3 a static file under public/ still serves', async () => {
  const repo = checkout({})
  expect(await fetched(join(repo, 'public'), repo, '/style.css')).toMatchObject({ status: 200, type: 'text/css' })
})

test('D4 /api/..%2fx is refused though design/x.json exists', async () => {
  const repo = checkout({ 'design/x.json': '{}' })
  expect((await fetched(repo, repo, '/api/..%2fx')).status).toBe(404)
})

test('D5 a public/ web root reads fixtures from the repo root', async () => {
  const repo = checkout({ 'design/api/now.json': '{"at":"repo"}' })
  expect(await fetched(join(repo, 'public'), repo, '/api/now')).toMatchObject({ status: 200, body: '{"at":"repo"}' })
})

const file = (from: string, to: string): string => [`--- ${from}`, `+++ ${to}`, '@@ -1 +1 @@', '-a', '+b'].join('\n')

test('D5 screens skips deleted html; css alone means index.html', () => {
  const src = checkout({ 'about.html': page('<h1>About</h1>') })
  expect(screens([file('a/old.html', '/dev/null'), file('a/app/plans.html', 'b/app/plans.html')].join('\n'), src)).toEqual(['app/plans.html'])
  expect(screens(file('a/style.css', 'b/style.css'), src)).toEqual(['index.html'])
})

test('D1 a js-only diff screens the page that loads the script', () => {
  const src = checkout({
    'sirvoy-helper/rooms.html': page('<script src="el-rooms.js"></script>'),
    'about.html': page('<h1>About</h1>'),
    'notes.html': page('<p>el-rooms.js</p>'),
  })
  expect(screens(file('a/sirvoy-helper/el-rooms.js', 'b/sirvoy-helper/el-rooms.js'), src)).toEqual(['sirvoy-helper/rooms.html'])
})

test('D2 a page loading its own app.js is not screened', () => {
  const src = checkout({
    'public/index.html': page('<script src="/app.js"></script>'),
    'public/preview/x/index.html': page('<script src="app.js"></script>'),
  })
  expect(screens(file('a/public/app.js', 'b/public/app.js'), src)).toEqual(['public/index.html'])
})

browsed('D3 a missing page is unserved and leaves no shot', async () => {
  const src = mkdtempSync(join(tmpdir(), 'design-src-'))
  const out = mkdtempSync(join(tmpdir(), 'design-out-'))
  const verdict = await design(src, out, ['missing.html'])
  expect(verdict).toMatchObject({ outcome: 'refuse', spans: ['missing.html design.unserved'] })
  expect(readdirSync(join(out, 'design'))).toHaveLength(0)
})

const stepped = async (name: string, body: string, language: string, seen?: (packet: Packet) => void,
  system?: string, ruled: { rulings?: string; issue?: string; waive?: string } = {}): Promise<{ w: World; outcome: Outcome; seats: string[] }> => {
  const w = world()
  load(w.db, w.root)
  writeFileSync(join(srcDir(w.root, 1), name), body)
  if (system !== undefined) writeFileSync(join(srcDir(w.root, 1), 'DESIGN.md'), system)
  put(w.root, 1, 'issue.md', ruled.issue ?? '# a screen\n\n- D1 add a screen\n')
  if (ruled.rulings !== undefined) put(w.root, 1, 'rulings.md', ruled.rulings)
  if (ruled.waive !== undefined) waive(w.root, 1, ruled.waive)
  const row = { ...plan(w.db, 1), origin: 'https://github.com/caliperforge/atelier-web/issues/1' }
  const outcome = await fireLanded(w.db, w.root, row, at(4, language), stub(CARRIED, 0, undefined, seen))
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

const OTHER = page('<fieldset><legend>Other</legend></fieldset>')
const WAIVER = 'design waived: build changes no screen'

test('D1 a rulings.md waiver passes with no design run', async () => {
  const { w, outcome, seats } = await stepped('index.html', OTHER, 'web', undefined, undefined, { rulings: `${WAIVER}\n` })
  expect(outcome).toEqual({ outcome: 'pass', spans: [], note: WAIVER })
  expect(seats).not.toContain('design')
  expect(existsSync(join(planDir(w.root, 1), 'design'))).toBe(false)
})

test('D2 a waiver in an issue.md Answer section passes', async () => {
  const issue = `# a screen\n\n- D1 add a screen\n\n## Answer from the coo (2026-10-17)\n\n${WAIVER}\n`
  const { outcome } = await stepped('index.html', OTHER, 'web', undefined, undefined, { issue })
  expect(outcome).toEqual({ outcome: 'pass', spans: [], note: WAIVER })
})

test('D4 a director waive passes with no design run', async () => {
  const { outcome, seats } = await stepped('index.html', OTHER, 'web', undefined, undefined, { waive: 'build changes no screen' })
  expect(outcome).toEqual({ outcome: 'pass', spans: [], note: WAIVER })
  expect(seats).not.toContain('design')
})

browsed('D4 a waiver in the issue.md body still refuses', async () => {
  const issue = `# a screen\n\n${WAIVER}\n\n- D1 add a screen\n`
  const { outcome } = await stepped('index.html', OTHER, 'web', undefined, undefined, { issue })
  expect(outcome).toMatchObject({ outcome: 'refuse', note: 'design refuse' })
  expect(outcome.spans).toContain('index.html design.catchall 1440 light Other')
})

test('D4 a typescript step 4 runs no design review', async () => {
  const { w, outcome, seats } = await stepped('index.html', page('<h1>Plans</h1>'), 'typescript')
  expect(outcome.outcome).toBe('pass')
  expect(seats).not.toContain('design')
  expect(existsSync(join(planDir(w.root, 1), 'design'))).toBe(false)
})

browsed('D4 an unserved screen refuses before the design review', async () => {
  const { outcome, seats } = await stepped('style.css', 'h1 { color: #1a1a1a }', 'web')
  expect(outcome).toEqual({ outcome: 'refuse', spans: ['index.html design.unserved'], note: 'design: no screen served' })
  expect(seats).not.toContain('design')
})

const designed = async (system?: string): Promise<string | undefined> => {
  const sent: Packet[] = []
  await stepped('index.html', page('<h1>Plans</h1>'), 'web', (p) => sent.push(p), system)
  return sent.find((p) => p.reads !== undefined)?.prompt
}

browsed('D1 the design packet carries the checkout DESIGN.md', async () => {
  expect(await designed('Palette: ink `#1a1a1a`')).toContain('\n\n# DESIGN.md in the checkout\n\nPalette: ink `#1a1a1a`')
})

browsed('D2 no DESIGN.md in the checkout, no section', async () => {
  const prompt = await designed()
  expect(prompt).toContain('# Screenshots')
  expect(prompt).not.toContain('\n# DESIGN.md in the checkout\n')
})

const WIDE = '<table style="width:1200px"><tr><td>wide</td></tr></table>'

const based = async (before: string, after: string, seen?: (packet: Packet) => void): Promise<{ w: World; outcome: Outcome }> => {
  const w = world()
  load(w.db, w.root)
  const src = srcDir(w.root, 1)
  git(src, ['init', '-q'])
  writeFileSync(join(src, 'index.html'), page(before))
  git(src, ['add', '-A'])
  git(src, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'])
  put(w.root, 1, 'base.sha', git(src, ['rev-parse', 'HEAD']))
  writeFileSync(join(src, 'index.html'), page(after))
  put(w.root, 1, 'issue.md', '# a screen\n\n- D1 add a screen\n')
  const row = { ...plan(w.db, 1), origin: 'https://github.com/caliperforge/atelier-web/issues/1' }
  return { w, outcome: await fireLanded(w.db, w.root, row, at(4, 'web'), stub(CARRIED, 0, undefined, seen)) }
}

browsed('D1 an overflow already on base passes the capture', async () => {
  const { outcome } = await based(`<h1>Plans</h1>${WIDE}`, `<h1>Plans now</h1>${WIDE}`)
  expect(outcome.outcome).toBe('pass')
  expect(outcome.note).toMatch(/^design pass; already on main: index\.html design\.overflow 400 light; /)
})

browsed('D2 an overflow the change adds still refuses', async () => {
  const { outcome } = await based('<h1>Plans</h1>', `<h1>Plans</h1>${WIDE}`)
  expect(outcome.outcome).toBe('refuse')
  expect(outcome.spans).toContain('index.html design.overflow 400 light')
  expect(outcome.note).not.toContain('already on main')
})

browsed('D3 an added Other refuses on catchall, not base overflow', async () => {
  const { outcome } = await based(`<h1>Plans</h1>${WIDE}`, `<h1>Plans</h1>${WIDE}<fieldset><legend>Other</legend></fieldset>`)
  expect(outcome.outcome).toBe('refuse')
  expect(outcome.spans).toContain('index.html design.catchall 1440 light Other')
  expect(outcome.spans.filter((span) => span.includes('design.overflow'))).toEqual([])
  expect(outcome.note).toContain('already on main: index.html design.overflow 400 light')
})

browsed('D4 the packet marks a base span already on main', async () => {
  const sent: Packet[] = []
  await based(`<h1>Plans</h1>${WIDE}`, `<h1>Plans now</h1>${WIDE}`, (p) => sent.push(p))
  const prompt = sent.find((p) => p.reads !== undefined)?.prompt
  expect(prompt).toContain('# Defects the capture found')
  expect(prompt).toContain('index.html design.overflow 400 light (already on main)')
})

browsed('D4 the base capture leaves no shots and no worktree', async () => {
  const { w } = await based(`<h1>Plans</h1>${WIDE}`, `<h1>Plans now</h1>${WIDE}`)
  expect(readdirSync(join(planDir(w.root, 1), 'design'))).toHaveLength(4)
  expect(git(srcDir(w.root, 1), ['worktree', 'list']).trim().split('\n')).toHaveLength(1)
})

test('D5 a web diff with no screen passes uncaptured', async () => {
  const { w, outcome, seats } = await stepped('logo.svg', '<svg/>', 'web')
  expect(outcome).toEqual({ outcome: 'pass', spans: [], note: 'design: the diff changes no screen' })
  expect(seats).not.toContain('design')
  expect(existsSync(join(planDir(w.root, 1), 'design'))).toBe(false)
})
