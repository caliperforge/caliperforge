import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { parse, type Line } from '../diff.ts'
import type { Verdict } from '../record.ts'

const PATTERNS: [string, RegExp][] = [
  ['secret.aws_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['secret.github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['secret.api_key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['secret.private_key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['secret.slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['secret.assignment', /(?:api[_-]?key|secret|token|password|passwd)["'\s]*[:=]\s*["'][A-Za-z0-9/+_-]{16,}["']/i],
]

const ENV_FILE = /^\.env(?:\.(?!example$|sample$|template$).+)?$/
const EXEMPT = /(?:^|\/)fixtures\/|^rails\/[^/]+\/tests\//

export function scan(diff: string): Verdict {
  const files = parse(diff).filter((f) => !EXEMPT.test(f.path))
  const spans = [
    ...files.filter((f) => !f.deleted && ENV_FILE.test(basename(f.path))).map((f) => `${f.path}:1 secret.env_file`),
    ...files.flatMap((f) => f.added).flatMap(matched),
  ]
  const subject_digest = createHash('sha256').update(diff).digest('hex')
  if (spans.length === 0) return { outcome: 'pass', origin_kind: null, origin_ref: null, subject_digest, spans, message: `${String(files.length)} file(s) carry no key, token or .env` }
  return {
    outcome: 'refuse',
    origin_kind: 'rail',
    origin_ref: 'secret-scan',
    subject_digest,
    spans,
    message: `${String(spans.length)} span(s) carry a credential the diff must not add`,
  }
}

function matched(line: Line): string[] {
  return PATTERNS.filter(([, pattern]) => pattern.test(line.text)).map(([name]) => `${line.path}:${String(line.line)} ${name}`)
}
