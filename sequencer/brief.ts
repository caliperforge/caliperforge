import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { PlanFile } from '../store/files.ts'
import { CONVENTIONAL } from './conventions.ts'
import { WHOLE } from './handout.ts'
import { kept } from './verbatim.ts'
import { git } from './workspace.ts'

const CEILING = 100

const HUMANS = ['Michael Moffett', 'Moffett', 'Sam Hartley']

/** The one section the grounds below do not read, so a brief carries these words here and nowhere else. */
export const STANDING = [
  '- no shell, and no report of what it did not see',
  '- no forced push',
  "- no person's name or address in code",
]

const PARTS = ['**What:**', '**Why:**', '**When it ends:**', '## Approach', '## Settled facts', '## Cases', '## Must not break',
  '## Files', '## Files to read', '## Who else reads what this changes', '## Tests', '## Out of scope', '## Standing']

/** Past this many files other than tests a brief is two jobs, and the brief writer is sent back to split it. */
export const WIDE = 5

export const TEMPLATE = `The brief is exactly this, in this order, and at most ${String(CEILING)} lines:

\`\`\`
# <the ask's title, unchanged; on someone else's repository, a conventional-commit title for this part in their style>

**What:** <one line>
**Why:** <one line>
**When it ends:** <one line>

## Approach

<the shape of the change, in the code that is there>

## Settled facts

- <each name the change uses from outside this checkout — a dependency's type, field, call or signature — exactly as you read it, with the file you read it in; the builder takes these as given and reads nothing outside the checkout>
- none: every name the change uses is in this checkout

## Cases

- D1 <what is true when it is done, at a named file>
- D2 <…>

## Must not break

- <what still holds when it lands>

## Files

- <path:line>, or <path:start-end> on a file over ${String(WHOLE)} lines — the files this job changes, at most ${String(WIDE)} besides tests, \`(new)\` only for a path the tree does not hold yet; each row names files, never a folder

## Files to read

- <path> — <what reading it settles>

## Who else reads what this changes

- <path> — <why it is unaffected, or name it under ## Files>

## Tests

- <path> — <the one behaviour it pins: a D row or a named edge; no test that pins nothing the change does>

## Out of scope

- <what this brief does not answer>

## Standing

${STANDING.join('\n')}
\`\`\`
`

interface Format {
  what: string
  files: string[]
  readers: string[]
}

/** A format written in more than one file: moving it is one job, and every file that reads it is named. */
const SHARED: Format[] = [{
  what: 'the handback format',
  files: ['rails/completion-audit/index.ts', 'seats/typescript_specialist/prompt.md', 'seats/kotlin_specialist/prompt.md',
    'seats/swift_specialist/prompt.md', 'seats/outside_specialist/prompt.md', 'seats/rust_specialist/prompt.md',
    'seats/python_specialist/prompt.md', 'seats/ruby_specialist/prompt.md', 'seats/go_specialist/prompt.md',
    'seats/php_specialist/prompt.md', 'seats/lua_specialist/prompt.md', 'seats/modes/build.md', 'seats/modes/fix.md'],
  readers: ['sequencer/rails.ts', 'rails/tight/prose.ts'],
}]

/** An ask of the builder: a line that opens on the verb, or names the builder as the one who runs. */
const LEAD = String.raw`(?:(?<=^\s*(?:[-*]|\d+\.)?\s*(?:then\s+|and\s+)?)|\b(?:you|the builder|builder)\s+(?:(?:should|must|will|can|needs? to)\s+)?)`

const FORCED = new RegExp(LEAD + String.raw`(?:force[- ]push(?:es)?\b|squash(?:es)?\b|rewrites? (?:the )?history|push(?:es)?\b[^.\n]*--force\b)`, 'i')

const NEGATED = /\b(?:no|not|never|without|nor|nothing|none|isn't|doesn't|don't|won't|cannot)\b/i

const EMAIL = /[\w.%+-]+@[\w-]+\.[A-Za-z]{2,}/

const SHELL = new RegExp(LEAD + String.raw`(?:run|re-?run|execute|count|report)s?\b[^.\n]*\b(?:shell|terminal|command|bash|npm|pnpm|npx|node|git|vitest|tsc|the tests|test suite)\b`, 'i')

const GROUNDS: [RegExp, string][] = [
  [FORCED, 'the builder does not force push, squash or rewrite history'],
  [EMAIL, 'no address goes in the code'],
  [SHELL, 'the builder holds no shell'],
]

const PATH = /^\s*[-*]\s*`?([A-Za-z0-9_./+-]*\.[A-Za-z0-9]+)(?::\d+)?`?/

const ROW = /^\s*[-*]\s*\**D\d+\**/gm

const Unclear = z.object({ outcome: z.literal('unclear'), question: z.string().min(1) })

