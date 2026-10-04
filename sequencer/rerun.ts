import { list, type Gh, type Head } from '../rails/ci-green/index.ts'
import { maybe, put } from './workspace.ts'

/** `<head> <run id>…`: the cancelled runs re-run at that head, each once. */
const ASKED = 'ci.rerun'

const ID = /\/actions\/runs\/(\d+)/

/** A head red only through cancelled runs re-runs each of them; a string is what the head waits on, null refuses as before. */
export function rerun(root: string, plan: number, head: Head, spans: string[], gh: Gh): string | null {
  const reds = (list(head, gh) ?? []).filter((r) => r.headSha === head.sha && spans.includes(`${r.url} ci.red`))
  if (reds.length !== spans.length || reds.some((r) => r.conclusion !== 'cancelled')) return null
  const [asked, ...seen] = (maybe(root, plan, ASKED) ?? '').trim().split(' ')
  const before = asked === head.sha ? seen : []
  const ids = reds.map((r) => ID.exec(r.url)?.[1] ?? '')
  for (const id of ids.filter((i) => !before.includes(i))) gh(['run', 'rerun', id, '--repo', head.fork])
  put(root, plan, ASKED, [head.sha, ...new Set([...before, ...ids])].join(' '))
  return `re-running cancelled ${reds.map((r) => r.workflowName).join(', ')}`
}
