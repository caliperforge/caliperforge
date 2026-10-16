import { CEILING, ROW, section, shape, type Refused } from './brief.ts'

/** The line count of a brief whose one fault is its length; null when it is short enough or wrong some other way. */
export function overlong(brief: string, ask: string, src: string, outside: boolean): number | null {
  const lines = brief.trimEnd().split('\n').length
  return lines > CEILING && shape(brief, ask, src, outside, Infinity) === null ? lines : null
}

/** The packet that asks for the same brief, shorter: it opens on the brief, so the brief's title is its first heading. */
export function trim(brief: string, lines: number): string {
  return `${brief.trimEnd()}\n\n# Trim it\n\nThis brief is ${String(lines)} lines and the ceiling is ${String(CEILING)}: cut at least ${String(lines - CEILING)} lines. `
    + 'Answer with the same brief: the same title, every section, every D row, and `## Standing` unchanged. There is no checkout, so read nothing and add nothing.\n'
}

/** The first heading, then the first D row, of the brief before the trim that the trimmed brief lacks. */
export function trimmed(before: string, after: string): Refused | null {
  const items = (b: string): string[] => [...b.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.trimEnd()),
    ...(section(b, '## Cases').match(ROW) ?? []).flatMap((r) => /D\d+/.exec(r) ?? [])]
  const kept = items(after)
  const missing = items(before).find((item) => !kept.includes(item))
  return missing === undefined ? null : { span: missing, reason: `the trim dropped ${missing}` }
}
