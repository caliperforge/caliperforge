import { parse } from 'yaml'

/**
 * Each prose key's value is read as one quoted string first, as `brief.ts` reads the brief writer's fence.
 * As plain YAML ` #` starts a comment, so a value that opens with `#` reads as nothing.
 * A value that runs onto a second line does not survive the quoting and is read as plain YAML.
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
