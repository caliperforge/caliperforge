import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { record, ticketOf } from '../cli/inbox.ts'
import { pending, placed } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import { get } from '../store/lanes.ts'
import type { PlanRow } from '../store/plans.ts'
import { titled } from '../templates/comms.ts'
import type { Step } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { git } from './workspace.ts'

const TEMPLATE = '05_jito-tippayment-and-ai-invariant-suggester-live.html'

const escaped = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

export function render(siteDir: string, post: { title: string; body: string; work_date: string; written_date: string }): string {
  const blog = join(siteDir, 'blog')
  const page = readFileSync(join(blog, TEMPLATE), 'utf8')
  const index = readFileSync(join(blog, 'index.html'), 'utf8')
  const end = ['</article>', '</main>', '</body>'].map((tag) => page.indexOf(tag)).find((at) => at !== -1)
  if (end === undefined) throw new Error(`${TEMPLATE} has no </article>, </main> or </body>`)
  const title = escaped(post.title)
  const n = Math.max(0, ...readdirSync(blog).flatMap((f) => /^(\d{2})_/.exec(f)?.[1] ?? []).map(Number)) + 1
  const name = `${String(n).padStart(2, '0')}_${post.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
  const body = post.body.split(/\n\s*\n/).map((block) => block.trim()).filter((block) => block !== '')
    .map((block) => (block.startsWith('## ') ? `<h2>${escaped(block.slice(3))}</h2>` : `<p>${escaped(block)}</p>`))
  writeFileSync(join(blog, `${name}.html`), [page.slice(0, page.indexOf('<h1')).replace(/<title>[\s\S]*?<\/title>/, () => `<title>${title}</title>`),
    `<h1>${title}</h1>`, `<p class="dateline">Work completed ${post.work_date} · written up ${post.written_date}.</p>`, ...body, page.slice(end)].join('\n'))
  writeFileSync(join(blog, 'index.html'), index.replace('<ul>', () => `<ul>\n<li><a href="${name}.html">${title}</a> · ${post.written_date}</li>`))
  return name
}

export function commit(siteDir: string, name: string): void {
  git(siteDir, ['add', `blog/${name}.html`, 'blog/index.html'])
  git(siteDir, ['commit', '-m', `post: ${name}`])
}

export function publish(db: Db, root: string, plan: PlanRow, step: Step): Outcome {
  if (titled(db, plan, 'daily') !== null) return { outcome: 'pass', spans: [], note: 'daily plan; nothing to publish' }
  const rows = pending(db)
  if (rows.length === 0) return { outcome: 'pass', spans: [], note: 'nothing to publish' }
  const value = get(db, 'comms.site_dir')
  if (value === '') return { outcome: 'refuse', spans: ['comms.site_dir'], note: 'comms.site_dir is unset' }
  const dir = value.replace(/^~(?=\/|$)/, homedir())
  for (const row of rows) {
    const name = render(dir, { ...row, title: row.edited_title ?? row.title, body: row.edited_body ?? row.body })
    commit(dir, name)
    placed(db, row.id, `https://caliperforge.com/blog/${name}.html`)
  }
  record(root, [{ at: new Date().toISOString(), plan: plan.id, ticket: ticketOf(db, plan.id), kind: 'signoff', step: step.step, name: step.name,
    note: 'site post ready: run `cf site push`' }])
  return { outcome: 'pass', spans: [], note: `${String(rows.length)} post(s) written to ${dir}` }
}
