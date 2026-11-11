import type { Board } from '../rails/ci-green/index.ts'
import { field } from './unruled.ts'
import { maybe } from './workspace.ts'

const EXCUSED = /^overruled:[ \t]*\r?\n((?:[ \t]+\S.*(?:\r?\n|$))*)/gm

/** Every red span at `sha` is a board run whose workflow an `overruled:` block with a reason names at that head. */
export function excused(root: string, plan: number, sha: string, spans: string[], board: Board[]): boolean {
  const named = [...(maybe(root, plan, 'rulings.md') ?? '').matchAll(EXCUSED)].flatMap(([, body = '']) =>
    field(body, 'head') === sha.slice(0, 12) && field(body, 'reason') !== '' ? field(body, 'spans').split(/,\s*/) : [])
  return spans.length > 0 && spans.every((s) => board.some((r) => `${r.url ?? r.workflow} ci.red` === s && named.includes(`ci.red ${r.workflow}`)))
}
