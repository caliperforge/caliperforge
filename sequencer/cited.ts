const SKIP = /stays|must not|no builder touches|not this job's|do not/i

/** The paths the newest ruling block of `rulings.md` names, leaving out its lines that say not to touch them. */
export function cited(rulings: string): string[] {
  return [...newest(rulings).split('\n').filter((l) => !SKIP.test(l)).join('\n').matchAll(/`([^`\s]+)`/g)]
    .map((m) => (m[1] ?? '').replace(/:\d+(?:-\d+)?$/, '')).filter((t) => (t.includes('/') || /\.\w+$/.test(t)) && !/[<>]/.test(t))
}

/** The newest ruling block of `rulings.md`: from its last `**Ruling` or `## ` line, else the whole file. */
export function newest(rulings: string): string {
  const lines = rulings.split('\n')
  return lines.slice(Math.max(0, lines.findLastIndex((l) => l.startsWith('**Ruling') || l.startsWith('## ')))).join('\n')
}
