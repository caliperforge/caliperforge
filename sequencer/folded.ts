import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { carried } from '../rails/completion-audit/index.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import type { Profile } from '../store/profile.ts'
import { listed } from './listed.ts'
import { messageOf, title } from './push.ts'
import { clean, subjectOf } from './shape.ts'
import { maybe, planDir, PR_HEAD, put } from './workspace.ts'

export function signedAt(root: string, plan: number, sha: string): string {
  const [folded, signed] = (maybe(root, plan, PR_HEAD) ?? '').trim().split(' ')
  return folded === sha && signed !== undefined ? signed : sha
}

export function bind(root: string, plan: number, folded: string, signed: string): void {
  put(root, plan, PR_HEAD, `${folded} ${signed}\n`)
}

/** The PR title over the first line of the body's Summary, else its first paragraph that is no heading, cleaned as `messageOf` cleans. */
export function prMessage(title: string, text: string, rules: Profile | null = null): string {
  const summary = /^## Summary$(?:\n(?!## ).*)*?\n- (.*)$/m.exec(text)?.[1] ?? text.split(/\n\s*\n/).find((p) => !p.startsWith('#')) ?? ''
  const trailer = rules?.ai_trailer === true ? rules.trailer ?? '' : ''
  return [clean(title, rules), clean(summary, rules), trailer].filter((p) => p !== '').join('\n\n')
}

/** The PR title's type and scope over the first finding this hand-back's done G rows fixed, one body line per finding; else `messageOf`, logged once per hand-back. */
export function roundMessage(db: Db, root: string, plan: number, rules: Profile | null = null): string {
  const rows = carried(maybe(root, plan, 'step-2.handback.md') ?? '')
  const done = typeof rows === 'string' ? [] : [...rows].filter(([id, row]) => /^G\d+$/.test(id) && row.status === 'done' && (row.pointer?.trim() ?? '') !== '').map(([id]) => id)
  const found = readdirSync(planDir(root, plan)).flatMap((name) => /^findings-([0-9a-f]{40})\.md$/.exec(name)?.[1] ?? []).flatMap((sha) => listed(root, plan, sha))
  const lines = done.map((id) => ({ id, line: (found.find((f) => f.id === id)?.body ?? '').replace(/<[^>]*>/g, '').replace(/\*\*|__/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ').trim().split(/\.(?= |$)/)[0] ?? '' })).filter(({ line }) => line !== '')
  const [first] = lines
  if (first === undefined) return fellBack(db, root, plan, done.length === 0 ? 'no done G row in step-2.handback.md' : `no listed text for ${done.join(', ')}`, rules)
  const type = /^[a-z]+(?:\([^)]+\))?!?:/.exec(title(root, plan))?.[0]
  const body = lines.map(({ id, line }) => clean(`Greptile ${id}: ${line}`, rules)).join('\n')
  return [subjectOf(type === undefined ? first.line : `${type} ${first.line}`, rules), body, rules?.ai_trailer === true ? rules.trailer ?? '' : ''].filter((p) => p !== '').join('\n\n')
}

function fellBack(db: Db, root: string, plan: number, message: string, rules: Profile | null): string {
  const digest = createHash('sha256').update(maybe(root, plan, 'step-2.handback.md') ?? '').digest('hex')
  if (maybe(root, plan, 'message.fallback') !== digest) {
    put(root, plan, 'message.fallback', digest)
    logged(db, { plan, kind: 'push.message_fallback', actor: 'push', outcome: 'pass', message, pointer: digest, run: null })
  }
  return messageOf(root, plan, rules)
}
