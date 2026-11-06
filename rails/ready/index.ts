import { createHash } from 'node:crypto'
import type { Verdict } from '../record.ts'

export interface Proof {
  repo: string
  /** Our own repository: nobody measures us, so there is no account pulse to read. */
  ours: boolean
  at: string
  tests_pass: boolean
  byte_identical_elsewhere: boolean
  bot_clean: boolean
  ci: Verdict
  spans: string[]
  title: string
  /** The ask's text and the diff's added lines. */
  named: string
  body: string
  template: string | null
  /** The line the body must carry, where their profile requires one. */
  closes: string | null
}

export function ready(proof: Proof): Verdict {
  const spans = [
    ...(proof.tests_pass ? [] : ['tests:1 ready.tests']),
    ...(proof.byte_identical_elsewhere ? [] : ['tree:1 ready.byte_identical']),
    ...(proof.ci.outcome === 'pass' ? [] : proof.ci.spans),
    ...(proof.bot_clean ? [] : ['bot:1 ready.bot_clean']),
    ...(proof.ours || !clipped(proof.title, proof.named) ? [] : ['title:1 ready.title_clipped']),
    ...unfilled(proof),
    ...(proof.spans.length === 0 ? ['spans:1 no.anchor'] : []),
  ]
  const subject_digest = digest(proof)
  if (spans.length === 0) {
    return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest, spans, message: `${proof.repo} is green, confined to ${String(proof.spans.length)} named span(s)` }
  }
  return {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'ready',
    subject_digest,
    spans,
    message: `${String(spans.length)} span(s) keep the deliverable out of the batch`,
  }
}

/** A title ending on a code-shaped word that some longer name in the ask or diff starts with. */
function clipped(title: string, named: string): boolean {
  const last = /([A-Za-z_][A-Za-z0-9_]*)\W*$/.exec(title)?.[1]
  if (last === undefined || !/_|[a-z][A-Z]/.test(last)) return false
  return (named.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).some((t) => t.length > last.length && t.startsWith(last))
}

/** A heading's section runs to the next heading of the same or a shallower depth; a line that is no heading is deeper than any. */
const depth = (line: string): number => /^(#{1,6})\s/.exec(line)?.[1]?.length ?? 7

function unfilled(proof: Proof): string[] {
  const body = proof.body.split('\n').map((l) => l.trim())
  const headings = (proof.template ?? '').split('\n').flatMap((l, i) => (depth(l) < 7 ? [[l.trim(), i + 1] as const] : []))
  const sections = headings.flatMap(([heading, line]) => {
    const at = body.indexOf(heading)
    if (at === -1) return [`template:${String(line)} ready.template_missing`]
    const end = body.findIndex((l, i) => i > at && depth(l) <= depth(heading))
    const text = body.slice(at + 1, end === -1 ? undefined : end).join('\n').replace(/<!--[\s\S]*?-->/g, '')
    return text.trim() === '' ? [`body:${String(at + 1)} ready.template_empty`] : []
  })
  const closed = proof.closes === null || new RegExp(`${proof.closes}(?!\\d)`).test(proof.body)
  return [...sections, ...(closed ? [] : ['body:1 ready.closing'])]
}

function digest(proof: Proof): string {
  return createHash('sha256')
    .update([proof.repo, proof.at, proof.spans.join(','), proof.ci.subject_digest].join('\n'))
    .digest('hex')
}
