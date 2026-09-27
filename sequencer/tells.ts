import { parse } from '../rails/diff.ts'
import { inProse } from '../rails/tight/prose.ts'
import type { Check } from './card.ts'
import { diffOf } from './workspace.ts'

export const TELLS: RegExp[] = [
  /\bdelve\b/i, /\bseamless(?:ly)?\b/i, /\brobust\b/i, /\bleverag(?:e|es|ed|ing)\b/i, /\bcomprehensive\b/i,
  /\bstreamlin(?:e|es|ed|ing)\b/i, /\bit's worth noting\b/i, /\bin (?:summary|conclusion)\b/i, /\bfurthermore\b/i,
  /\bmoreover\b/i, /\badditionally\b/i, /\bcrucial\b/i, /\belevate\b/i, /\bempower\b/i, /\butiliz(?:e|es|ed|ing)\b/i,
  /\bholistic\b/i, /\bgame-changer\b/i, /\bi hope this helps\b/i, /\blet me know\b/i, /—/, /✅/, /🚀/,
]

export function prosed(title: string, body: string): Check {
  return (...[, root, plan]: Parameters<Check>) => {
    const paths = parse(diffOf(root, plan)).map((f) => f.path)
    const hits = [...hitsIn('title', title, paths), ...hitsIn('body', body, paths)]
    return { check: 'prose', ok: hits.length === 0, says: hits.length === 0 ? 'clean' : hits.join('; ') }
  }
}

function hitsIn(part: string, text: string, paths: string[]): string[] {
  const tells = text.split('\n').flatMap((line, index) =>
    TELLS.flatMap((tell) => tell.exec(line)?.[0].toLowerCase() ?? []).map((hit) => ({ line: index + 1, kind: `tell:${hit}` })))
  return [...inProse(text, paths), ...tells].map((s) => `${part}:${String(s.line)} ${s.kind}`)
}
