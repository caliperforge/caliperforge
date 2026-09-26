import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { PlanFile } from '../store/files.ts'

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

/** #72: past this many files other than tests a brief is two jobs, and the brief writer is sent back to split it. */
export const WIDE = 5

export const TEMPLATE = `The brief is exactly this, in this order, and at most ${String(CEILING)} lines:

\`\`\`
# <the ask's title, unchanged>

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

- <path:line> — the files this job changes, at most ${String(WIDE)} besides tests, \`(new)\` only for a path the tree does not hold yet; each row names files, never a folder

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
    'seats/php_specialist/prompt.md', 'seats/lua_specialist/prompt.md'],
  readers: ['sequencer/rails.ts', 'rails/tight/prose.ts'],
}]

const FORCED = /forced?[- ]push|--force\b|force-with-lease|\bsquash|rewrit\w+ (?:the )?history|history rewrit\w+/i

const NEGATED = /\b(?:no|not|never|without|nor|nothing|none|isn't|doesn't|don't|won't|cannot)\b/i

const EMAIL = /[\w.%+-]+@[\w-]+\.[A-Za-z]{2,}/

/**
 * An ask of the builder: a line that opens on the verb, or names the builder as the one who runs. A brief on our
 * own kernel describes code that runs git and npm ("the ready gate runs git add"), and read as an ask that sent
 * plans 127, 129 and 151 back three times each on 09-25.
 */
const SHELL = /(?:(?<=^\s*(?:[-*]|\d+\.)?\s*(?:then\s+|and\s+)?)|\b(?:you|the builder|builder)\s+(?:(?:should|must|will|can|needs? to)\s+)?)(?:run|re-?run|execute|count|report)s?\b[^.\n]*\b(?:shell|terminal|command|bash|npm|pnpm|npx|node|git|vitest|tsc|the tests|test suite)\b/i

const GROUNDS: [RegExp, string][] = [
  [FORCED, 'the builder does not force push, squash or rewrite history'],
  [EMAIL, 'no address goes in the code'],
  [SHELL, 'the builder holds no shell'],
]

const PATH = /^\s*[-*]\s*`?([A-Za-z0-9_./+-]+\.[A-Za-z0-9]+)(?::\d+)?`?/

const ROW = /^\s*[-*]\s*\**D\d+\**/gm

const Unclear = z.object({ outcome: z.literal('unclear'), question: z.string().min(1) })

const Part = z.object({ title: z.string().min(1), what: z.string().min(1), why: z.string().min(1), ends: z.string().min(1) })

const Split = z.object({ outcome: z.literal('split'), parts: z.array(Part).min(2) })

export type Part = z.infer<typeof Part>

export const TEST = /(^|\/)(tests?|spec|__tests__|fixtures)\/|[._](test|spec)\.|Tests?\./

export interface Refused {
  span: string
  reason: string
}

/**
 * The fence a seat ends with when the ask cannot be briefed against the code: the question goes back to the COO.
 * A reply with neither a fence nor a title is the same question in prose (#212), never a failed title check.
 */
export function unclear(reply: string): string | null {
  const fence = fenceOf(reply)
  if (fence === null) return titleOf(reply) === null && reply.trim() !== '' ? reply.trim() : null
  const parsed = Unclear.safeParse(yamlOf(fence))
  return parsed.success ? parsed.data.question : null
}

/** #72: the fence a seat ends with when the ask is more than one job: the parts, in the order they must land. */
export function split(reply: string): Part[] | null {
  const fence = fenceOf(reply)
  if (fence === null) return null
  const parsed = Split.safeParse(yamlOf(fence))
  return parsed.success ? parsed.data.parts : null
}

/** The fence a reply ends with, whether or not the seat wrapped it in a code block (#212: plans 71 and 78). */
function fenceOf(reply: string): string | null {
  const bare = reply.trimEnd().replace(/\n```\s*$/, '').replace(/```[a-z]*\r?\n(?=---\r?\n(?:(?!```)[\s\S])*$)/, '')
  return /---\r?\n([\s\S]*?)\r?\n---$/.exec(bare.trimEnd())?.[1] ?? null
}

