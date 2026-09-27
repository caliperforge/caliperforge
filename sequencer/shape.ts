import type { Profile } from '../store/profile.ts'

export function clean(s: string, rules: Profile | null = null): string {
  const number = rules?.issue_ref === 'Fixes' ? /(?<!Fixes )#\d+/g : /#\d+/g
  return s.replace(number, '').replace(/\s+/g, ' ').trim()
}

/** Under `package`, `type(scope)!: Rest` becomes `scope: rest`. */
export function subjectOf(title: string, rules: Profile | null = null): string {
  const subject = clean(title, rules)
  const conventional = rules?.subject === 'package' ? /^[a-z]+\(([^)]+)\)!?:\s*(\S)(.*)$/.exec(subject) : null
  if (conventional === null) return subject
  const [, scope = '', first = '', rest = ''] = conventional
  return `${scope}: ${first.toLowerCase()}${rest}`
}
