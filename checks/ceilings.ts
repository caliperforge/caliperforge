import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { Check, Finding } from './kind.ts'
import { manifest } from './manifest.ts'
import { walk } from './tree.ts'

const EXCEPTION_FILES = ['.eslintignore', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json']

const DEPTH = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
])

export const ceilings: Check = {
  name: 'ceilings',
  run: (root: string) => Promise.resolve(findings(root)),
}

function findings(root: string): Finding[] {
  const limits = manifest(root).ceilings
  const exceptions = EXCEPTION_FILES.filter((f) => existsSync(join(root, f)))
    .map((f) => finding(f, 1, `${f} is an exceptions file`))
  const sources = walk(root, (f) => f.endsWith('.ts'))
    .flatMap((file) => inFile(root, file, limits))
  return [...exceptions, ...sources]
}

function inFile(root: string, file: string, limits: { function_lines: number; nesting: number }): Finding[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true)
  const path = file.slice(root.length + 1)
  const out: Finding[] = []
  const visit = (node: ts.Node, depth: number): void => {
    const fn = ts.isFunctionLike(node)
    if (fn) out.push(...tooLong(src, path, node, limits.function_lines))
    const next = (fn ? 0 : depth) + (DEPTH.has(node.kind) ? 1 : 0)
    if (next === limits.nesting + 1) out.push(finding(path, lineAt(src, node), `nesting ${String(next)} exceeds ${String(limits.nesting)}`))
    ts.forEachChild(node, (child) => { visit(child, next) })
  }
  visit(src, 0)
  return out
}

function tooLong(src: ts.SourceFile, path: string, node: ts.Node, max: number): Finding[] {
  const start = lineAt(src, node)
  const end = src.getLineAndCharacterOfPosition(node.getEnd()).line + 1
  const lines = end - start + 1
  if (lines <= max) return []
  return [finding(path, start, `function is ${String(lines)} lines, ceiling ${String(max)}`)]
}

function lineAt(src: ts.SourceFile, node: ts.Node): number {
  return src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1
}

function finding(path: string, line: number, message: string): Finding {
  return { check: 'ceilings', path, line, message }
}
