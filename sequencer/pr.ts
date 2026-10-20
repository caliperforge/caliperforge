import type { Board } from '../rails/ci-green/index.ts'
import { parse } from '../rails/diff.ts'
import type { Profile } from '../store/profile.ts'
import { CONVENTIONAL, shaped } from './conventions.ts'
import { BOARD, said, title } from './push.ts'
import { diffOf, get, maybe, srcDir } from './workspace.ts'

const TEST = /(^|\/)(tests?|spec|__tests__)\/|[._](test|spec)\.|Tests?\./

export function prTitle(root: string, plan: number): string {
  const subject = title(root, plan)
  return shaped(srcDir(root, plan)) ? subject : subject.replace(CONVENTIONAL, '')
}

/**
 * Used when the card set no body. Their shape, not ours: it addresses the issue rather than closing
 * it, since one item of a maintainer's list is not the list.
 */
export function prBody(no: number, root: string, plan: number, rules: Profile | null = null): string {
  const brief = get(root, plan, 'issue.md')
  const tests = parse(diffOf(root, plan)).map((f) => f.path).filter((p) => TEST.test(p))
  const tested = tests.length === 0 ? [] : [`Tested in ${tests.map((t) => `\`${t}\``).join(', ')}.`]
  const ci = green(root, plan) ? ['CI is green on our fork at this head.'] : []
  const paragraphs = [...said(brief, ['**Why:**', '**What:**']), [...tested, ...ci].join(' '), `Addresses #${String(no)}.`, rules?.disclosure ?? '']
  return `${paragraphs.filter((p) => p !== '').join('\n\n')}\n`
}

/** `ci.json` holds only the last judged head's runs: `forkCi` rewrites it per head and `checked` empties it. */
function green(root: string, plan: number): boolean {
  return (JSON.parse(maybe(root, plan, BOARD) ?? '[]') as Board[]).some((r) => r.status === 'completed' && r.conclusion === 'success')
}
