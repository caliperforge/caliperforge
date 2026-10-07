import type { Profile } from '../store/profile.ts'
import { clean } from './shape.ts'
import { maybe, PR_HEAD, put } from './workspace.ts'

export function signedAt(root: string, plan: number, sha: string): string {
  const [folded, signed] = (maybe(root, plan, PR_HEAD) ?? '').trim().split(' ')
  return folded === sha && signed !== undefined ? signed : sha
}

export function bind(root: string, plan: number, folded: string, signed: string): void {
  put(root, plan, PR_HEAD, `${folded} ${signed}\n`)
}

/** The PR title over the first line of the body's Summary, cleaned as `messageOf` cleans. */
export function prMessage(title: string, text: string, rules: Profile | null = null): string {
  const summary = /^## Summary$(?:\n(?!## ).*)*?\n- (.*)$/m.exec(text)?.[1] ?? ''
  const trailer = rules?.ai_trailer === true ? rules.trailer ?? '' : ''
  return [clean(title, rules), clean(summary, rules), trailer].filter((p) => p !== '').join('\n\n')
}
