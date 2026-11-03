import type { Thread } from './store.ts'
export { finished, opened, openings, vouched } from '../store/precedents.ts'

export interface Opening { kind: 'deferred' | 'asked' | 'drift' | 'mismatch'; area: string; quote: string; said_by: string; source: string }

export type Listed = Opening & { repo: string; first_seen: string }

const OPENING = /^- opening: (?<kind>deferred|asked) \| area: (?<area>.+?) \| quote: (?<quote>.+?) \| said_by: (?<said_by>\S+) \| source: (?<source>\S+)$/

const DRIFT = /^- drift: (?<quote>(?<what>.+?) \| (?<a>\S+): .+? \| (?<b>\S+): .+? \| kind: (?<kind>sync-async|missing|extra|error-model|naming|types) \| files: (?<pa>\S+):(?<n>\d+), (?<pb>\S+):(?<m>\d+))$/

export function openingOf(line: string, said: Thread[]): Opening | null {
  const got = OPENING.exec(line)?.groups as Opening | undefined
  if (got === undefined || !said.some((t) => t.url === got.source && t.author === got.said_by && t.role === 'maintainer')) return null
  const { kind, area, quote, said_by, source } = got
  return { kind, area, quote, said_by, source }
}

export function driftOf(line: string, files: { lang: string; path: string; lines: number }[]): Opening | null {
  const got = DRIFT.exec(line)?.groups as Record<'quote' | 'what' | 'a' | 'b' | 'kind' | 'pa' | 'n' | 'pb' | 'm', string> | undefined
  if (got === undefined || got.a === got.b) return null
  const cites = (lang: string, path: string, n: string) => files.some((f) => f.lang === lang && f.path === path && Number(n) >= 1 && Number(n) <= f.lines)
  if (!cites(got.a, got.pa, got.n) || !cites(got.b, got.pb, got.m)) return null
  return { kind: 'drift', area: `${got.what} (${got.kind})`, quote: got.quote, said_by: 'shape_compare', source: `${got.pa}, ${got.pb}` }
}
