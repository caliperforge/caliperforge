import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { walk } from '../checks/tree.ts'
import { exported } from '../rails/tight/source.ts'
import { declaredNames } from '../reviews/package.ts'
import { TEST } from '../sequencer/brief.ts'

export function map(root: string): string {
  const paths = walk(root, (n) => n.endsWith('.ts')).map((p) => relative(root, p)).filter((p) => !TEST.test(p)).sort()
  return `# MAP.md — written by \`cf digests\`\n\n${paths.map((p) => entry(p, readFileSync(join(root, p), 'utf8'))).join('')}`
}

function entry(path: string, text: string): string {
  const src = ts.createSourceFile('subject.ts', text, ts.ScriptTarget.ESNext, true)
  const head = purpose(text)
  const names = src.statements.filter(exported).flatMap(declaredNames)
  return `- \`${path}\`${head === '' ? '' : ` — ${head}`}\n${names.map((n) => `  - ${n}\n`).join('')}`
}

function purpose(text: string): string {
  const [first] = ts.getLeadingCommentRanges(text, 0) ?? []
  if (first === undefined) return ''
  return text.slice(first.pos, first.end).split('\n')
    .map((l) => l.replace(/^\s*(?:\/\*\*?|\/\/|\*(?!\/))?/, '').replace(/\*\/\s*$/, '').trim())
    .find((l) => l !== '') ?? ''
}
