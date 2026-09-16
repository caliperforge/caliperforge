import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { Check, Finding } from './kind.ts'
import { lineOf, walk } from './tree.ts'

const JUSTIFYING = /because|in order to|note that|this is needed|to ensure/i

const COMMENT = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
])

export const tight: Check = {
  name: 'tight',
  run: (root: string) => Promise.resolve(findings(root)),
}

function findings(root: string): Finding[] {
  const prose = [...walk(join(root, 'docs/adr'), md), ...walk(join(root, 'rules'), md)]
  return [
    ...walk(root, (f) => f.endsWith('.ts')).flatMap((f) => inSource(root, f)),
    ...prose.flatMap((f) => inProse(root, f)),
  ]
}

function md(name: string): boolean {
  return name.endsWith('.md')
}

function inProse(root: string, file: string): Finding[] {
  const path = file.slice(root.length + 1)
  const lines = readFileSync(file, 'utf8').split('\n')
  const exempt = path.startsWith('docs/adr/') ? context(lines) : { from: 0, to: 0 }
  return lines
    .map((text, index) => ({ text, line: index + 1 }))
    .filter((l) => JUSTIFYING.test(l.text) && (l.line < exempt.from || l.line > exempt.to))
    .map((l) => finding(path, l.line, 'justifying pattern'))
}

function context(lines: string[]): { from: number; to: number } {
  const start = lines.indexOf('## Context')
  if (start === -1) return { from: 0, to: 0 }
  const after = lines.slice(start + 1).findIndex((l) => l.startsWith('## '))
  return { from: start + 1, to: after === -1 ? lines.length : start + 1 + after }
}

function inSource(root: string, file: string): Finding[] {
  const text = readFileSync(file, 'utf8')
  const path = file.slice(root.length + 1)
  return comments(text).flatMap((c) => {
    if (JUSTIFYING.test(c.text)) return [finding(path, c.line, 'justifying comment')]
    if (restates(c.text, subject(text, c))) return [finding(path, c.line, 'comment restates its line')]
    return []
  })
}

function comments(text: string): { line: number; text: string; end: number }[] {
  const scanner = ts.createScanner(ts.ScriptTarget.ESNext, false, ts.LanguageVariant.Standard, text)
  const out: { line: number; text: string; end: number }[] = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (!COMMENT.has(token)) continue
    out.push({ line: lineOf(text, scanner.getTokenStart()), text: scanner.getTokenText(), end: scanner.getTokenEnd() })
  }
  return out
}

function subject(text: string, comment: { end: number }): string {
  const rest = text.slice(comment.end).split('\n')
  return (rest[0] ?? '').trim() || (rest.find((l) => l.trim() !== '') ?? '')
}

function restates(comment: string, code: string): boolean {
  const said = words(comment.replace(/^\/[/*]+/, '').replace(/\*\/$/, ''))
  if (said.size < 2) return false
  const wrote = words(code.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' '))
  return [...said].every((w) => wrote.has(w))
}

function words(source: string): Set<string> {
  return new Set((source.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []).filter((w) => w.length > 1))
}

function finding(path: string, line: number, message: string): Finding {
  return { check: 'tight', path, line, message }
}
