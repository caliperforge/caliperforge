import { section } from './brief.ts'
import { cloned, maybe, srcDir, tried } from './workspace.ts'

interface Row { id: string; rank: number; path: string; at: string | undefined; body: string; text: string }

export const badge = (text: string): number => Number(/alt="P(\d)"/.exec(text)?.[1] ?? 0)

export function rows(text: string): Row[] {
  return text.split(/^(?=- [GB]\d+ )/m).filter((row) => /^- (?:G\d+|B\d+ P[1-3]) /.test(row)).map((row) => {
    const [, id = '', p, path = '', at, body = ''] = /^- (G\d+|B\d+) (?:(?<=B\d+ )P([1-3]) )?(?:(\S+?)(?::(\d+))? )?(.*)$/m.exec(row) ?? []
    return { id, rank: p === undefined ? badge(row) : Number(p), path, at, body, text: row }
  })
}

/** The rows Greptile left at `sha` and the blind pass left at its tree, which step 5 judged before `headOf` committed it. */
export function listed(root: string, plan: number, sha: string): Row[] {
  const src = srcDir(root, plan)
  const tree = cloned(src) ? tried(src, ['rev-parse', `${sha}^{tree}`])?.trim() : undefined
  return [sha, ...(tree === undefined ? [] : [tree])].flatMap((at) => rows(maybe(root, plan, `findings-${at}.md`) ?? ''))
    .filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i)
}

export function answered(root: string, plan: number): Map<string, string> {
  const rows = section(maybe(root, plan, 'step-2.handback.md') ?? '', '## Findings answered').split(/^---$/m)[0] ?? ''
  return new Map([...rows.matchAll(/^- (B\d+) ((?:fixed|disputed): \S.*)$/gm)].map(([, id = '', line = '']) => [id, line]))
}
