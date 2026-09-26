import ts from 'typescript'
import { lineOf } from '../../checks/tree.ts'

const JUSTIFYING = /because|in order to|note that|this is needed|to ensure/i

const NESTS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
])

export interface Ceilings {
  function_lines: number
  nesting: number
}

export interface Span {
  line: number
  kind: string
}

export function inSource(text: string, added: Set<number>, ceilings: Ceilings): Span[] {
  const src = ts.createSourceFile('subject.ts', text, ts.ScriptTarget.ESNext, true)
  const uses = counts(src)
  return [
    ...comments(src).filter((c) => added.has(c.line)).flatMap((c) => judgeComment(text, c)),
    ...declared(src).filter((d) => added.has(d.line)).flatMap((d) => judgeDeclaration(d, uses)),
    ...functions(src).filter((f) => touched(src, f, added)).flatMap((f) => judgeSize(src, f, ceilings)),
  ].sort((a, b) => a.line - b.line)
}

function judgeComment(text: string, c: { line: number; text: string; end: number }): Span[] {
  if (JUSTIFYING.test(c.text)) return [{ line: c.line, kind: 'tight.justifying' }]
  return restates(c.text, subject(text, c)) ? [{ line: c.line, kind: 'tight.restating' }] : []
}

function judgeDeclaration(d: Declaration, uses: Map<string, number>): Span[] {
  if ((uses.get(d.name) ?? 0) > 1) return []
  return [{ line: d.line, kind: d.imported ? 'tight.unused_import' : 'tight.dead_helper' }]
}

function judgeSize(src: ts.SourceFile, fn: ts.Node, ceilings: Ceilings): Span[] {
  const line = lineAt(src, fn.getStart(src))
  const length = lineAt(src, fn.getEnd()) - line + 1
  return [
    ...(length > ceilings.function_lines ? [{ line, kind: 'tight.length' }] : []),
    ...(depth(fn, 0) > ceilings.nesting ? [{ line, kind: 'tight.nesting' }] : []),
  ]
}

interface Declaration {
  name: string
  line: number
  imported: boolean
}

function declared(src: ts.SourceFile): Declaration[] {
  return src.statements.flatMap((s) => {
    if (ts.isImportDeclaration(s)) return bindings(s).map((n) => named(src, n, true))
    if (exported(s)) return []
    if (ts.isFunctionDeclaration(s) && s.name !== undefined) return [named(src, s.name, false)]
    if (ts.isVariableStatement(s)) return holders(s).map((n) => named(src, n, false))
    return []
  })
}

function bindings(node: ts.ImportDeclaration): ts.Identifier[] {
  const clause = node.importClause
  if (clause === undefined) return []
  const elements = clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
    ? clause.namedBindings.elements.map((e) => e.name)
    : []
  return clause.name === undefined ? elements : [clause.name, ...elements]
}

function holders(node: ts.VariableStatement): ts.Identifier[] {
  return node.declarationList.declarations
    .filter((d) => ts.isIdentifier(d.name) && d.initializer !== undefined && ts.isArrowFunction(d.initializer))
    .map((d) => d.name as ts.Identifier)
}

function exported(node: ts.Statement): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

function named(src: ts.SourceFile, node: ts.Identifier, imported: boolean): Declaration {
  return { name: node.text, line: lineAt(src, node.getStart(src)), imported }
}

function counts(src: ts.SourceFile): Map<string, number> {
  const out = new Map<string, number>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) out.set(node.text, (out.get(node.text) ?? 0) + 1)
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

function functions(src: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && bodied(node)) out.push(node)
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

function bodied(node: ts.SignatureDeclaration): boolean {
  return 'body' in node && node.body !== undefined
}

export function touched(src: ts.SourceFile, fn: ts.Node, added: Set<number>): boolean {
  const from = lineAt(src, fn.getStart(src))
  const to = lineAt(src, fn.getEnd())
  return [...added].some((l) => l >= from && l <= to)
}

function depth(node: ts.Node, at: number): number {
  let deepest = at
  ts.forEachChild(node, (child) => {
    if (ts.isFunctionLike(child)) return
    deepest = Math.max(deepest, depth(child, NESTS.has(child.kind) ? at + 1 : at))
  })
  return deepest
}

/**
 * Every comment, found from the parsed tree: the parser knows a template's tail and a regex from a comment,
 * where a bare scanner loses its place after the first `${…}` and reads the strings after it as code (#105).
 */
function comments(src: ts.SourceFile): { line: number; text: string; end: number }[] {
  const text = src.text
  const found = new Map<number, { line: number; text: string; end: number }>()
  const take = (ranges: ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) found.set(r.pos, { line: lineOf(text, r.pos), text: text.slice(r.pos, r.end), end: r.end })
  }
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    take(ts.getLeadingCommentRanges(text, node.getFullStart()))
    take(ts.getTrailingCommentRanges(text, node.getEnd()))
    node.getChildren(src).forEach(visit)
  }
  visit(src)
  return [...found.entries()].sort(([a], [b]) => a - b).map(([, c]) => c)
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

export function lineAt(src: ts.SourceFile, pos: number): number {
  return src.getLineAndCharacterOfPosition(pos).line + 1
}
