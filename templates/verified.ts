import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Outcome } from '../sequencer/kind.ts'
import type { Source } from './research.ts'

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()

const RULER = /^(?=.*\|)(?=.*-)[ |:-]+$/

const ROW = /^\s*\|/

const LINK = /https?:\/\/[^\s|)\]>]+/g

const SKIPPED = /^(#{1,6})[ \t]+(?:Method|Not found|Still unknown|How I applied it):?[ \t]*$[\s\S]*?(?=^(?!\1#)#{1,6}[ \t]|(?![\s\S]))/gim

const bare = (s: string): string => flat(s.replace(/[*_`"“”>]/g, ''))

const cited = (claim: string, sources: Source[]): Source[] | null => {
  const links: string[] = ROW.test(claim) ? claim.match(LINK) ?? [] : []
  const all = [...[...claim.matchAll(/\[source:(\d+)\]/g)].map((m) => sources[Number(m[1]) - 1]), ...sources.filter((s) => 'url' in s && links.includes(s.url))]
  return all.length > 0 && all.every((s) => s !== undefined) ? all : null
}

type Page = { ok: true; text: string } | { ok: false; text: string; span: 'research.dead_source' | 'research.pdf_unread' }

const ENTITY: Record<string, string> = { '&amp;': '&', '&#39;': "'", '&quot;': '"', '&nbsp;': ' ' }

function pdf(bytes: ArrayBuffer): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'research-'))
  try {
    const file = join(dir, 'page.pdf')
    writeFileSync(file, Buffer.from(bytes))
    const got = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
    return got.status === 0 ? got.stdout : null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function seen(url: string, res: Response): Promise<string | null> {
  const type = res.headers.get('content-type') ?? ''
  const { pathname, hostname } = new URL(url)
  if (type.includes('application/pdf') || pathname.endsWith('.pdf')) return pdf(await res.arrayBuffer())
  const text = await res.text()
  if (type.includes('text/html')) {
    return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|#39|quot|nbsp);/g, (e) => ENTITY[e] ?? e)
  }
  return pathname.endsWith('.md') || hostname === 'raw.githubusercontent.com' ? text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') : text
}

const page = (url: string): Promise<Page> => fetch(url).then(
  async (res): Promise<Page> => {
    if (!res.ok) return { ok: false, text: String(res.status), span: 'research.dead_source' }
    const text = await seen(url, res)
    return text === null ? { ok: false, text: url, span: 'research.pdf_unread' } : { ok: true, text: flat(text) }
  },
  (error: unknown): Page => ({ ok: false, text: error instanceof Error ? error.message : String(error), span: 'research.dead_source' }))

export interface Ran { command: string; output: string }

function unmeasured(given: Ran[], at: () => string, runs: { claim: string; command: string; commit: string; quote: string }[]): Outcome | null {
  if (runs.length === 0) return null
  const head = at()
  const stale = runs.filter((r) => r.commit !== head).map((r) => `"${r.claim}" (${r.command})`)
  if (stale.length > 0) return { outcome: 'refuse', spans: ['research.run_commit'], note: `run not at HEAD ${head} for ${stale.join(', ')}` }
  const missing = runs.filter((r) => !given.some((g) => g.command === r.command && flat(g.output).includes(flat(r.quote))))
    .map((r) => `"${r.claim}" (${r.command})`)
  return missing.length > 0 ? { outcome: 'refuse', spans: ['research.run_missing'], note: `quote not in the run's output for ${missing.join(', ')}` } : null
}

const MARK = /\s*\[source:\d+\]/

function plainly(answer: string, failing: { claim: string; url: string }[]): string {
  return [...new Set(failing.map((f) => f.claim))].reduce((text, claim) => {
    const urls = [...new Set(failing.filter((f) => f.claim === claim && !claim.includes(f.url)).map((f) => ` (${f.url})`))].join('')
    return text.split(claim).join(claim.replace(/["“”]/g, '').replace(MARK, (mark) => `${urls}${mark}`))
  }, answer)
}

export async function verified(ask: string, answer: string, sources: Source[], runs: Ran[], head: () => string, stated?: (answer: string) => void): Promise<Outcome> {
  if (sources.length === 0) return { outcome: 'pass', spans: [], note: 'no sources: nothing found' }
  const asked = bare(ask)
  const lines = answer.replace(SKIPPED, '').split('\n')
  const claims = lines.filter((l, i) => l.trim() !== '' && !l.startsWith('#') && !RULER.test(l) && !RULER.test(lines[i + 1] ?? ''))
    .flatMap((l) => ROW.test(l) ? [l] : l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').split(/(?<=^(?:[^`"“]|`[^`]*`|"[^"]*"|“[^”]*”|"(?![^"]*")|“(?![^”]*”))*(?:[.!?]|\[source:\d+\]))\s+(?!\[source:)/))
    .filter((sentence) => !asked.includes(bare(sentence)) && !/:(?:\*\*)?\s*$/.test(sentence))
    .map((sentence) => ({ sentence, cited: cited(sentence, sources) }))
  const unsourced = claims.filter((c) => c.cited === null).map((c) => `"${c.sentence}"`)
  if (unsourced.length > 0) return { outcome: 'refuse', spans: ['research.unsourced'], note: `no source for ${unsourced.join(', ')}` }
  const measured = unmeasured(runs, head, claims.flatMap((c) => (c.cited ?? []).flatMap((s) => 'run' in s ? [{ ...s.run, claim: c.sentence }] : [])))
  if (measured !== null) return measured
  const cites = claims.flatMap((c) => (c.cited ?? []).flatMap((s) => 'url' in s ? [{ claim: c.sentence, url: s.url, quote: flat(s.quote) }] : []))
  const pages = new Map(await Promise.all([...new Set(cites.map((c) => c.url))].map(async (url) => [url, await page(url)] as const)))
  const unread = [...pages].filter(([, p]) => !p.ok && p.span === 'research.pdf_unread').map(([url]) => url)
  if (unread.length > 0) return { outcome: 'refuse', spans: ['research.pdf_unread'], note: `pdftotext could not read ${unread.join(', ')}` }
  const dead = [...pages].filter(([, p]) => !p.ok && p.span === 'research.dead_source').map(([url, p]) => `${url} (${p.text})`)
  if (dead.length > 0) return { outcome: 'refuse', spans: ['research.dead_source'], note: `dead source: ${dead.join(', ')}` }
  const failing = cites.filter((c) => pages.get(c.url)?.text.includes(c.quote) !== true)
  const missing = failing.map((c) => `"${c.claim}" (${c.url})`)
  if (missing.length > 0 && stated !== undefined) {
    stated(plainly(answer, failing))
    return { outcome: 'pass', spans: [], note: `quote not on the page again, stated plainly with its URL for ${missing.join(', ')}` }
  }
  if (missing.length > 0) return { outcome: 'refuse', spans: ['research.quote_missing'], note: `quote not on the page for ${missing.join(', ')}` }
  return { outcome: 'pass', spans: [], note: `${String(claims.length)} sentence(s) checked against ${String(pages.size)} url(s)` }
}
