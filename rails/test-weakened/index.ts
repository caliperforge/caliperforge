import { createHash } from 'node:crypto'
import { parse, type FileDiff, type Line } from '../diff.ts'
import type { Verdict } from '../record.ts'

const TEST_FILE = /(?:^|\/)tests?\/|\.(?:test|spec)\.[jt]sx?$/
const ASSERT = /\b(?:expect|assert)\s*\(/
const STRICT = /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toMatchInlineSnapshot|toHaveBeenCalledWith|toThrowError|toContain)\s*\(/
const LOOSE = /\.(?:toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined|toBeNull)\s*\(\s*\)|\bexpect\.(?:anything|any)\s*\(/
const SKIPPED = /\b(?:test|it|describe)\.(?:skip|todo|failing)\b|\bx(?:it|describe)\s*\(/

export function weakened(diff: string, suite: 'green' | 'red'): Verdict {
  const spans = parse(diff).filter((f) => TEST_FILE.test(f.path)).flatMap(judge)
  const subject_digest = createHash('sha256').update(`${diff}\n${suite}`).digest('hex')
  if (spans.length === 0 || suite === 'red') {
    return { outcome: 'pass', origin_kind: null, origin_ref: null, subject_digest, spans, message: message(spans.length, suite) }
  }
  return {
    outcome: 'refuse',
    origin_kind: 'rail',
    origin_ref: 'test-weakened',
    subject_digest,
    spans,
    message: `${String(spans.length)} assertion(s) removed, loosened or skipped while the suite went green`,
  }
}

function judge(file: FileDiff): string[] {
  if (file.deleted) return [gone(file)]
  const removed = file.removed.filter((l) => ASSERT.test(l.text))
  const added = file.added.filter((l) => ASSERT.test(l.text))
  const loose = file.added.filter((l) => LOOSE.test(l.text))
  const downgraded = count(file.removed, STRICT) > count(file.added, STRICT) && loose.length > 0
  return [
    ...(removed.length > added.length ? [span(removed[0], 'test.weakened.removed')] : []),
    ...(downgraded ? [span(loose[0], 'test.weakened.loosened')] : []),
    ...file.added.filter((l) => SKIPPED.test(l.text)).map((l) => span(l, 'test.weakened.skipped')),
  ]
}

function gone(file: FileDiff): string {
  const first = file.removed.find((l) => ASSERT.test(l.text))
  return `${file.path}:${String(first?.line ?? 1)} test.weakened.removed`
}

function count(lines: Line[], pattern: RegExp): number {
  return lines.filter((l) => pattern.test(l.text)).length
}

function span(line: Line | undefined, kind: string): string {
  return line === undefined ? `unknown:1 ${kind}` : `${line.path}:${String(line.line)} ${kind}`
}

function message(spans: number, suite: string): string {
  if (spans === 0) return 'no assertion was removed, loosened or skipped'
  return `${String(spans)} weakened span(s) carried by a ${suite} suite`
}
