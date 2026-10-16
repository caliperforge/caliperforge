import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { render } from '../site.ts'

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