const Part = z.object({ title: z.string().min(1), what: z.string().min(1), why: z.string().min(1), ends: z.string().min(1),
  after: z.string().optional() })

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

const Split = z.object({ outcome: z.literal('split'), parts: z.array(Part).min(2) })
  .refine((v) => v.parts.every((p, i) => p.after === undefined || p.after.toLowerCase() === 'none' ||
    (p.after.length === 1 && LETTERS.slice(0, i).includes(p.after.toLowerCase()))))

export type Part = z.infer<typeof Part> & { after: string }

export const TEST = /(^|\/)(tests?|spec|__tests__|fixtures)\/|[._](test|spec)\.|Tests?\./

export interface Refused {
  span: string
  reason: string
}

/**
 * The question a seat's closing fence asks when the ask cannot be briefed against the code. A reply with
 * neither a fence nor a title is the same question in prose, never a failed title check.
 */
export function unclear(reply: string): string | null {
  const fence = fenceOf(reply)
  if (fence === null) return titleOf(reply) === null && reply.trim() !== '' ? reply.trim() : null
  const parsed = Unclear.safeParse(yamlOf(fence))
  return parsed.success ? parsed.data.question : null
}

/** The fence a seat ends with when the ask is more than one job: the parts, in the order they must land. */
export function split(reply: string): Part[] | null {
  const fence = fenceOf(reply)
  if (fence === null) return null
  const parsed = Split.safeParse(yamlOf(fence))
  if (!parsed.success) return null
  return parsed.data.parts.map((p, i) => ({ ...p, after: p.after?.toLowerCase() ?? (i === 0 ? 'none' : LETTERS.charAt(i - 1)) }))
}

