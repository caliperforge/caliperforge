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

const site = (shell = SHELL, index: string | null = INDEX): Site => {
  const db = fresh(join(import.meta.dirname, '../..', 'schema'))
  const dir = mkdtempSync(join(tmpdir(), 'cf-site-'))
  writeFileSync(join(dir, '23_a.html'), shell)
  if (index !== null) writeFileSync(join(dir, 'index.html'), index)
  set(db, 'comms.site_dir', dir, 'ceo', '2026-09-28')
  return { db, dir }
}

const post = (db: Db, id: number, over: Record<string, string> = {}): void => {
  db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, edited_title, edited_dek, edited_body,
    sources, checks, work_date, written_date) VALUES (@id, 'daily', @dest, @status, @title, @dek, @body, @edited_title,
    @edited_dek, @edited_body, '[]', '[]', @work_date, @written_date)`).run({ id, dest: 'site', status: 'approved',
    title: 'First post', dek: 'What moved', body: 'One line.', edited_title: null, edited_dek: null, edited_body: null,
    work_date: '2026-09-27', written_date: '2026-09-27', ...over })
}

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

test('D1: an approved site row becomes the next NN_slug.html off the newest shell, and its row reads published', () => {
  const s = site()
  post(s.db, 1)
  expect(publish(s.db)).toMatchObject({ outcome: 'pass' })
  expect(read(s, '24_first-post.html')).toBe(SHELL.replace('Old post', 'First post').replace('Old dek', 'What moved')
    .replace('23_a"', '24_first-post"').replace(OLD_HERO, hero('First post', 'What moved'))
    .replace('<p>Old body</p>', '<p>One line.</p>'))
  expect(status(s.db)).toEqual([{ id: 1, status: 'published' }])
})

test('D2: index.html gains the card as the first child of cf-blog-cards, every other byte unchanged', () => {
  const s = site()
  post(s.db, 1)
  publish(s.db)
  expect(read(s, 'index.html')).toBe(`<main>\n${CARDS}${card('24_first-post', 'First post', 'What moved')}${OLD_CARD}    </div>\n</main>\n`)
})

test('D3: approved substack and note rows and a site row in proof stay as they are, with no file written', () => {
  const s = site()
  post(s.db, 1, { dest: 'substack' })
  post(s.db, 2, { dest: 'note' })
  post(s.db, 3, { status: 'proof' })
  expect(publish(s.db)).toMatchObject({ outcome: 'pass' })
  expect(status(s.db)).toEqual([{ id: 1, status: 'approved' }, { id: 2, status: 'approved' }, { id: 3, status: 'proof' }])
  expect(readdirSync(s.dir).sort()).toEqual(['23_a.html', 'index.html'])
  expect(read(s, 'index.html')).toBe(INDEX)
})

test('D4: the edited title, dek and body replace the drafted ones in the page, the card and the slug', () => {
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

test('D5: a post written on another day than its work carries the dated note after the lede', () => {
  const s = site()
  post(s.db, 1, { written_date: '2026-09-28' })
  publish(s.db)
  expect(read(s, '24_first-post.html')).toContain(hero('First post', 'What moved', '<p class="cf-hero-lede" style="margin-top:14px;">'
    + '<strong>Dated note.</strong> The work is from 2026-09-27; this post was written on 2026-09-28.</p>\n'))
})

test('D6: headings open sections, line runs become paragraphs, code spans convert, and every other text is escaped', () => {
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

test('D7: the slug is the title lowercased to ASCII, dashed, and cut at a dash within 60, and a second row takes the next number', () => {
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
].map(([why, spoil]) => ({ why, spoil })) as { why: string; spoil: (s: Site) => void }[])('D8: publish refuses $why, writes no file and leaves the row approved', ({ spoil }) => {
  const s = site()
  post(s.db, 1)
  spoil(s)
  const before = readdirSync(s.dir).sort()
  expect(publish(s.db)).toMatchObject({ outcome: 'refuse' })
  expect(readdirSync(s.dir).sort()).toEqual(before)
  expect(status(s.db)).toEqual([{ id: 1, status: 'approved' }])
})

test.each(['', '/nowhere/at/all', 'site'])('D9: with no approved site row, publish passes and writes nothing whatever comms.site_dir is (%s)', (dir) => {
  const s = site()
  post(s.db, 1, { status: 'proof' })
  set(s.db, 'comms.site_dir', dir === 'site' ? s.dir : dir, 'ceo', '2026-09-28')
  expect(publish(s.db)).toMatchObject({ outcome: 'pass' })
  expect(readdirSync(s.dir).sort()).toEqual(['23_a.html', 'index.html'])
})
