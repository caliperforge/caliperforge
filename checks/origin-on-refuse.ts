import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { Check, Finding } from './kind.ts'
import { manifest } from './manifest.ts'
import { fresh, rejects } from './sqlite.ts'
import { walk } from './tree.ts'

const BARE_REFUSE = `INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, tokens, seconds)
VALUES ('review', 'review', '${'0'.repeat(64)}', 1, 4, 'refuse', 0, 0)`

export const originOnRefuse: Check = {
  name: 'origin-on-refuse',
  run: (root: string) => Promise.resolve(findings(root)),
}

function findings(root: string): Finding[] {
  const db = fresh(join(root, 'schema'))
  db.pragma('foreign_keys = OFF')
  const schema = rejects(db, BARE_REFUSE)
    ? []
    : [finding('schema/', 1, 'a refuse verdict with no origin was accepted')]
  const sources = [join(root, 'rails'), join(root, 'reviews')]
    .flatMap((d) => walk(d, (f) => f.endsWith('.ts')))
    .flatMap((f) => inFile(root, f, new Set(manifest(root).rails)))
  return [...schema, ...sources]
}

function inFile(root: string, file: string, rails: Set<string>): Finding[] {
  const text = readFileSync(file, 'utf8')
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
  const path = file.slice(root.length + 1)
  const out: Finding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && literal(node, 'outcome') === 'refuse') {
      out.push(...judge(node, src, path, rails))
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

function judge(node: ts.ObjectLiteralExpression, src: ts.SourceFile, path: string, rails: Set<string>): Finding[] {
  const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1
  const kind = literal(node, 'origin_kind')
  const ref = literal(node, 'origin_ref')
  if (kind === undefined || ref === undefined) return [finding(path, line, 'refuse carries no origin')]
  if (kind === 'rail' && !rails.has(ref)) return [finding(path, line, `origin_ref "${ref}" names no rail`)]
  return []
}

function literal(node: ts.ObjectLiteralExpression, name: string): string | undefined {
  const prop = node.properties.find((p) => p.name?.getText() === name)
  if (prop === undefined || !ts.isPropertyAssignment(prop)) return undefined
  return ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : undefined
}

function finding(path: string, line: number, message: string): Finding {
  return { check: 'origin-on-refuse', path, line, message }
}
