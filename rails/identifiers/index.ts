import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { subdirs, walk } from '../../checks/tree.ts'
import type { Verdict } from '../record.ts'

/** `+` belongs to a name: Swift's `Type+Extension.swift` read as `Type` and refused plan 155 (09-25). */
const NAMED = /(?:^|[\s([<'"`])((?:[A-Za-z0-9_.+-]+\/)+[A-Za-z0-9_.+-]+)(?::(\d+))?/g
const ADR = /\bADR[ -](\d{4})\b/g

interface Said {
  text: string
  line: number
}

interface Named {
  id: string
  line: number
}

export function identifiers(root: string, text: string): Verdict {
  const ours = new Set(subdirs(root))
  const said = lines(text)
  const missing = said.flatMap((l) => [...paths(root, ours, l), ...adrs(root, l)])
  const spans = missing.map((m) => `text:${String(m.line)} identifier.unresolved`)
  const subject_digest = createHash('sha256').update(text).digest('hex')
  if (spans.length === 0) return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest, spans, message: `every identifier named across ${String(said.length)} line(s) resolves against its source` }
  return {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'identifiers',
    subject_digest,
    spans,
    message: `${String(spans.length)} identifier(s) name no source in the tree: ${missing.map((m) => m.id).join(', ')}`,
  }
}

function paths(root: string, ours: Set<string>, l: Said): Named[] {
  return [...l.text.matchAll(NAMED)]
    .map((m) => ({ id: (m[1] ?? '').replace(/\.+$/, ''), at: m[2] }))
    .filter((n) => ours.has(n.id.split('/')[0] ?? ''))
    .filter((n) => !resolves(join(root, n.id), n.at))
    .map((n) => ({ id: n.at === undefined ? n.id : `${n.id}:${n.at}`, line: l.line }))
}

function resolves(path: string, at: string | undefined): boolean {
  if (!existsSync(path)) return false
  if (at === undefined) return true
  return readFileSync(path, 'utf8').split('\n').length >= Number(at)
}

function adrs(root: string, l: Said): Named[] {
  return [...l.text.matchAll(ADR)]
    .map((m) => m[1] ?? '')
    .filter((number) => walk(join(root, 'docs/adr'), (name) => name.startsWith(`${number}-`)).length === 0)
    .map((number) => ({ id: `ADR ${number}`, line: l.line }))
}

function lines(text: string): Said[] {
  return text.split('\n')
    .map((line, index) => ({ text: line, line: index + 1 }))
    .filter((l) => l.text.trim() !== '')
}
