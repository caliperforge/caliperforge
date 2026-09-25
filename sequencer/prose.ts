import { parse } from 'yaml'

/**
 * #275: each prose key's value is read as one quoted string first, as `brief.ts` reads the brief writer's fence.
 * As plain YAML ` #` starts a comment, so "#37 landed" reached the store as nothing and the fixer's answer on
 * plan 146 was unreadable. A value that runs onto a second line does not survive the quoting and is read as plain YAML.
 */
export function prose(fence: string, keys: readonly string[]): unknown {
  const key = new RegExp(`^(\\s*(?:${keys.join('|')}):[ \\t]+)(?!["'|>\\[{])(.+)$`, 'gm')
  const quoted = fence.replace(key, (...m: string[]) => `${m[1] ?? ''}${JSON.stringify((m[2] ?? '').trim())}`)
  for (const each of [quoted, fence]) {
    try {
      return parse(each) as unknown
    } catch {
      continue
    }
  }
  return null
}