/** The fence a reply ends with, whether or not the seat wrapped it in a code block. */
function fenceOf(reply: string): string | null {
  const bare = reply.trimEnd().replace(/\n```\s*$/, '').replace(/```[a-z]*\r?\n(?=---\r?\n(?:(?!```)[\s\S])*$)/, '')
  return /---\r?\n([\s\S]*?)\r?\n---$/.exec(bare.trimEnd())?.[1] ?? null
}

/** How many files other than tests the brief touches, when that is more than one job holds. */
export function wide(brief: string): number | null {
  const count = files(brief).filter((f) => !TEST.test(f.path)).length
  return count > WIDE ? count : null
}

/** The lines the brief's `Estimate:` under `## Approach` says the change adds and removes besides tests and generated files. */
export function estimate(brief: string): number | null {
  const lines = /^\s*Estimate:\s*~?(\d+(?:,\d+)*)/m.exec(section(brief, '## Approach'))?.[1]
  return lines === undefined ? null : Number(lines.replace(/,/g, ''))
}

/** The span of the brief a builder cannot work from, with the ground it is turned back on; null is a brief that stands. */
export function shape(brief: string, ask: string, src: string, outside = false): Refused | null {
  const title = titleOf(brief)
  if (title === null || (title !== titleOf(ask) && !(outside && CONVENTIONAL.test(title)))) return { span: '# <title>', reason: "the title is not the ask's" }
  const checks: ((b: string) => Refused | null)[] =
    [order, empty, carried, cases, caps, folders, forbidden, (b) => shared(b, src), (b) => paths(b, src), (b) => ranged(b, src), (b) => kept(b, ask)]
  for (const check of checks) {
    const refused = check(brief)
    if (refused !== null) return refused
  }
  return null
}

function order(brief: string): Refused | null {
  const lines = brief.split('\n').map((l) => l.trim())
  let at = 0
  for (const part of PARTS) {
    const found = lines.findIndex((l, i) => i >= at && l.startsWith(part))
    if (found === -1) return { span: part, reason: `${part} is missing or out of order` }
    at = found + 1
  }
  return null
}

function empty(brief: string): Refused | null {
  const bare = PARTS.filter((p) => p.startsWith('## ') && p !== '## Standing')
    .find((p) => section(brief, p).trim() === '')
  return bare === undefined ? null : { span: bare, reason: `${bare} is empty` }
}

function carried(brief: string): Refused | null {
  const lines = section(brief, '## Standing').split('\n').map((l) => l.trim()).filter((l) => l !== '')
  return lines.join('\n') === STANDING.join('\n')
    ? null
    : { span: '## Standing', reason: '## Standing does not carry the standing lines unchanged' }
}

function cases(brief: string): Refused | null {
  return (section(brief, '## Cases').match(ROW) ?? []).length < 2
    ? { span: '## Cases', reason: '## Cases holds fewer than two D rows' }
    : null
}

function caps(brief: string): Refused | null {
  const lines = brief.trimEnd().split('\n').length
  return lines > CEILING ? { span: `${String(CEILING)} lines`, reason: `the brief is ${String(lines)} lines` } : null
}

/** A row that names no file is a folder or a sentence; dropped silently, it leaves the builder fenced out of what it must write. */
function folders(brief: string): Refused | null {
  const bare = section(brief, '## Files').split('\n').find((l) => /^\s*[-*]/.test(l) && files(`## Files\n${l}`).length === 0)
  return bare === undefined ? null : { span: bare.trim(), reason: 'this ## Files row names no file; list each file, not the folder' }
}

function forbidden(brief: string): Refused | null {
  const body = without(brief, '## Standing')
  const human = HUMANS.find((name) => body.includes(name))
  if (human !== undefined) return { span: human, reason: `${human} — no person's name goes in the code` }
  for (const [pattern, ground] of GROUNDS) {
    const hit = pattern === EMAIL ? pattern.exec(body)?.[0] : asked(body, pattern)
    if (hit !== undefined) return { span: hit, reason: `${hit} — ${ground}` }
  }
  return null
}

/** A ground a line asks for: a `code` name is not an ask, and neither is a line saying the thing must not happen. */
function asked(body: string, pattern: RegExp): string | undefined {
  for (const line of body.split('\n')) {
    const prose = line.replace(/`[^`\n]*`/g, '``')
    const hit = pattern.exec(prose)
    if (hit !== null && !NEGATED.test(prose.slice(0, hit.index + hit[0].length))) return hit[0]
  }
  return undefined
}

function shared(brief: string, src: string): Refused | null {
  const changing = files(brief).map((f) => f.path)
  const listed = [...changing, ...leads(brief, '## Who else reads what this changes')]
  const rows = reached(brief)
  const moving = changing.filter((p) => {
    const lines = rows.filter((r) => r.path === p).map((r) => r.line)
    return !p.endsWith('.md') || lines.length === 0 || lines.some((l) => l >= lastFence(join(src, p)))
  })
  for (const format of SHARED.filter((f) => f.files.some((p) => moving.includes(p)))) {
    const unlisted = format.readers.find((r) => !listed.includes(r))
    if (unlisted !== undefined) return { span: unlisted, reason: `${unlisted} reads ${format.what} and is named nowhere` }
    const other = changing.find((p) => !format.files.includes(p) && !format.readers.includes(p) && !TEST.test(p))
    if (other !== undefined) return { span: other, reason: `${format.what} and ${other} are two jobs in one brief` }
  }
  return null
}

/** The 1-based line a file's last fenced block opens on; 0 when it holds no such block. */
function lastFence(path: string): number {
  if (!existsSync(path)) return 0
  const fences = readFileSync(path, 'utf8').split('\n').flatMap((l, i) => (l.startsWith('```') ? [i + 1] : []))
  return fences.at(-2) ?? 0
}

/** A path with the last line a `## Files` row reaches: `a/b.md:4-57`, `a/b.md:7,57` and `a/b.md:7` with a later bare `:57` all reach 57. */
const REACHED = /([A-Za-z0-9_.+-]*\/[A-Za-z0-9_./+-]*\.[A-Za-z0-9]+)(?::([\d,-]+))?|:(\d[\d,-]*)/g

function reached(brief: string): { path: string; line: number }[] {
  return section(brief, '## Files').split('\n').filter((l) => /^\s*[-*]/.test(l)).flatMap((l) => {
    let path = ''
    return [...l.matchAll(REACHED)].flatMap((m) => {
      path = m[1] ?? path
      const lines = m[2] ?? m[3]
      return lines === undefined || path === '' ? [] : [{ path, line: Math.max(...lines.split(/[,-]/).map(Number)) }]
    })
  })
}

function paths(brief: string, src: string): Refused | null {
  const named = [...files(brief), ...leads(brief, '## Files to read').map((path) => ({ path, is_new: false }))]
  for (const { path, is_new } of named) {
    if (is_new !== existsSync(join(src, path))) continue
    const ground = is_new ? 'is marked (new) and is already in the tree' : `is not in the checkout${meant(path, src)}`
    return { span: path, reason: `${path} ${ground}` }
  }
  return null
}

function meant(path: string, src: string): string {
  const near = git(src, ['ls-files']).split('\n').filter((f) => f.endsWith(`/${path}`))
  return near.length === 0 ? '' : `; did you mean ${near.slice(0, 3).join(', ')}?`
}

/** A file past `WHOLE` lines is handed by its block, so some `## Files` row names where that block ends: `path:start-end`. */
function ranged(brief: string, src: string): Refused | null {
  const rows = section(brief, '## Files').split('\n').filter((l) => /^\s*[-*]/.test(l))
  for (const { path, is_new } of files(brief)) {
    if (is_new || !existsSync(join(src, path))) continue
    const n = readFileSync(join(src, path), 'utf8').split('\n').length
    const named = rows.some((row) => row.split(`${path}:`).slice(1).some((after) => /^\d+-\d+/.test(after)))
    if (n > WHOLE && !named) return { span: path, reason: `${path} is ${String(n)} lines; name the range` }
  }
  return null
}

/** A path with the line it points at, anywhere on a `## Files` row: `` `a/b.rb:197` ``. */
const POINTED = /([A-Za-z0-9_.+-]*\/[A-Za-z0-9_./+-]*\.[A-Za-z0-9]+):(\d+)/g

/** Each line a `## Files` row points at, so a long file is handed by its block. */
export function pointed(brief: string, heading = '## Files'): { path: string; line: number }[] {
  return section(brief, heading).split('\n').filter((l) => /^\s*[-*]/.test(l))
    .flatMap((l) => [...l.matchAll(POINTED)].map((m) => ({ path: String(m[1]), line: Number(m[2]) })))
}

/** The reference a port must match, each line a `## Must not break` row points at outside the files the job changes. */
export function references(brief: string): { path: string; line: number }[] {
  const changing = new Set(files(brief).map((f) => f.path))
  return pointed(brief, '## Must not break').filter((p) => !changing.has(p.path))
}

/** A path in backticks anywhere on a `## Files` row; the directory in it is what tells it from a symbol. */
const TICKED = /`(?!\.\.?\/)([A-Za-z0-9_.+-]*\/[A-Za-z0-9_./+-]*\.[A-Za-z0-9]+)(?::[\d,-]+)?`/g

/**
 * The one reader of `## Files`: every path the brief says the job touches, in the order it listed them,
 * once each. A row may name several (`- Tests: \`a\`, \`b\``): an outside builder's fence is this list,
 * so a path the reader drops is a file the builder cannot write.
 */
export function files(brief: string): PlanFile[] {
  const seen = new Set<string>()
  const first = (path: string): boolean => !seen.has(path) && Boolean(seen.add(path))
  return section(brief, '## Files').split('\n').flatMap((line): PlanFile[] => {
    const lead = PATH.exec(line)?.[1]
    const ticked = /^\s*[-*]/.test(line) ? [...line.matchAll(TICKED)].map((m) => String(m[1])) : []
    return [...(lead === undefined ? [] : [lead]), ...ticked].filter(first)
      .map((path) => ({ path, is_new: line.includes('(new)') }))
  })
}

/**
 * What the builder may write: `## Files`, then each `## Tests` path it does not already list. A test named
 * only under `## Tests` is recorded as new, so it widens the fence without being handed as a file to read.
 */
export function writable(brief: string): PlanFile[] {
  const listed = files(brief)
  const extra = [...new Set(leads(brief, '## Tests'))].filter((path) => !listed.some((f) => f.path === path))
  return [...listed, ...extra.map((path) => ({ path, is_new: true }))]
}

function leads(brief: string, heading: string): string[] {
  return section(brief, heading).split('\n').flatMap((line) => {
    const path = PATH.exec(line)?.[1]
    return path === undefined ? [] : [path]
  })
}

export function section(brief: string, heading: string): string {
  const lines = brief.split('\n')
  const from = lines.findIndex((l) => l.trimEnd() === heading)
  if (from === -1) return ''
  const rest = lines.slice(from + 1)
  const to = rest.findIndex((l) => l.startsWith('## '))
  return (to === -1 ? rest : rest.slice(0, to)).join('\n')
}

function without(brief: string, heading: string): string {
  const lines = brief.split('\n')
  const from = lines.findIndex((l) => l.trimEnd() === heading)
  if (from === -1) return brief
  const next = lines.findIndex((l, i) => i > from && l.startsWith('## '))
  return [...lines.slice(0, from), ...lines.slice(next === -1 ? lines.length : next)].join('\n')
}

function titleOf(text: string): string | null {
  return /^#\s+(.*)$/m.exec(text)?.[1]?.trim() ?? null
}

export function human(brief: string): Record<'title' | 'what' | 'why' | 'ends', string | null> {
  const line = (label: string): string | null =>
    brief.split('\n').find((l) => l.startsWith(label))?.slice(label.length).trim() ?? null
  return { title: titleOf(brief), what: line('**What:**'), why: line('**Why:**'), ends: line('**When it ends:**') }
}

/**
 * Each known key's value is read as one quoted string first, since as plain YAML `: ` breaks the parse and ` #`
 * ends the value. A value that runs onto a second line does not survive the quoting, and is read as plain YAML.
 */
function yamlOf(text: string): unknown {
  const quoted = text.replace(/^(\s*(?:- )?(?:title|what|why|ends|question|outcome):[ \t]+)(?!["'|>])(.+)$/gm,
    (...m: string[]) => `${m[1] ?? ''}${JSON.stringify((m[2] ?? '').trim())}`)
  for (const each of [quoted, text]) {
    try {
      return parse(each)
    } catch {
      continue
    }
  }
  return null
}
