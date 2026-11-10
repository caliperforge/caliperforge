import type { Profile } from '../store/profile.ts'

export function clean(s: string, rules: Profile | null = null): string {
  const ref = rules?.issue_ref === 'Fixes' ? '(?<!Fixes )#\\d+' : '#\\d+'
  const grouped = new RegExp(`\\s*[(\\[][\\s,]*${ref}(?:[\\s,]+${ref})*[\\s,]*[)\\]]`, 'g')
  const bare = new RegExp(`\\s*${ref}(?=[.,;:!?])|${ref}`, 'g')
  return s.replace(grouped, '').replace(bare, '').replace(/\s+/g, ' ').trim()
}

/** Under `package`, `type(scope)!: Rest` becomes `scope: rest`. */
export function subjectOf(title: string, rules: Profile | null = null): string {
  const subject = clean(title, rules)
  const conventional = rules?.subject === 'package' ? /^[a-z]+\(([^)]+)\)!?:\s*(\S)(.*)$/.exec(subject) : null
  if (conventional === null) return subject
  const [, scope = '', first = '', rest = ''] = conventional
  return `${scope}: ${first.toLowerCase()}${rest}`
}
