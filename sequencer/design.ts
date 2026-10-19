import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { walk } from '../checks/tree.ts'
import type { Provider } from '../providers/kind.ts'
import { parse } from '../rails/diff.ts'
import { judge } from '../reviews/bench.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import { pending } from '../store/transcript.ts'
import type { Verdict } from '../store/verdict.ts'
import type { Outcome } from './kind.ts'
import { cloned, diffOf, get, git, maybe, planDir, put, rulings, srcDir } from './workspace.ts'

interface Shot {
  screen: string
  width: number
  scheme: 'light' | 'dark'
}

interface Found {
  overflow: boolean
  clipped: string[]
  catchall: string[]
}

const WIDTHS = [1440, 400]
const SCHEMES = ['light', 'dark'] as const
const SOURCE = /\.(?:css|js|mjs)$/
const LOADS = /\b(?:src|href)=["']([^"'?#]*)/g
const TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
}

// a string, not a function: the tsconfig carries no DOM types
const DEFECTS = `(() => {
  const own = (el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim()
  const texts = [...document.body.querySelectorAll('*')].map((el) => [el, own(el)]).filter(([, text]) => text !== '')
  const cut = (el) => {
    const style = getComputedStyle(el)
    return el.scrollWidth > el.clientWidth && (['hidden', 'clip'].includes(style.overflowX) || style.textOverflow === 'ellipsis')
  }
  const root = document.documentElement
  return {
    overflow: root.scrollWidth > root.clientWidth,
    clipped: texts.filter(([el]) => cut(el)).map(([, text]) => text),
    catchall: texts.map(([, text]) => text).filter((text) => /^(other|no target)$/i.test(text)),
  }
})()`

const webOf = (src: string): string => existsSync(join(src, 'public', 'index.html')) ? join(src, 'public') : src

export function screens(diff: string, src: string): string[] {
  const files = parse(diff)
  if (files.length > 0 && files.every((f) => SOURCE.test(f.path))) {
    const changed = new Set(files.map((f) => resolve(src, f.path)))
    const web = webOf(src)
    const loading = walk(src, (n) => n.endsWith('.html')).filter((p) =>
      [...readFileSync(p, 'utf8').matchAll(LOADS)].some(([, value = '']) =>
        changed.has(value.startsWith('/') ? resolve(web, `.${value}`) : resolve(dirname(p), value))))
    return loading.length > 0 ? loading.map((p) => relative(src, p)) : ['index.html']
  }
  return files.filter((f) => !f.deleted && f.path.endsWith('.html')).map((f) => f.path)
}

