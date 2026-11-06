import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { carried } from '../rails/completion-audit/index.ts'
import { parse } from '../rails/diff.ts'
import { BLOCK } from './learn.ts'
import { diffOf, maybe, planDir, srcDir, tried } from './workspace.ts'

const OVERRULED = /\b((?:G\d+[ \t,]*)+)overruled:(?=[ \t]*\S)(.*?)(?=\b(?:G\d+[ \t,]*)+overruled:|$)/gm

/** A finding with no `P<n>` badge stays open, so a change to Greptile's format holds plans rather than passing them. */
export function unruled(root: string, plan: number, sha: string, summary = ''): { found: number; ruled: string[]; open: string[]; refused: string[]; severe: string[] } {
  const linked = [...summary.matchAll(/^.*#discussion_r(\d+).*$/gm)].map(([text, n = '']) => ({ id: `G${n}`, text }))
  const findings = [...listed(root, plan, sha), ...linked].filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i)
  const rank = (f: { text: string }): number => Number(/alt="P(\d)"/.exec(f.text)?.[1] ?? 0)
  const [ok, over] = [accepted(maybe(root, plan, 'rulings.md') ?? ''), overruled(root, plan)]
  const cites = (reason: string): boolean => [...reason.matchAll(/([^\s`'"(),:]+):\d+/g)].some(([, path = '']) =>
    !path.includes('..') && statSync(join(srcDir(root, plan), path), { throwIfNoEntry: false })?.isFile() === true)
  const ruled = findings.filter((f) => (rank(f) >= 2 && ok.has(f.id))
    || over.some((o) => o.id === f.id && (rank(f) >= 2 || cites(o.reason))))
  const paths = new Map([...(maybe(root, plan, 'findings.paths') ?? '').matchAll(/^(G\d+) (.+)$/gm)].map(([, id = '', path = '']) => [id, path]))
  const diffed = paths.size === 0 ? [] : parse(diffOf(root, plan)).map((f) => f.path)
  const off = (id: string): boolean => paths.has(id) && !diffed.includes(paths.get(id) ?? '')
  const open = findings.filter((f) => !ruled.includes(f) && !off(f.id) && rank(f) <= 2)
  return { found: findings.length, ruled: ruled.map((f) => f.id), open: open.map((f) => f.id), refused: open.filter((f) => ok.has(f.id)).map((f) => f.id), severe: open.filter((f) => rank(f) <= 1).map((f) => f.id) }
}

export function settled(root: string, plan: number, sha: string): Map<string, string> {
  const [reply, pointer] = [replies(root, plan), pointers(root, plan)]
  return new Map(listed(root, plan, sha).flatMap(({ id }) => {
    const line = reply(id) ?? (pointer(id) === '' ? '' : `fixed: ${pointer(id)}`)
    return line === '' ? [] : [[id, line] as const]
  }))
}

/** Each finding at `head` or at a head before it on its line, with the ruling or the later commit that answers it. */
export function handled(root: string, plan: number, head: string): { id: string; text: string; how: string | null; holds: boolean }[] {
  const [src, reply, pointer] = [srcDir(root, plan), replies(root, plan), pointers(root, plan)]
  return readdirSync(planDir(root, plan)).flatMap((name) => /^findings-([0-9a-f]{40})\.md$/.exec(name)?.[1] ?? [])
    .filter((sha) => tried(src, ['merge-base', '--is-ancestor', sha, head]) !== null)
    .flatMap((sha) => {
      const { open } = unruled(root, plan, sha)
      return listed(root, plan, sha).map(({ id, text }) => {
        const at = pointer(id)
        const fix = at === '' ? '' : tried(src, ['log', '-1', '--format=%H', `${sha}..${head}`, '--', at.split(':')[0] ?? ''])?.trim() ?? ''
        const how = reply(id) ?? (fix === '' ? null : `fixed in ${fix.slice(0, 12)} at ${at}`)
        return { id, text, how, holds: how === null && open.includes(id) }
      })
    })
}

function replies(root: string, plan: number): (id: string) => string | undefined {
  const [ok, over] = [accepted(maybe(root, plan, 'rulings.md') ?? ''), overruled(root, plan)]
  return (id) => ok.has(id) ? `accepted: ${ok.get(id) ?? ''}` : over.find((o) => o.id === id)?.line
}

function pointers(root: string, plan: number): (id: string) => string {
  const rows = carried(maybe(root, plan, 'step-2.handback.md') ?? '')
  return (id) => typeof rows === 'string' || rows.get(id)?.status !== 'done' ? '' : rows.get(id)?.pointer?.trim() ?? ''
}

export function listed(root: string, plan: number, sha: string): { id: string; text: string }[] {
  return (maybe(root, plan, `findings-${sha}.md`) ?? '').split(/^(?=- G\d+ )/m)
    .filter((text) => /^- G\d+ /.test(text)).map((text) => ({ id: text.split(' ')[1] ?? '', text }))
}

function accepted(rulings: string): Map<string, string> {
  const field = (body: string, key: string): string => new RegExp(`^[ \\t]+${key}:(.*)$`, 'm').exec(body)?.[1]?.trim() ?? ''
  return new Map([...rulings.matchAll(BLOCK)].flatMap(([, body = '']) => /^[0-9a-f]{7,40}$/.test(field(body, 'head')) && field(body, 'reason') !== ''
    ? (field(body, 'ids').match(/G\d+/g) ?? []).map((id) => [id, field(body, 'reason')] as const) : []))
}

function overruled(root: string, plan: number): { id: string; reason: string; line: string }[] {
  return [maybe(root, plan, 'rulings.md') ?? '', maybe(root, plan, 'issue.md') ?? ''].flatMap((text) => text.split('\n')).flatMap((line) =>
    [...line.matchAll(OVERRULED)].flatMap(([, ids = '', reason = '']) => (ids.match(/G\d+/g) ?? []).map((id) => ({ id, reason, line: line.trim() }))))
}
