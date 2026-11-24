import { lstatSync } from 'node:fs'
import { join } from 'node:path'

const ROW = /^- `([^`]+)` — (?:([^@\s]+)@(\S+) (\S+)|(\S+))$/

type Row = { path: string } & ({ source: string } | { repo: string; sha: string; from: string })

export function rowOf(src: string, row: string, planned: string[]): Row {
  const [, path = '', repo = '', sha = '', from = '', source = ''] = ROW.exec(row) ?? []
  if (from === '' && source === '') throw new Error('not - `<checkout path>` — github.com/<owner>/<repo>@<sha> <path> or ~/cf_work/<path>')
  const parts = path.split('/')
  if (parts.some((p) => ['', '.', '..'].includes(p) || p.toLowerCase() === '.git')) {
    throw new Error(`${path} is not a path in the checkout's working tree`)
  }
  if (planned.some((p) => `${p}/`.startsWith(`${path}/`) || `${path}/`.startsWith(`${p}/`))) throw new Error(`${path} overlaps another row`)
  for (let i = 1; i <= parts.length; i++) {
    const at = parts.slice(0, i).join('/')
    const stat = lstatSync(join(src, at), { throwIfNoEntry: false })
    const last = i === parts.length
    if (stat !== undefined && !(last ? stat.isFile() : stat.isDirectory())) throw new Error(`${at} is not a regular ${last ? 'file' : 'folder'}`)
  }
  return source === '' ? { path, repo, sha, from } : { path, source }
}