/** How many files other than tests the brief touches, when that is more than one job holds. */
export function wide(brief: string): number | null {
  const count = files(brief).filter((f) => !TEST.test(f.path)).length
  return count > WIDE ? count : null
}

/** The span of the brief a builder cannot work from, with the ground it is turned back on; null is a brief that stands. */
export function shape(brief: string, ask: string, src: string): Refused | null {
  const title = titleOf(brief)
  if (title === null || title !== titleOf(ask)) return { span: '# <title>', reason: "the title is not the ask's" }
  const checks: ((b: string) => Refused | null)[] =
    [order, empty, carried, cases, caps, folders, forbidden, shared, (b) => paths(b, src)]
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

/** A ground a line asks for: a `code` name is not an ask, and neither is a line saying the thing must not happen (plan 82). */
function asked(body: string, pattern: RegExp): string | undefined {
  for (const line of body.split('\n')) {
    const prose = line.replace(/`[^`\n]*`/g, '``')
    const hit = pattern.exec(prose)
    if (hit !== null && !NEGATED.test(prose.slice(0, hit.index + hit[0].length))) return hit[0]
  }
  return undefined
}

function shared(brief: string): Refused | null {
  const changing = files(brief).map((f) => f.path)
  const listed = [...changing, ...leads(brief, '## Who else reads what this changes')]
  for (const format of SHARED.filter((f) => f.files.some((p) => changing.includes(p)))) {
    const unlisted = format.readers.find((r) => !listed.includes(r))
    if (unlisted !== undefined) return { span: unlisted, reason: `${unlisted} reads ${format.what} and is named nowhere` }
    const other = changing.find((p) => !format.files.includes(p) && !format.readers.includes(p) && !TEST.test(p))
    if (other !== undefined) return { span: other, reason: `${format.what} and ${other} are two jobs in one brief` }
  }
  return null
}

function paths(brief: string, src: string): Refused | null {
  const named = [...files(brief), ...leads(brief, '## Files to read').map((path) => ({ path, is_new: false }))]
  for (const { path, is_new } of named) {
    if (is_new !== existsSync(join(src, path))) continue
    const ground = is_new ? 'is marked (new) and is already in the tree' : 'is not in the checkout'
    return { span: path, reason: `${path} ${ground}` }
  }
  return null
}

/** A path with the line it points at, anywhere on a `## Files` row: `` `a/b.rb:197` ``. */
const POINTED = /([A-Za-z0-9_.+-]*\/[A-Za-z0-9_./+-]*\.[A-Za-z0-9]+):(\d+)/g

/** Each line a `## Files` row points at, so a long file is handed by its block (#67). */
export function pointed(brief: string, heading = '## Files'): { path: string; line: number }[] {
  return section(brief, heading).split('\n').filter((l) => /^\s*[-*]/.test(l))
    .flatMap((l) => [...l.matchAll(POINTED)].map((m) => ({ path: String(m[1]), line: Number(m[2]) })))
}

/** #203b: the reference a port must match, each line a `## Must not break` row points at outside the files the job changes. */
export function references(brief: string): { path: string; line: number }[] {
  const changing = new Set(files(brief).map((f) => f.path))
  return pointed(brief, '## Must not break').filter((p) => !changing.has(p.path))
}

/** A path in backticks anywhere on a `## Files` row; the directory in it is what tells it from a symbol. */
const TICKED = /`([A-Za-z0-9_.+-]*\/[A-Za-z0-9_./+-]*\.[A-Za-z0-9]+)(?::[\d,-]+)?`/g

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
 * Each known key's value is read as one quoted string first. As plain YAML, `: ` breaks the parse (plan 77) and
 * ` #` silently ends the value: plan 114's question "Has #3a landed" reached the COO as "Has". A value that runs
 * onto a second line does not survive the quoting, and is read as plain YAML instead.
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
