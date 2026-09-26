/** The repo map: every source file, its purpose and its exports, for the seats that read a checkout. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { walk } from '../checks/tree.ts'
import { exported } from '../rails/tight/source.ts'
import { declaredNames } from '../reviews/package.ts'
import { TEST } from '../sequencer/brief.ts'

/** Generated where it is read and never committed: a committed map was touched by every job and held each one behind the next (plan 109). */
export const MAP = 'MAP.md'

const SWIFT = /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|open|internal|fileprivate|private|final|indirect)\s+)*(func|class|struct|enum|protocol|extension)\s+([\w.]+)/

export function map(root: string): string {
  const paths = walk(root, (n) => n.endsWith('.ts') || n.endsWith('.swift')).map((p) => relative(root, p)).filter((p) => !TEST.test(p)).sort()
  return `# MAP.md — written by \`cf map\`\n\n${paths.map((p) => entry(p, readFileSync(join(root, p), 'utf8'))).join('')}`
}

export function write(root: string): string {
  const path = join(root, MAP)
  writeFileSync(path, map(root))
  return path
}

function entry(path: string, text: string): string {
  const head = purpose(text)
  const names = path.endsWith('.swift') ? swiftNames(text) : tsNames(text)
  return `- \`${path}\`${head === '' ? '' : ` — ${head}`}\n${names.map((n) => `  - ${n}\n`).join('')}`
}

function tsNames(text: string): string[] {
  return ts.createSourceFile('subject.ts', text, ts.ScriptTarget.ESNext, true).statements.filter(exported).flatMap(declaredNames)
}

function swiftNames(text: string): string[] {
  return text.split('\n').flatMap((l) => SWIFT.exec(l)?.slice(1, 3).join(' ') ?? [])
}

function purpose(text: string): string {
  const [first] = ts.getLeadingCommentRanges(text, 0) ?? []
  if (first === undefined) return ''
  return text.slice(first.pos, first.end).split('\n')
    .map((l) => l.replace(/^\s*(?:\/\*\*?|\/\/\/?|\*(?!\/))?/, '').replace(/\*\/\s*$/, '').trim())
    .find((l) => l !== '') ?? ''
}
