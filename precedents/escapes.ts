import { existsSync, readdirSync } from 'node:fs'
import { prNumber } from '../cli/gh.ts'
import { maybe, planDir } from '../sequencer/workspace.ts'
import { keepEscapes, type Escape } from '../store/escapes.ts'
import type { Db } from '../store/index.ts'
import { prsOf } from '../store/record.ts'
import { source, threads } from './store.ts'

const FLAGS = [/^- G\d+ (\S+?):(\d+) /gm, /^- B\d+ P[1-3] `?([^\s:`]+):(\d+)/gm]

function flagged(root: string, plan: number): Set<string> {
  const dir = planDir(root, plan)
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => /^findings-.+\.md$/.test(n)) : []
  return new Set(names.flatMap((n) => {
    const text = maybe(root, plan, n) ?? ''
    return FLAGS.flatMap((flag) => [...text.matchAll(flag)].map(([, path = '', line = '']) => `${path}:${line}`))
  }))
}

export function counted(db: Db, root: string, repo: string): { number: number; escapes: number }[] {
  return prsOf(db, repo).flatMap(({ plan, evidence }) => {
    const number = prNumber(evidence)
    if (source(db, repo, number) === undefined) return []
    const seen = flagged(root, plan)
    const rows: Escape[] = []
    for (const t of threads(db, repo, number)) {
      if (t.kind !== 'inline' || !['bot', 'maintainer'].includes(t.role) || t.path === null || t.line === null) continue
      const at = `${t.path}:${String(t.line)}`
      if (seen.has(at)) continue
      seen.add(at)
      rows.push({ area: t.path, line: t.line, author: t.author, role: t.role, text: t.text, url: t.url })
    }
    keepEscapes(db, repo, number, plan, rows)
    return [{ number, escapes: rows.length }]
  })
}
