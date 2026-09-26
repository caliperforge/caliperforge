import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { parse } from '../rails/diff.ts'
import { lineAt, touched } from '../rails/tight/source.ts'
import { block } from '../sequencer/handout.ts'
import { filesOf } from '../store/files.ts'
import type { Db } from '../store/index.ts'

export function inContext(db: Db, plan: number, repo: string, diff: string): string | undefined {
  const listed = new Set(filesOf(db, plan).map((f) => f.path))
  const blocks = parse(diff)
    .filter((f) => !f.deleted && f.path.endsWith('.ts') && listed.has(f.path) && existsSync(join(repo, f.path)))
    .flatMap((f) => declarations(repo, f.path, new Set([...f.added, ...f.removed].map((l) => l.line))))
  return blocks.length === 0 ? undefined : blocks.join('\n\n')
}

function declarations(repo: string, path: string, hunks: Set<number>): string[] {
  const text = readFileSync(join(repo, path), 'utf8')
  const src = ts.createSourceFile('subject.ts', text, ts.ScriptTarget.ESNext, true)
  const lines = text.split('\n')
  return src.statements.filter((s) => touched(src, s, hunks))
    .map((s) => block(path, lines, lineAt(src, s.getStart(src)), lineAt(src, s.getEnd())))
}
