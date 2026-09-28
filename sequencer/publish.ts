import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { approvedSite, published, type Approved } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import { get } from '../store/lanes.ts'
import type { Outcome } from './kind.ts'

const TITLE = /(?<=<title>)[\s\S]*?(?=<\/title>)/
const DESCRIPTION = /(?<=<meta name="description" content=")[^"]*(?=")/
const CANONICAL = /(?<=<link rel="canonical" href=")[^"]*(?=")/
const HERO = /(?<=<header class="cf-hero cf-hero--article">)[\s\S]*?(?=<\/header>)/
const ARTICLE = /(?<=<article class="cf-article">)[\s\S]*?(?=<\/article>)/
const SPANS = [TITLE, DESCRIPTION, CANONICAL, HERO, ARTICLE]
const EYEBROW = /<div class="cf-eyebrow cf-eyebrow--hero">([^<]*)<\/div>/
const CARDS = '<div class="cf-blog-cards">'
const NUMBERED = /^(\d+)_.*\.html$/

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c)
const inline = (text: string): string => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>')

export function publish(db: Db): Outcome {
  const posts = approvedSite(db)
  if (posts.length === 0) return { outcome: 'pass', spans: [], note: 'no approved site post' }
  const dir = get(db, 'comms.site_dir')
  if (dir === '') return { outcome: 'refuse', spans: ['settings:comms.site_dir'], note: 'comms.site_dir is empty' }
  for (const post of posts) {
    const why = write(dir, post)
    if (why !== null) return { outcome: 'refuse', spans: [`desk_posts:${String(post.id)}`], note: `${dir} ${why}` }
    published(db, post.id)
  }
  return { outcome: 'pass', spans: [], note: `${String(posts.length)} site post(s) published` }
}

function write(dir: string, post: Approved): string | null {
  const [top] = readdirSync(dir).flatMap((file) => {
    const n = NUMBERED.exec(file)?.[1]
    return n === undefined ? [] : [{ file, n: Number(n) }]
  }).sort((a, b) => b.n - a.n)
  if (top === undefined) return 'holds no NN_*.html shell'
  const shell = readFileSync(join(dir, top.file), 'utf8')
  const who = EYEBROW.exec(shell)?.[1]?.split(' · ').at(-1)
  if (who === undefined || SPANS.some((span) => !span.test(shell))) return `${top.file} lacks a page span or the hero eyebrow`
  const index = join(dir, 'index.html')
  const cards = existsSync(index) ? readFileSync(index, 'utf8') : ''
  if (!cards.includes(CARDS)) return `index.html is missing or has no ${CARDS}`
  const name = `${String(top.n + 1).padStart(2, '0')}_${slug(post.title)}`
  writeFileSync(join(dir, `${name}.html`), page(shell, post, name, who))
  writeFileSync(index, cards.replace(CARDS, (open) => `${open}\n${card(post, name)}`))
  return null
}

function page(shell: string, post: Approved, name: string, who: string): string {
  const fills: [RegExp, string][] = [[TITLE, `${esc(post.title)}, CaliperForge`], [DESCRIPTION, esc(post.dek)],
    [CANONICAL, `https://caliperforge.com/blog/${name}`], [HERO, hero(post, who)], [ARTICLE, `\n${article(post.body)}\n`]]
  return fills.reduce((text, [span, fill]) => text.replace(span, () => fill), shell)
}

function hero(post: Approved, who: string): string {
  const dated = post.written_date === post.work_date ? [] : [`<p class="cf-hero-lede" style="margin-top:14px;"><strong>Dated note.</strong> `
    + `The work is from ${esc(post.work_date)}; this post was written on ${esc(post.written_date)}.</p>`]
  return ['', `<div class="cf-eyebrow cf-eyebrow--hero">BLOG · ${esc(post.work_date)} · ${who}</div>`,
    `<h1 class="cf-h1 cf-h1--entrance"><span class="cf-hline">${esc(post.title)}</span></h1>`,
    `<p class="cf-hero-lede">${esc(post.dek)}</p>`, ...dated, ''].join('\n')
}

function card(post: Approved, name: string): string {
  return ['<article class="cf-blog-card">', '  <div class="cf-blog-card__head">',
    `    <a class="cf-blog-card__title" href="/blog/${name}">${esc(post.title)}</a>`,
    `    <span class="cf-blog-card__date">${esc(post.work_date)}</span>`, '  </div>',
    `  <p class="cf-blog-card__desc">${esc(post.dek)}</p>`, '</article>'].map((line) => `      ${line}`).join('\n')
}

export function article(body: string): string {
  const out: string[] = []
  let lines: string[] = []
  let open = false
  const flush = (): void => {
    if (lines.length > 0) out.push(`<p>${inline(lines.join('\n'))}</p>`)
    lines = []
  }
  for (const line of body.split('\n')) {
    const heading = /^## (.+)$/.exec(line)?.[1]
    if (heading === undefined && line.trim() !== '') {
      lines.push(line)
      continue
    }
    flush()
    if (heading === undefined) continue
    out.push(...open ? ['</section>'] : [], '<section class="cf-article__section">', `<p class="cf-article__eyebrow">${esc(heading)}</p>`)
    open = true
  }
  flush()
  return [...out, ...open ? ['</section>'] : []].join('\n')
}

export function slug(title: string): string {
  const s = title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return /^.{1,60}(?=-|$)/.exec(s)?.[0] ?? s.slice(0, 60)
}
