import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { Check, Finding } from './kind.ts'
import { walk } from './tree.ts'

const METRICS = ['citing-comment', 'lines', 'prepare', 'silent-catch', 'test-name'] as const
type Metric = typeof METRICS[number]
type Tally = Partial<Record<Metric, number>>
export type Counts = Record<string, Tally>

const FIX: Record<Metric, string> = {
  'citing-comment': 'drop the ticket, date, name or plan number from the comment',
  lines: 'move the new function to a new file',
  prepare: 'move the query into store/',
  'silent-catch': 'rethrow or record an event with logged()',
  'test-name': 'shorten the test name to 60 characters',
}

const CITING = /#\d+|\b\d{4}-\d{2}-\d{2}\b|\b\d{2}-\d{2}\b|\bCEO\b|\bCOO\b|\bplan \d+/

const COMMENT = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
])

export const ratchet: Check = {
  name: 'ratchet',
  run: (root: string) => Promise.resolve(judged(counts(root), recorded(root))),
}

export function counts(root: string): Counts {
  const out: Counts = {}
  for (const file of walk(root, (f) => f.endsWith('.ts')).sort()) {
    const path = file.slice(root.length + 1)
    const tally = inFile(path, readFileSync(file, 'utf8'))
    if (Object.keys(tally).length > 0) out[path] = tally
  }
  return out
}

function recorded(root: string): Counts {
  const file = join(root, 'ratchet.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Counts : {}
}

function inFile(path: string, text: string): Tally {
  const test = path.endsWith('.test.ts') || path.split('/').includes('tests')
  const nodes = descendants(ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true))
  const all: Record<Metric, number> = {
    'citing-comment': comments(text).filter((c) => CITING.test(c)).length,
    lines: test ? 0 : text.trimEnd().split('\n').length,
    prepare: path.startsWith('store/') ? 0 : text.split('db.prepare(').length - 1,
    'silent-catch': nodes.filter((n) => ts.isCatchClause(n) && !descendants(n.block).some(handles)).length,
    'test-name': test ? nodes.filter(longName).length : 0,
  }
  return Object.fromEntries(METRICS.filter((m) => all[m] > 0).map((m) => [m, all[m]]))
}

function descendants(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = []
  const visit = (n: ts.Node): void => {
    out.push(n)
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(node, visit)
  return out
}

function calls(n: ts.Node, names: string[]): n is ts.CallExpression {
  return ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.includes(n.expression.text)
}

function handles(n: ts.Node): boolean {
  return ts.isThrowStatement(n) || calls(n, ['logged'])
}

function longName(n: ts.Node): boolean {
  if (!calls(n, ['it', 'test', 'describe'])) return false
  const name = n.arguments[0]
  return name !== undefined && ts.isStringLiteralLike(name) && name.text.length > 60
}

function comments(text: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.ESNext, false, ts.LanguageVariant.Standard, text)
  const out: string[] = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (COMMENT.has(token)) out.push(scanner.getTokenText())
  }
  return out
}

function judged(now: Counts, then: Counts): Finding[] {
  const paths = [...new Set([...Object.keys(then), ...Object.keys(now)])]
  return paths.flatMap((path) => METRICS.flatMap((metric) => verdict(path, metric, now[path]?.[metric] ?? 0, then[path])))
}

function verdict(path: string, metric: Metric, count: number, was: Tally | undefined): Finding[] {
  const seen = was?.[metric] ?? 0
  const budget = metric === 'lines' && was === undefined ? 300 : seen + (metric === 'lines' ? 30 : 0)
  if (count > budget) return [refusal(path, `${path} ${metric} ${String(count)} over budget ${String(budget)}: ${FIX[metric]}`)]
  if (count < seen) return [refusal(path, `lower ratchet.json ${path} ${metric} to ${String(count)}`)]
  return []
}

function refusal(path: string, message: string): Finding {
  return { check: 'ratchet', path, line: 1, message }
}
