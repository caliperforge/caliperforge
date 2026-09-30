import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { set } from '../../store/lanes.ts'
import { article, publish, slug } from '../publish.ts'

const OLD_HERO = `
<div class="cf-eyebrow cf-eyebrow--hero">BLOG · 2026-09-05 · Placeholder Writer</div>
<h1>Old</h1>
`

const SHELL = `<!doctype html>
<html>
<head>
<title>Old post, CaliperForge</title>
<meta name="description" content="Old dek">
<link rel="canonical" href="https://caliperforge.com/blog/23_a">
</head>
<body>
<nav>Nav</nav>
<header class="cf-hero cf-hero--article">${OLD_HERO}</header>
<article class="cf-article">
<p>Old body</p>
</article>
<footer>Footer</footer>
</body>
</html>
`

const CARDS = '    <div class="cf-blog-cards">\n'
const OLD_CARD = '      <article class="cf-blog-card"><a href="/blog/23_a">Old post</a></article>\n'
const INDEX = `<main>\n${CARDS}${OLD_CARD}    </div>\n</main>\n`

interface Site { db: Db; dir: string }

const site = (): Site => {
  const db = fresh(join(import.meta.dirname, '../..', 'schema'))
  const dir = mkdtempSync(join(tmpdir(), 'cf-site-'))
  writeFileSync(join(dir, '23_a.html'), SHELL)
  writeFileSync(join(dir, 'index.html'), INDEX)
  set(db, 'comms.site_dir', dir, 'ceo', '2026-09-28')
  return { db, dir }
}

const post = (db: Db, id: number, over: Record<string, string> = {}): void => {
  db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, edited_title, edited_dek, edited_body,
    sources, checks, work_date, written_date, proof_at) VALUES (@id, @kind, @dest, @status, @title, @dek, @body, @edited_title,
    @edited_dek, @edited_body, '[]', '[]', @work_date, @written_date, @proof_at)`).run({ id, kind: 'daily', dest: 'site', status: 'approved',
    title: 'First post', dek: 'What moved', body: 'One line.', edited_title: null, edited_dek: null, edited_body: null,
    work_date: '2026-09-27', written_date: '2026-09-27', proof_at: null, ...over })
}

const aged = (db: Db, id: number, age: string): unknown =>
  db.prepare("UPDATE desk_posts SET proof_at = datetime('now', ?) WHERE id = ?").run(age, id)

const status = (db: Db): unknown[] => db.prepare('SELECT id, status FROM desk_posts ORDER BY id').all()
const read = (s: Site, name: string): string => readFileSync(join(s.dir, name), 'utf8')

const hero = (title: string, dek: string, dated = ''): string => `
<div class="cf-eyebrow cf-eyebrow--hero">BLOG · 2026-09-27 · Placeholder Writer</div>
<h1 class="cf-h1 cf-h1--entrance"><span class="cf-hline">${title}</span></h1>
<p class="cf-hero-lede">${dek}</p>
${dated}`

const card = (name: string, title: string, dek: string): string => `      <article class="cf-blog-card">
        <div class="cf-blog-card__head">
          <a class="cf-blog-card__title" href="/blog/${name}">${title}</a>
          <span class="cf-blog-card__date">2026-09-27</span>
        </div>
        <p class="cf-blog-card__desc">${dek}</p>
      </article>
