import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import ts from 'typescript'
import { walk } from '../checks/tree.ts'
import { parse } from '../rails/diff.ts'
import { exported, lineAt, touched } from '../rails/tight/source.ts'
import { block } from '../sequencer/handout.ts'
import { filesOf } from '../store/files.ts'
import type { Db } from '../store/index.ts'

interface Changed {
  path: string
  blocks: string[]
  names: Set<string>
}

export function inContext(db: Db, plan: number, repo: string, diff: string): string | undefined {
  const listed = new Set(filesOf(db, plan).map((f) => f.path))
  const changed = parse(diff)
    .filter((f) => !f.deleted && f.path.endsWith('.ts') && listed.has(f.path) && existsSync(join(repo, f.path)))
    .map((f) => declarations(repo, f.path, new Set([...f.added, ...f.removed].map((l) => l.line))))
  const blocks = changed.flatMap((c) => c.blocks)
  if (blocks.length === 0) return undefined
  const users = importers(repo, new Map(changed.map((c) => [c.path, c.names])))
  return (users.length === 0 ? blocks : [...blocks, `## Imported by\n\n${users.map((p) => `- ${p}`).join('\n')}`]).join('\n\n')
}

function declarations(repo: string, path: string, hunks: Set<number>): Changed {
  const text = readFileSync(join(repo, path), 'utf8')
  const src = ts.createSourceFile('subject.ts', text, ts.ScriptTarget.ESNext, true)
  const lines = text.split('\n')
  const statements = src.statements.filter((s) => touched(src, s, hunks))
  return {
    path,
    blocks: statements.map((s) => block(path, lines, lineAt(src, s.getStart(src)), lineAt(src, s.getEnd()))),
    names: new Set(statements.filter(exported).flatMap(declaredNames)),
  }
}

export function declaredNames(s: ts.Statement): string[] {
  if (ts.isVariableStatement(s)) return s.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []))
  if (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) return s.name === undefined ? [] : [s.name.text]
  if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) return [s.name.text]
  return []
}

function importers(repo: string, changed: Map<string, Set<string>>): string[] {
  return walk(repo, (n) => n.endsWith('.ts'))
    .map((p) => relative(repo, p))
    .filter((p) => imports(repo, p, changed))
    .sort()
}

function imports(repo: string, path: string, changed: Map<string, Set<string>>): boolean {
  const src = ts.createSourceFile('subject.ts', readFileSync(join(repo, path), 'utf8'), ts.ScriptTarget.ESNext, true)
  return src.statements.filter(ts.isImportDeclaration).some((d) => uses(d, exportsOf(path, d, changed)))
}

function exportsOf(path: string, d: ts.ImportDeclaration, changed: Map<string, Set<string>>): Set<string> | undefined {
  const spec = d.moduleSpecifier
  if (!ts.isStringLiteralLike(spec) || !spec.text.startsWith('.')) return undefined
  const to = join(dirname(path), spec.text)
  return changed.get(to) ?? changed.get(`${to}.ts`)
}

function uses(d: ts.ImportDeclaration, names: Set<string> | undefined): boolean {
  const bound = d.importClause?.namedBindings
  if (names === undefined || bound === undefined) return false
  return ts.isNamespaceImport(bound) || bound.elements.some((e) => names.has((e.propertyName ?? e.name).text))
}
