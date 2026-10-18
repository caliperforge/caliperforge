import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { postOf, proofed } from '../../store/desk.ts'
import { ofKind } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { set } from '../../store/lanes.ts'
import { render, ripe } from '../site.ts'
import { git } from '../workspace.ts'

const POST05 = '05_jito-tippayment-and-ai-invariant-suggester-live.html'

test('render D3: an index with no card throws and writes nothing', () => {
  const blog = join(mkdtempSync(join(tmpdir(), 'cf-site-')), 'blog')
  mkdirSync(blog)
  writeFileSync(join(blog, POST05), '<html><head><title>x</title></head><body><h1>x</h1><article>x</article></body></html>')
  writeFileSync(join(blog, 'index.html'), '<main>\n</main>')
  const post = { title: 'A post', dek: 'd', body: 'One.', work_date: '2026-10-01', written_date: '2026-10-02' }
  expect(() => render(join(blog, '..'), post)).toThrow('blog/index.html has no cf-blog-card')
  expect(readdirSync(blog).sort()).toEqual([POST05, 'index.html'])
  expect(readFileSync(join(blog, 'index.html'), 'utf8')).toBe('<main>\n</main>')
})

test('render D1: a post links /site.css after /caliper.css', () => {
  const blog = join(mkdtempSync(join(tmpdir(), 'cf-site-')), 'blog')
  mkdirSync(blog)
  writeFileSync(join(blog, POST05), '<html><head><title>x</title>\n<link rel="stylesheet" href="/caliper.css">\n</head><body><h1>x</h1><article>x</article></body></html>')
  writeFileSync(join(blog, 'index.html'), '<main>\n<article class="cf-blog-card">x</article>\n</main>')
  const post = { title: 'A post', dek: 'd', body: 'One.', work_date: '2026-10-01', written_date: '2026-10-02' }
  const page = readFileSync(join(blog, `${render(join(blog, '..'), post)}.html`), 'utf8')
  expect(page).toContain('<link rel="stylesheet" href="/caliper.css">\n<link rel="stylesheet" href="/site.css">')
  expect(page.split('/site.css')).toHaveLength(2)
})

test('render D2: a shell already linking /site.css keeps one', () => {
  const blog = join(mkdtempSync(join(tmpdir(), 'cf-site-')), 'blog')
  mkdirSync(blog)
  writeFileSync(join(blog, POST05), '<html><head><title>x</title>\n<link rel="stylesheet" href="/caliper.css">\n<link rel="stylesheet" href="/site.css">\n</head><body><h1>x</h1><article>x</article></body></html>')
  writeFileSync(join(blog, 'index.html'), '<main>\n<article class="cf-blog-card">x</article>\n</main>')
  const post = { title: 'A post', dek: 'd', body: 'One.', work_date: '2026-10-01', written_date: '2026-10-02' }
  const page = readFileSync(join(blog, `${render(join(blog, '..'), post)}.html`), 'utf8')
  expect(page.split('/site.css')).toHaveLength(2)
})

const SITE = { [`blog/${POST05}`]: '<html><head><title>x</title></head><body><h1>x</h1><article>x</article></body></html>',
  'blog/index.html': '<main>\n<article class="cf-blog-card">\n<h2><a href="05_x.html">Old</a></h2>\n</article>\n</main>' }

const DAILY = { id: 1, kind: 'daily', dest: 'site', title: 'The day', dek: 'd', body: 'One job landed.', sources: '[]', checks: '[]',
  work_date: '2026-10-01', written_date: '2026-10-02' } as const

const later = (hours: number): Date => new Date(Date.now() + hours * 3_600_000)

function cloned(origin: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-site-'))
  git(dir, ['clone', origin, '.'])
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  for (const pair of [['user.name', 'cf'], ['user.email', 'cf@example.com'], ['commit.gpgsign', 'false']]) git(dir, ['config', ...pair])
  return dir
}

function sited(): { db: Db; dir: string; other: string } {
  const origin = mkdtempSync(join(tmpdir(), 'cf-origin-'))
  git(origin, ['init', '--bare', '-b', 'main'])
  const dir = cloned(origin)
  mkdirSync(join(dir, 'blog'))
  for (const [path, text] of Object.entries(SITE)) writeFileSync(join(dir, path), text)
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'seed'])
  git(dir, ['push', '-u', 'origin', 'main'])
  const db = fresh(join(import.meta.dirname, '../../schema'))
  set(db, 'comms.site_dir', dir, 'ceo', '2026-10-04')
  proofed(db, DAILY)
  return { db, dir, other: cloned(origin) }
}

function moved(other: string, path: string, text: string): void {
  writeFileSync(join(other, path), text)
  git(other, ['add', path])
  git(other, ['commit', '-m', 'theirs'])
  git(other, ['push'])
}

const head = (dir: string): string => git(dir, ['rev-parse', 'HEAD']).trim()

const remote = (dir: string): string => git(dir, ['ls-remote', 'origin', 'main']).split('\t')[0] ?? ''

test('ripe D1: a moved origin is merged before the push', () => {
  const { db, dir, other } = sited()
  moved(other, 'README.md', 'site\n')
  ripe(db, later(25))
  expect(remote(dir)).toBe(head(dir))
  expect(git(dir, ['log', '-1', '--format=%P']).trim().split(' ')).toHaveLength(2)
  expect(postOf(db, 1)).toMatchObject({ status: 'published' })
  expect(ofKind(db, 'site_push')).toMatchObject([{ actor: 'tick', outcome: 'pass', message: '1 post(s)' }])
})

test('ripe D3: a conflicting origin aborts and asks the coo', () => {
  const { db, dir, other } = sited()
  moved(other, 'blog/index.html', SITE['blog/index.html'].replace('cf-blog-card">', 'cf-blog-card" id="top">'))
  ripe(db, later(25))
  expect(git(dir, ['status', '--porcelain'])).toBe('')
  const events = ofKind(db, 'site_push')
  expect(events).toMatchObject([{ outcome: 'needs_coo' }])
  expect(events[0]?.message).toContain('blog/index.html')
  expect(postOf(db, 1)).toMatchObject({ status: 'proof' })
})

test('ripe D4: a failing push is logged once per spell', () => {
  const { db, dir } = sited()
  git(dir, ['remote', 'set-url', 'origin', join(dir, 'missing')])
  const start = later(25)
  for (let i = 0; i < 10; i++) ripe(db, new Date(start.getTime() + i * 60_000))
  expect(ofKind(db, 'site_push')).toMatchObject([{ outcome: 'refuse' }])
  ripe(db, new Date(start.getTime() + 25 * 3_600_000))
  expect(ofKind(db, 'site_push').map((e) => e.outcome)).toEqual(['refuse', 'refuse'])
})
