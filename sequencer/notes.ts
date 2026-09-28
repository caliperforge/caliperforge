import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { Note } from '../reviews/verdict.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { internal, type PlanRow } from '../store/plans.ts'
import type { Step } from '../templates/pr-path.ts'
import { checks } from './checks.ts'
import type { Outcome } from './kind.ts'
import { git, holds, maybe, srcDir } from './workspace.ts'

const COMMENT = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
])
const NAME = /^[A-Za-z_$][\w$]*$/
const TEXT = /^['"`}]/
const PROSE = /\.(md|txt)$/
const SCRIPT = /\.[cm]?[jt]s$/
/** Tokens after which a `/` divides rather than opens a regular expression. */
const OPERAND = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.ThisKeyword,
])

interface Token {
  kind: ts.SyntaxKind
  text: string
}

/** A pass's notes, landed only when every one is admitted on a copy and, on our own repository, dropped when the checks go red. */
export function landed(db: Db, root: string, plan: PlanRow, step: Step, notes: Note[]): Outcome {
  const src = srcDir(root, plan.id)
  const base = maybe(root, plan.id, 'base.sha')?.trim() ?? null
  const before = new Map<string, string>()
  const after = new Map<string, string>()
  for (const n of notes) {
    const path = join(src, n.file)
    const text = after.get(n.file) ?? (existsSync(path) ? readFileSync(path, 'utf8') : '')
    const reason = refused(src, base, n, text)
    if (reason !== null) return refusal(step, [n], reason)
    if (!before.has(n.file)) before.set(n.file, text)
    after.set(n.file, swap(text, n))
  }
  write(src, after)
  const failed = internal(plan) ? checks(src) : null
  if (failed !== null) write(src, before)
  const dropped = failed === null ? null : `dropped: ${failed.script} failed after the notes`
  for (const n of notes) {
    logged(db, { plan: plan.id, kind: 'note', actor: step.runs, outcome: 'pass', message: dropped ?? `${n.kind}: ${n.why}`, pointer: at(n), run: null })
  }
  return { outcome: 'pass', spans: [], note: `${step.runs} pass, ${String(notes.length)} note(s) ${dropped ?? 'applied'}` }
}

function refused(src: string, base: string | null, n: Note, text: string): string | null {
  const found = n.old === '' ? 0 : text.split(n.old).length - 1
  if (found !== 1) return `old text matches ${String(found)} times`
  if (PROSE.test(n.file) || (SCRIPT.test(n.file) && inert(text, swap(text, n)))) return null
  return restores(src, base, n) ? null : 'changes running code'
}

function restores(src: string, base: string | null, n: Note): boolean {
  const main = `${base ?? ''}:${n.file}`
  return n.new !== '' && base !== null && holds(src, main) && git(src, ['show', main]).includes(n.new)
}

function swap(text: string, n: Note): string {
  return text.replace(n.old, () => n.new)
}

function write(src: string, files: Map<string, string>): void {
  for (const [file, text] of files) writeFileSync(join(src, file), text)
}

function at(n: Note): string {
  return `${n.file}:${String(n.line)}`
}

function refusal(step: Step, notes: Note[], reason: string): Outcome {
  const spans = notes.map(at)
  return { outcome: 'refuse', spans, note: `${step.runs} note ${spans.join(', ')} ${reason}` }
}

/** Whether `a` and `b` differ only in comments, whitespace, names and text. */
function inert(a: string, b: string): boolean {
  const was = tokens(a)
  const now = tokens(b)
  return was.length === now.length && was.every((t, i) => alike(t, now[i]))
}

function alike(t: Token, u: Token | undefined): boolean {
  if (u?.kind !== t.kind) return false
  return t.text === u.text || (NAME.test(t.text) && NAME.test(u.text)) || (TEXT.test(t.text) && TEXT.test(u.text))
}

function tokens(text: string): Token[] {
  const scanner = ts.createScanner(ts.ScriptTarget.ESNext, false, ts.LanguageVariant.Standard, text)
  const out: Token[] = []
  const braces: boolean[] = []
  let last = ts.SyntaxKind.Unknown
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const read = rescanned(scanner, kind, braces, last)
    const token = scanner.getTokenText()
    if (COMMENT.has(read) || token.trim() === '') continue
    out.push({ kind: read, text: token })
    last = read
  }
  return out
}

/** The scanner alone reads a template's closing `}` as a brace and a regular expression as a slash, so both are read again here. */
function rescanned(scanner: ts.Scanner, kind: ts.SyntaxKind, braces: boolean[], last: ts.SyntaxKind): ts.SyntaxKind {
  let read = kind
  if (read === ts.SyntaxKind.CloseBraceToken && braces.pop() === true) read = scanner.reScanTemplateToken(false)
  if ((read === ts.SyntaxKind.SlashToken || read === ts.SyntaxKind.SlashEqualsToken) && !OPERAND.has(last)) read = scanner.reScanSlashToken()
  if (read === ts.SyntaxKind.OpenBraceToken) braces.push(false)
  if (read === ts.SyntaxKind.TemplateHead || read === ts.SyntaxKind.TemplateMiddle) braces.push(true)
  return read
}
