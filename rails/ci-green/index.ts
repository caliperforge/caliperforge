import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Verdict } from '../record.ts'

const Runs = z.array(z.object({
  headSha: z.string(),
  status: z.string(),
  conclusion: z.string(),
  url: z.string(),
}))

const QUALIFIED = /\b([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#\d+\b/g
const URL = /https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/\d+/g
const BARE = /(?:^|[^A-Za-z0-9._/-])#\d+\b/

export interface Head {
  fork: string
  branch: string
  sha: string
}

export interface Text {
  body: string
  commits: string[]
}

export type Gh = (args: string[]) => string

export function ciGreen(head: Head, text: Text, gh: Gh = shell): Verdict {
  const ours = head.fork.split('/')[0] ?? head.fork
  const spans = [...run(head, gh), ...upstream(text, ours)]
  const subject_digest = createHash('sha256').update(`${head.fork}\n${head.branch}\n${head.sha}`).digest('hex')
  if (spans.length === 0) return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest, spans, message: `${head.fork}@${head.sha} is green and names no upstream number` }
  return {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'ci-green',
    subject_digest,
    spans,
    message: `${String(spans.length)} span(s): fork CI not green for the branch head, or an upstream number named`,
  }
}

function run(head: Head, gh: Gh): string[] {
  const listed = Runs.safeParse(JSON.parse(gh([
    'run', 'list', '--repo', head.fork, '--branch', head.branch,
    '--limit', '1', '--json', 'headSha,status,conclusion,url',
  ])))
  if (!listed.success) return [`${head.fork}:${head.branch} ci.unreadable`]
  const last = listed.data[0]
  if (last?.headSha !== head.sha) return [`${head.fork}:${head.sha} ci.missing`]
  if (last.status !== 'completed') return [`${last.url} ci.pending`]
  return last.conclusion === 'success' ? [] : [`${last.url} ci.red`]
}

function upstream(text: Text, ours: string): string[] {
  return [
    ...lines(text.body).filter((l) => foreign(l.text, ours)).map((l) => `body:${String(l.at)} upstream.number`),
    ...text.commits.map((text, index) => ({ text, at: index + 1 })).filter((c) => foreign(c.text, ours)).map((c) => `commit:${String(c.at)} upstream.number`),
  ]
}

function lines(text: string): { text: string; at: number }[] {
  return text.split('\n').map((line, index) => ({ text: line, at: index + 1 }))
}

function foreign(text: string, ours: string): boolean {
  const qualified = [...text.matchAll(QUALIFIED), ...text.matchAll(URL)]
  return qualified.some((m) => m[1] !== ours) || BARE.test(text)
}

function shell(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' })
}
