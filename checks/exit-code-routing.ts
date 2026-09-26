import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { Check, Finding } from './kind.ts'
import { walk } from './tree.ts'

const BRANCHING = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
])

export const exitCodeRouting: Check = {
  name: 'exit-code-routing',
  run: (root: string) => Promise.resolve(walk(root, (f) => f.endsWith('.ts'))
    .filter((f) => judged(f.slice(root.length + 1)))
    .flatMap((f) => inFile(root, f))),
}

function judged(path: string): boolean {
  const parts = path.split('/')
  return !['providers', 'runner'].includes(parts[0] ?? '') && !parts.includes('tests') && !path.endsWith('.test.ts')
}

function inFile(root: string, file: string): Finding[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true)
  const path = file.slice(root.length + 1)
  const out: Finding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'exit' && branched(node)) {
      const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1
      out.push({ check: 'exit-code-routing', path, line, message: 'branches on .exit; branch on Fired.ended' })
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

function branched(node: ts.Node): boolean {
  let at = node
  while (ts.isParenthesizedExpression(at.parent)) at = at.parent
  const p = at.parent
  if (ts.isBinaryExpression(p)) return BRANCHING.has(p.operatorToken.kind)
  if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken
  if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p) || ts.isSwitchStatement(p)) return p.expression === at
  if (ts.isForStatement(p) || ts.isConditionalExpression(p)) return p.condition === at
  return false
}
