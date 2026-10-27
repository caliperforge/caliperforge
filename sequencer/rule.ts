import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { subdirs } from '../checks/tree.ts'
import { real } from '../runner/index.ts'
import { logged } from '../store/events.ts'
import { edit, filesOf } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { builderRan, type PlanRow } from '../store/plans.ts'
import { work } from '../templates/research.ts'
import { cited } from './cited.ts'
import { unruled } from './unruled.ts'
import { committed } from './committed.ts'
import { get, headSha, maybe, planDir, put, srcDir } from './workspace.ts'

const PATH = /(?:^|[\s`'"(])((?:~|\.\.)?\/[\w.-][^\s`'"()]*)/g

const OUTSIDE = /^ {2}- (\S+):1 authority\.outside_files$/gm

const BY_HAND = /\bhand[- ]?check|\bby hand\b|\bafter (?:the )?merge\b/i

const RULED = /^## (?:Ruling|Answer from the director)/

export function opened(db: Db, root: string, plan: number): string[] {
  const from = new Map<string, string>()
  for (const [name, text] of [['rulings.md', maybe(root, plan, 'rulings.md') ?? ''], ['issue.md', ruled(maybe(root, plan, 'issue.md') ?? '')]] as const) {
    for (const t of cited(text)) if (!from.has(t)) from.set(t, name)
  }
  const tokens = [...from.keys()]
  const listed = new Set(filesOf(db, plan).map((f) => f.path))
  const file = (dir: string, t: string) => statSync(join(dir, t), { throwIfNoEntry: false })?.isFile() === true
  const here = tokens.filter((t) => !t.includes('..') && !t.startsWith('/') && file(srcDir(root, plan), t))
  for (const t of here.filter((h) => !listed.has(h))) edit(db, plan, 'add', t, 'ruling', `named in ${from.get(t) ?? ''}`, false)
  const missed = tokens.filter((t) => !here.includes(t) && (t.includes('..') || t.includes('/') || !file(planDir(root, plan), t)))
  if (missed.length > 0) logged(db, { plan, kind: 'files', actor: 'ruling', outcome: 'refuse', message: `not in the checkout: ${missed.join(', ')}`, pointer: null, run: null })
  return missed
}

function ruled(issue: string): string {
  return issue.split(/^(?=## )/m).findLast((s) => RULED.test(s)) ?? ''
}

export function stray(db: Db, root: string, plan: PlanRow, text: string): string | null {
  const climbed = text.split(/\s+/).find((t) => /[^\s`'"(.]\.\.\//.test(t))
  if (climbed !== undefined) return climbed
  const output = (p: string) => plan.template === 'research' && ['sources.json', 'answer.md'].includes(relative(planDir(root, plan.id), p))
  const named = (p: string) => !p.startsWith('~') && ([srcDir(root, plan.id), root, planDir(root, plan.id)].some((d) => !relative(d, join(d, p)).startsWith('..') && existsSync(join(d, p))) || committed(root, plan.id, p))
  const under = (p: string) => p.startsWith(`${root}/`) || !relative(real(planDir(root, plan.id)), real(p)).startsWith('..')
  const climbs = (p: string) => [srcDir(root, plan.id), root].some((b) => [b, ...subdirs(b).map((s) => join(b, s))]
    .some((d) => existsSync(join(d, p)) && (under(join(d, p)) || !relative(b, join(d, p)).startsWith('..'))))
  const fetched = (p: string) => p.startsWith('~/') && plan.template === 'research' && !builderRan(db, plan.id) && work(p) !== null
  const folders = plan.template === 'research' ? [...(maybe(root, plan.id, 'ask.md') ?? '').matchAll(PATH)].flatMap((m) => work(m[1] ?? '') ?? []) : []
  const kept = (p: string) => folders.some((f) => !relative(f, work(p) ?? homedir()).startsWith('..'))
  const inside = (p: string) => p.startsWith('..') ? climbs(p) || output(join(srcDir(root, plan.id), p))
    : under(p.replace(/^~(?=\/)/, homedir())) || named(p) || output(join(planDir(root, plan.id), p)) || fetched(p) || kept(p)
  const route = (p: string) => /^\/[\w-]+\/?[.,;:!?]?$/.test(p) && !existsSync(p.replace(/[/.,;:!?]+$/, ''))
  return text.replace(/\/{2,}/g, '/').split(/(?<=[.;!?])\s+|\n/)
    .flatMap((s) => [...s.matchAll(PATH)].map((m) => m[1] ?? '').filter((p) => !route(p) && (p.startsWith('..') || !BY_HAND.test(s))))
    .find((p) => !inside(p)) ?? null
}

export function rule(db: Db, root: string, plan: PlanRow, who: string, text: string): 'ask.md' | 'issue.md' | null {
  if (stray(db, root, plan, text) !== null) return null
  const section = `## Answer from the ${who} (${new Date().toISOString().slice(0, 10)})\n\n${text.trim()}\n`
  if (!builderRan(db, plan.id)) {
    put(root, plan.id, 'ask.md', `${maybe(root, plan.id, 'ask.md') ?? ''}\n${section}`)
    return 'ask.md'
  }
  put(root, plan.id, 'issue.md', above(maybe(root, plan.id, 'issue.md') ?? '', section))
  return 'issue.md'
}

/** A ruling on a Greptile stop at ready accepts the findings still open at the head. */
export function accepted(root: string, plan: PlanRow, answer: string): boolean {
  const text = maybe(root, plan.id, 'refusal.md') ?? ''
  if (!text.startsWith(`step ${String(plan.step)} ready `) || !/^ {2}- greptile:\d\/5$/m.test(text)) return false
  const sha = headSha(srcDir(root, plan.id))
  const { open } = unruled(root, plan.id, sha)
  if (open.length === 0) return false
  put(root, plan.id, 'rulings.md', `${maybe(root, plan.id, 'rulings.md') ?? ''}\naccepted:\n  head: ${sha.slice(0, 12)}\n  ids: ${
    open.join(', ')}\n  reason: ${answer.replace(/\s+/g, ' ').trim()}\n`)
  return true
}

/** Each path refused as outside the files that `answer` names gets a row under the brief's `## Outside the files`. */
export function owned(root: string, plan: PlanRow, answer: string): boolean {
  const why = answer.replace(/\s+/g, ' ').trim()
  const named = words(answer)
  const rows = [...railed(root, plan).matchAll(OUTSIDE)]
    .flatMap((m) => named.has(m[1] ?? '') ? [`- \`${m[1] ?? ''}\` — ${why}`] : [])
  if (rows.length === 0) return false
  const issue = get(root, plan.id, 'issue.md')
  const lines = issue.split('\n')
  const head = lines.findIndex((l) => l.trimEnd() === '## Outside the files')
  if (head === -1) {
    put(root, plan.id, 'issue.md', above(issue, `## Outside the files\n\n${rows.join('\n')}\n`))
    return true
  }
  const next = lines.findIndex((l, i) => i > head && l.startsWith('## '))
  let end = next === -1 ? lines.length : next
  while (end > head + 1 && lines[end - 1]?.trim() === '') end -= 1
  put(root, plan.id, 'issue.md', [...lines.slice(0, end), ...rows, ...lines.slice(end)].join('\n'))
  return true
}

export function edits(root: string, plan: PlanRow, answer: string): boolean {
  const outside = new Set([...railed(root, plan).matchAll(OUTSIDE)].map((m) => m[1] ?? ''))
  return /hand-?back/i.test(answer)
    || [...words(answer)].some((w) => (w.includes('/') || /\.[a-z]{2,5}$/i.test(w)) && !outside.has(w))
}

function words(answer: string): Set<string> {
  return new Set(answer.split(/[^\w./-]+/).map((w) => w.replace(/\.+$/, '')))
}

export function fenced(root: string, plan: PlanRow): boolean {
  return /^ {2}- \S+ authority\./m.test(railed(root, plan))
}

/** `refusal.md` outlives the stop that wrote it, so it counts only while the plan still stands on that step-3 refusal. */
function railed(root: string, plan: PlanRow): string {
  const text = maybe(root, plan.id, 'refusal.md') ?? ''
  return plan.step === 3 && text.startsWith('step 3 ') ? text : ''
}

function above(issue: string, section: string): string {
  const lines = issue.split('\n')
  const at = lines.indexOf('## Standing')
  return at === -1 ? `${issue}\n${section}` : [...lines.slice(0, at), section, ...lines.slice(at)].join('\n')
}