function waived(root: string, plan: number): string | null {
  const ruled = (maybe(root, plan, 'issue.md') ?? '').split(/^(?=## )/m).filter((s) => /^## (?:Ruling|Answer)/.test(s))
  return /^design waived: *(\S.*)$/m.exec([maybe(root, plan, 'rulings.md') ?? '', ...ruled].join('\n'))?.[1] ?? null
}

export function waive(root: string, plan: number, why: string): void {
  if (waived(root, plan) !== null) return
  put(root, plan, 'rulings.md', `${maybe(root, plan, 'rulings.md') ?? ''}\ndesign waived: ${why.split('\n')[0] ?? ''}\n`)
}

export async function looked(db: Db, root: string, plan: PlanRow, provider: Provider): Promise<Outcome> {
  const reason = waived(root, plan.id)
  if (reason !== null) return { outcome: 'pass', spans: [], note: `design waived: ${reason}` }
  const diff = diffOf(root, plan.id)
  const src = srcDir(root, plan.id)
  const pages = screens(diff, src)
  if (pages.length === 0) return { outcome: 'pass', spans: [], note: 'design: the diff changes no screen' }
  const out = planDir(root, plan.id)
  const dir = join(out, 'design')
  rmSync(dir, { recursive: true, force: true })
  const main = await onMain(root, plan.id, src, pages)
  const capture = await design(src, out, pages)
  const screenshots = readdirSync(dir).map((n) => join(dir, n))
  if (screenshots.length === 0) return { outcome: 'refuse', spans: capture.spans, note: 'design: no screen served' }
  const fresh = capture.spans.filter((span) => !main.includes(span))
  const already = capture.spans.filter((span) => main.includes(span))
  const system = join(src, 'DESIGN.md')
  const input = {
    repo: src,
    issue: get(root, plan.id, 'issue.md') + rulings(root, plan.id),
    diff,
    screenshots,
    ...(capture.spans.length > 0 ? { defects: [...fresh, ...already.map((span) => `${span} (already on main)`)].join('\n') } : {}),
    ...(existsSync(system) ? { system: readFileSync(system, 'utf8') } : {}),
  }
  const { outcome } = await judge(db, root, 'design', plan.id, input, provider, pending(out, 'step-4-design'))
  const spans = fresh.length === 0 && already.length > 0 ? [] : [...fresh, ...outcome.spans]
  const onBase = already.length > 0 ? `; already on main: ${already.join('; ')}` : ''
  if (outcome.outcome === 'needs_ceo') return { outcome: 'needs_ceo', spans: outcome.spans, note: `design needs_ceo${onBase}`, message: outcome.message }
  if (spans.length > 0) {
    const message = [`${String(fresh.length)} span(s) show a hard design defect`, outcome.message].join('\n\n')
    return { outcome: 'refuse', spans, note: already.length > 0 ? `design refuse; new: ${fresh.join('; ')}${onBase}` : 'design refuse', message }
  }
  return { outcome: 'pass', spans: [], note: `design pass${onBase}` }
}

async function onMain(root: string, plan: number, src: string, pages: string[]): Promise<string[]> {
  const base = maybe(root, plan, 'base.sha')
  if (base === null || !cloned(src)) return []
  const main = join(planDir(root, plan), 'main')
  rmSync(main, { recursive: true, force: true })
  git(src, ['worktree', 'prune'])
  git(src, ['worktree', 'add', '--detach', main, base.trim()])
  try {
    return (await design(main, join(main, '..', 'main-shots'), pages)).spans
  } finally {
    git(src, ['worktree', 'remove', '--force', main])
  }
}

export async function design(src: string, out: string, pages: string[]): Promise<Verdict> {
  const web = webOf(src)
  const paths = web === src ? pages : pages.map((page) => page.replace(/^public\//, ''))
  const served = paths.filter((path) => existsSync(join(web, path)))
  const unserved = paths.filter((path) => !served.includes(path)).map((path) => `${path} design.unserved`)
  const server = await serve(web, src)
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ headless: true })
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    mkdirSync(join(out, 'design'), { recursive: true })
    const shots = served.flatMap((screen) => WIDTHS.flatMap((width) => SCHEMES.map((scheme) => ({ screen, width, scheme }))))
    const pngs: Buffer[] = []
    const spans = [...unserved]
    for (const shot of shots) {
      const taken = await shoot(browser, base, out, shot)
      pngs.push(taken.png)
      spans.push(...taken.spans)
    }
    return verdict(pngs, spans)
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
}

export function serve(web: string, repo: string): Promise<Server> {
  const root = resolve(web)
  const api = resolve(repo, 'design', 'api')
  const server = createServer((req, res) => {
    void Promise.resolve(req.url ?? '/').then(async (url) => {
      const pathname = decodeURIComponent(new URL(url, 'http://127.0.0.1').pathname)
      if (pathname.startsWith('/api/')) {
        const fixture = resolve(api, `.${pathname.slice('/api'.length)}.json`)
        if (!fixture.startsWith(api + sep)) throw new Error(`${url} resolves outside ${api}`)
        if (existsSync(fixture)) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(await readFile(fixture))
          return
        }
      }
      const path = resolve(root, `.${pathname}`)
      if (!path.startsWith(root + sep)) throw new Error(`${url} resolves outside ${root}`)
      const body = await readFile(path)
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body)
    }).catch(() => res.writeHead(404).end())
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => { done(server) }))
}

async function shoot(browser: Browser, base: string, out: string, shot: Shot): Promise<{ png: Buffer; spans: string[] }> {
  const context = await browser.newContext({ viewport: { width: shot.width, height: 900 }, colorScheme: shot.scheme })
  try {
    const page = await context.newPage()
    const logged: { text: string; url: string }[] = []
    const failed = new Set<string>()
    page.on('response', (r) => { if (r.status() >= 400 && ['fetch', 'xhr'].includes(r.request().resourceType())) failed.add(r.url()) })
    page.on('console', (msg) => { if (msg.type() === 'error') logged.push({ text: msg.text(), url: msg.location().url }) })
    page.on('pageerror', (e) => logged.push({ text: e.message, url: '' }))
    await page.goto(`${base}/${shot.screen}`, { waitUntil: 'load' })
    const path = join(out, 'design', `${shot.screen.replaceAll('/', '_')}.${String(shot.width)}.${shot.scheme}.png`)
    const png = await page.screenshot({ path, fullPage: true })
    const found = await page.evaluate<Found>(DEFECTS)
    const at = (rule: string, text = ''): string => `${shot.screen} ${rule} ${String(shot.width)} ${shot.scheme}${text === '' ? '' : ` ${text}`}`
    const spans = [
      ...(found.overflow ? [at('design.overflow')] : []),
      ...found.clipped.map((text) => at('design.clipped', text)),
      ...found.catchall.map((text) => at('design.catchall', text)),
      ...logged.filter((e) => !failed.has(e.url)).map((e) => at('design.console', e.text)),
    ]
    return { png, spans }
  } finally {
    await context.close()
  }
}

function verdict(pngs: Buffer[], spans: string[]): Verdict {
  const hash = createHash('sha256')
  for (const png of pngs) hash.update(png)
  const subject_digest = hash.digest('hex')
  if (spans.length === 0) return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest, spans, message: `${String(pngs.length)} screenshot(s) show no overflow, clipping, console error or catch-all label` }
  return {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'design',
    subject_digest,
    spans,
    message: `${String(spans.length)} span(s) show a hard design defect`,
  }
}
