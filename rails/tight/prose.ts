import { basename } from 'node:path'
import type { Span } from './source.ts'

const PREAMBLE = /^(?:sure|certainly|of course|let me|here(?:'s| is)|i(?:'ve| have| will)\b|as requested|in this (?:pr|change|commit)|this (?:pr|change|commit|patch) (?:adds|does|makes|contains|introduces))/i

const HEDGE = /\b(?:maybe|perhaps|possibly|probably|arguably|somewhat|hopefully|presumably|it seems|i think|a bit|fairly|quite|should generally|more or less)\b/i

const STAT = /\b\d+ (?:files? changed|insertions?|deletions?|lines? (?:added|removed|changed))\b/i

const VERB = /\b(?:adds?|added|updates?|updated|changes?|changed|modif(?:y|ies|ied)|removes?|removed|renames?|renamed|touch(?:es|ed)?)\b/i

interface Said {
  text: string
  line: number
}

export function inProse(description: string, paths: string[]): Span[] {
  const names = new Set(paths.flatMap((p) => [p, basename(p)]))
  const lines = description.split('\n')
    .map((text, index) => ({ text: text.trim().replace(/^#+\s*/, ''), line: index + 1 }))
    .filter((l) => l.text !== '')
  const opener = lines[0]?.line ?? 0
  return lines.flatMap((l) => judge(l, names, opener))
}

function judge(l: Said, names: Set<string>, opener: number): Span[] {
  return [
    ...(l.line === opener && PREAMBLE.test(l.text) ? [{ line: l.line, kind: 'tight.preamble' }] : []),
    ...(HEDGE.test(l.text) ? [{ line: l.line, kind: 'tight.hedge' }] : []),
    ...(summarises(l.text, names) ? [{ line: l.line, kind: 'tight.summary' }] : []),
  ]
}

function summarises(text: string, names: Set<string>): boolean {
  if (STAT.test(text)) return true
  if (!VERB.test(text)) return false
  return (text.match(/[A-Za-z0-9_./-]+/g) ?? []).some((w) => names.has(w) || names.has(basename(w)))
}