`

test('an approved site row is published as the next NN_slug.html', () => {
  const s = site()
  post(s.db, 1)
  expect(publish(s.db)).toMatchObject({ outcome: 'pass' })
  expect(read(s, '24_first-post.html')).toBe(SHELL.replace('Old post', 'First post').replace('Old dek', 'What moved')
    .replace('23_a"', '24_first-post"').replace(OLD_HERO, hero('First post', 'What moved'))
    .replace('<p>Old body</p>', '<p>One line.</p>'))
  expect(status(s.db)).toEqual([{ id: 1, status: 'published' }])
})

test('index.html gains the card first, every other byte unchanged', () => {
  const s = site()
  post(s.db, 1)
  publish(s.db)
  expect(read(s, 'index.html')).toBe(`<main>\n${CARDS}${card('24_first-post', 'First post', 'What moved')}${OLD_CARD}    </div>\n</main>\n`)
})

test('substack, note and proof rows stay put and write no file', () => {
  const s = site()
  post(s.db, 1, { dest: 'substack' })
  post(s.db, 2, { dest: 'note' })
  post(s.db, 3, { status: 'proof' })
  expect(publish(s.db)).toMatchObject({ outcome: 'pass' })
  expect(status(s.db)).toEqual([{ id: 1, status: 'approved' }, { id: 2, status: 'approved' }, { id: 3, status: 'proof' }])
  expect(readdirSync(s.dir).sort()).toEqual(['23_a.html', 'index.html'])
  expect(read(s, 'index.html')).toBe(INDEX)
})

test('edited title, dek and body replace the drafts everywhere', () => {
  const s = site()
  post(s.db, 1, { edited_title: 'Edited post', edited_dek: 'Edited dek', edited_body: 'Edited line.' })
  publish(s.db)
  const page = read(s, '24_edited-post.html')
  expect(page).toContain('<title>Edited post, CaliperForge</title>')
  expect(page).toContain('content="Edited dek"')
  expect(page).toContain(hero('Edited post', 'Edited dek'))
  expect(page).toContain('<p>Edited line.</p>')
  expect(page).not.toMatch(/First post|What moved|One line/)
  expect(read(s, 'index.html')).toContain(card('24_edited-post', 'Edited post', 'Edited dek'))
})

test('a post written after its work day carries the dated note', () => {
  const s = site()
  post(s.db, 1, { written_date: '2026-09-28' })
  publish(s.db)
  expect(read(s, '24_first-post.html')).toContain(hero('First post', 'What moved', '<p class="cf-hero-lede" style="margin-top:14px;">'
    + '<strong>Dated note.</strong> The work is from 2026-09-27; this post was written on 2026-09-28.</p>\n'))
})

test('article opens sections, makes paragraphs, escapes the rest', () => {
  expect(article('Intro one\nwith `a<b` and <script>x</script>\n\n## First & "more"\nIn **section**.\n\n- not a list\n## Second\nLast.'))
    .toBe(['<p>Intro one\nwith <code>a&lt;b</code> and &lt;script&gt;x&lt;/script&gt;</p>',
      '<section class="cf-article__section">', '<p class="cf-article__eyebrow">First &amp; &quot;more&quot;</p>',
      '<p>In **section**.</p>', '<p>- not a list</p>', '</section>',
      '<section class="cf-article__section">', '<p class="cf-article__eyebrow">Second</p>', '<p>Last.</p>', '</section>'].join('\n'))
  const s = site()
  post(s.db, 1, { title: "<script>$& $' it", body: '<script>' })
  publish(s.db)
  const page = read(s, '24_script-it.html')
  expect(page).toContain('<title>&lt;script&gt;$&amp; $&#39; it, CaliperForge</title>')
  expect(page).toContain('<article class="cf-article">\n<p>&lt;script&gt;</p>\n</article>')
})

test('the slug is the title in ASCII, dashed, cut within 60 chars', () => {
  expect(slug('Ça va — Blend V2\'s H-01!')).toBe('ca-va-blend-v2-s-h-01')
  expect(slug('abcdefghij '.repeat(7))).toBe(Array(5).fill('abcdefghij').join('-'))
  const s = site()
  post(s.db, 1)
  post(s.db, 2, { title: 'Second post' })
  publish(s.db)
  expect(readdirSync(s.dir).sort()).toEqual(['23_a.html', '24_first-post.html', '25_second-post.html', 'index.html'])
  expect(read(s, '25_second-post.html')).toContain('href="https://caliperforge.com/blog/25_second-post"')
  expect(read(s, 'index.html').indexOf('25_second-post')).toBeLessThan(read(s, 'index.html').indexOf('24_first-post'))
  expect(status(s.db)).toEqual([{ id: 1, status: 'published' }, { id: 2, status: 'published' }])
})

test.each([
  ['an empty comms.site_dir', (s: Site) => { set(s.db, 'comms.site_dir', '', 'ceo', '2026-09-28'); }],
  ['no NN_*.html shell', (s: Site) => { rmSync(join(s.dir, '23_a.html')); }],
  ...['<title>Old post, CaliperForge</title>', '<meta name="description" content="Old dek">',
    '<link rel="canonical" href="https://caliperforge.com/blog/23_a">', '<header class="cf-hero cf-hero--article">',
    '<article class="cf-article">', '<div class="cf-eyebrow cf-eyebrow--hero">']
    .map((span) => [`a shell without ${span}`, (s: Site) => { writeFileSync(join(s.dir, '23_a.html'), SHELL.replace(span, '')); }]),
  ['no index.html', (s: Site) => { rmSync(join(s.dir, 'index.html')); }],
  ['an index.html without cf-blog-cards', (s: Site) => { writeFileSync(join(s.dir, 'index.html'), '<main></main>\n'); }],
].map(([why, spoil]) => ({ why, spoil })) as { why: string; spoil: (s: Site) => void }[])('publish refuses $why and leaves the row approved', ({ spoil }) => {
  const s = site()
  post(s.db, 1)
  spoil(s)
  const before = readdirSync(s.dir).sort()
  expect(publish(s.db)).toMatchObject({ outcome: 'refuse' })
  expect(readdirSync(s.dir).sort()).toEqual(before)
  expect(status(s.db)).toEqual([{ id: 1, status: 'approved' }])
})

test('a daily site proof 25 h old is written and reads published', () => {
  const s = site()
  post(s.db, 1, { status: 'proof' })
  aged(s.db, 1, '-25 hours')
  expect(publish(s.db)).toMatchObject({ outcome: 'pass' })
  expect(read(s, '24_first-post.html')).toContain(hero('First post', 'What moved'))
  expect(read(s, 'index.html')).toContain(card('24_first-post', 'First post', 'What moved'))
  expect(status(s.db)).toEqual([{ id: 1, status: 'published' }])
})

test('a site row sent back stays in changes, with no file written', () => {
  const s = site()
  post(s.db, 1, { status: 'changes' })
  aged(s.db, 1, '-25 hours')
  expect(publish(s.db)).toMatchObject({ outcome: 'pass' })
  expect(status(s.db)).toEqual([{ id: 1, status: 'changes' }])
  expect(readdirSync(s.dir).sort()).toEqual(['23_a.html', 'index.html'])
})

test('ship, weekly and substack proofs stay in proof, unwritten', () => {
  const s = site()
  post(s.db, 1, { status: 'proof', kind: 'ship' })
  post(s.db, 2, { status: 'proof', kind: 'weekly' })
  post(s.db, 3, { status: 'proof', dest: 'substack' })
  post(s.db, 4, { dest: 'substack' })
  for (const id of [1, 2, 3]) aged(s.db, id, '-25 hours')
  expect(publish(s.db)).toMatchObject({ outcome: 'pass' })
  expect(status(s.db)).toEqual([{ id: 1, status: 'proof' }, { id: 2, status: 'proof' }, { id: 3, status: 'proof' }, { id: 4, status: 'approved' }])
  expect(readdirSync(s.dir).sort()).toEqual(['23_a.html', 'index.html'])
  expect(read(s, 'index.html')).toBe(INDEX)
})

test('a proof 23 h old or with no proof_at stays in proof', () => {
  const s = site()
  post(s.db, 1, { status: 'proof' })
  post(s.db, 2, { status: 'proof' })
  aged(s.db, 1, '-23 hours')
  expect(publish(s.db)).toMatchObject({ outcome: 'pass' })
  expect(status(s.db)).toEqual([{ id: 1, status: 'proof' }, { id: 2, status: 'proof' }])
  expect(readdirSync(s.dir).sort()).toEqual(['23_a.html', 'index.html'])
})

test.each(['', '/nowhere/at/all', 'site'])('with no approved site row publish writes nothing (%s)', (dir) => {
  const s = site()
  post(s.db, 1, { status: 'proof' })
  set(s.db, 'comms.site_dir', dir === 'site' ? s.dir : dir, 'ceo', '2026-09-28')
  expect(publish(s.db)).toMatchObject({ outcome: 'pass' })
  expect(readdirSync(s.dir).sort()).toEqual(['23_a.html', 'index.html'])
})
