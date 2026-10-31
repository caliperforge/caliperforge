import { z } from 'zod'
import { WINDOW, type Read } from '../cli/gh.ts'
import { logins } from '../cli/measure.ts'
import { eventsOf } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { held, needsCeo, type PlanRow } from '../store/plans.ts'
import { setTargetState } from '../store/targets.ts'
import type { Check, Row } from './card.ts'
import type { Outcome } from './kind.ts'
import type { Target } from './ready.ts'
import { maybe, put } from './workspace.ts'

const Login = z.object({ login: z.string() })
const Tree = z.object({ tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() })) })
const Blob = z.object({ content: z.string() })
const Comments = z.array(z.object({ body: z.string(), html_url: z.string(), author_association: z.string() }))
const Merged = z.array(z.object({ url: z.string(), author: Login.nullable(), mergedBy: Login.nullable(), body: z.string() }))

const NAMED = /^(?:contributing|code_of_conduct|pull_request_template)/i
const TEMPLATES = /^\.github\/pull_request_template\//i
const POLICY = /(?:^|[^A-Za-z])(?:AI|LLM)(?:[^A-Za-z]|$)/
const MAINTAINERS = ['OWNER', 'MEMBER', 'COLLABORATOR']
const ABOUT = /\b(?:AI|LLMs?|agents?|Copilot|ChatGPT|Claude|(?:AI|machine)[- ]generated|generated code)\b/i
const NO = /\b(?:no|not|never|won't|don't|cannot|refuse[sd]?|reject(?:ed)?|prohibit(?:ed)?|forbid(?:den)?|ban(?:ned)?)\b/i
const YES = /\b(?:welcome[sd]?|accept(?:s|ed)?|allow(?:s|ed)?|permit(?:s|ted)?)\b/i
const DISCLOSED = /co-authored-by: (?:claude|copilot)|generated with \[?claude code|\b(?:AI|LLM)[- ](?:assisted|generated)\b/i
const DAYS = 90
const LINE = /^- ai stance: (open|closed|unstated) — (.*)$/gm

type Stance = 'open' | 'closed' | 'unstated'
interface Said { line: string; link: string }

export function stanceOf(repo: string, no: number, read: Read, now = new Date()): { stance: Stance; says: string } {
  const files = Tree.parse(read(['api', `repos/${repo}/git/trees/HEAD?recursive=1`])).tree.filter((t) => t.type === 'blob' && wanted(t.path))
  const comments = maintained(repo, no, read)
  const outside = merges(repo, read, now)
  const lines = [
    ...files.flatMap((f) => linesOf(Buffer.from(Blob.parse(read(['api', `repos/${repo}/git/blobs/${f.sha}`])).content, 'base64').toString('utf8'),
      (n) => `https://github.com/${repo}/blob/HEAD/${f.path}#L${String(n)}`)),
    ...comments.flatMap((c) => linesOf(c.body, () => c.html_url)),
  ].filter((s) => ABOUT.test(s.line))
  const closed = lines.filter((s) => NO.test(s.line))
  if (closed.length > 0) return { stance: 'closed', says: cite(closed) }
  const open = [...lines.filter((s) => YES.test(s.line)), ...outside.flatMap((p) => linesOf(p.body, () => p.url).filter((s) => DISCLOSED.test(s.line)))]
  if (open.length > 0) return { stance: 'open', says: cite(open) }
  return { stance: 'unstated', says: `no statement in ${String(files.length)} files, ${String(comments.length)} maintainer comments, `
    + `${String(outside.length)} outside merges in ${String(DAYS)} days` }
}

export function stood(db: Db, root: string, plan: PlanRow, { repo, issue_no }: Target, read: Read, span: string, pulse: string): Outcome {
  const { stance, says } = stanceOf(repo, issue_no, read)
  const said = `ai stance: ${stance} — ${says}`
  const asking = stance === 'unstated' && !eventsOf(db, plan.id, 'return').some((e) => e.actor === 'ceo')
  const first = `\n## Ask first\n\nDraft for the CEO to post on https://github.com/${repo}/issues/${String(issue_no)}; nothing is built until a maintainer says yes:\n\n`
    + '> Would you accept a pull request for this issue written with AI assistance and reviewed by a person before it is opened? We will not start without your yes.\n'
  put(root, plan.id, 'ask.md', `${maybe(root, plan.id, 'ask.md') ?? ''}- ${said}\n${asking ? first : ''}`)
  if (stance === 'closed') {
    setTargetState(db, plan.target_id, 'refused')
    return { outcome: 'refuse', held: true, spans: [span], note: said }
  }
  if (!asking) return { outcome: 'pass', spans: [], note: `${pulse}; ${said}` }
  needsCeo(db, plan, 'ai stance unstated')
  held(db, plan.id, 'ceo', 'ai stance unstated')
  return { outcome: 'pass', held: true, spans: [span], note: `${said}; held for the ceo to ask first` }
}

function wanted(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return NAMED.test(name) || TEMPLATES.test(path) || POLICY.test(name)
}

function maintained(repo: string, no: number, read: Read): z.infer<typeof Comments> {
  const all = [`repos/${repo}/issues/${String(no)}/comments`, `repos/${repo}/issues/comments?sort=created&direction=desc&per_page=100`]
    .flatMap((path) => Comments.parse(read(['api', path])))
  return [...new Map(all.filter((c) => MAINTAINERS.includes(c.author_association)).map((c) => [c.html_url, c])).values()]
}

function merges(repo: string, read: Read, now: Date): z.infer<typeof Merged> {
  const since = new Date(now.getTime() - DAYS * 86_400_000).toISOString().slice(0, 10)
  const merged = Merged.parse(read(['pr', 'list', '--repo', repo, '--state', 'merged', '--search', `merged:>=${since}`,
    '--limit', String(WINDOW), '--json', 'url,author,mergedBy,body']))
  const mergers = logins(merged.map((p) => p.mergedBy))
  return merged.filter((p) => p.author !== null && !mergers.includes(p.author.login))
}

function linesOf(text: string, link: (n: number) => string): Said[] {
  return text.split('\n').map((line, i) => ({ line: line.trim(), link: link(i + 1) }))
}

function cite(said: Said[]): string {
  return said.map((s) => `"${s.line}" ${s.link}`).join('; ')
}

export function stance(...[, root, plan]: Parameters<Check>): Row {
  const last = [...(maybe(root, plan, 'ask.md') ?? '').matchAll(LINE)].at(-1)
  if (last === undefined) return { check: 'ai stance', ok: false, says: 'not read at step 0' }
  return { check: 'ai stance', ok: last[1] !== 'closed', says: `${String(last[1])} — ${String(last[2])}` }
}
