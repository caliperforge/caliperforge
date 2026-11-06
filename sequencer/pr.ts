import type { Board } from '../rails/ci-green/index.ts'
import { parse } from '../rails/diff.ts'
import { template } from '../store/facts.ts'
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
 * Used when the card set no body. Their shape, not ours: their PR template filled where they have one;
 * otherwise it addresses the issue rather than closing it, since one item of a maintainer's list is not the list.
 */
export function prBody(no: number, root: string, plan: number, rules: Profile | null = null): string {
  const brief = get(root, plan, 'issue.md')
  const tests = parse(diffOf(root, plan)).map((f) => f.path).filter((p) => TEST.test(p))
  const tested = tests.length === 0 ? [] : [`Tested in ${tests.map((t) => `\`${t}\``).join(', ')}.`]
  const ci = green(root, plan) ? ['CI is green on our fork at this head.'] : []
  const theirs = template(srcDir(root, plan))
  const ref = refOf(theirs, rules)
  const pieces: [RegExp, string][] = [[/what|why/i, said(brief, ['**Why:**', '**What:**']).join('\n\n')], [/test/i, [...tested, ...ci].join(' ')],
    [/issue/i, `${ref} #${String(no)}.`], [/disclos/i, rules?.disclosure ?? '']]
  const paragraphs = theirs === undefined ? pieces.map(([, p]) => p) : filled(theirs, pieces.filter(([, p]) => p !== ''))
  return `${paragraphs.filter((p) => p !== '').join('\n\n')}\n`
}

export function refOf(theirs: string | undefined, rules: Profile | null): 'Fixes' | 'Addresses' {
  return theirs !== undefined && rules?.issue_ref === 'Fixes' ? 'Fixes' : 'Addresses'
}

/** Each heading takes the first unused piece it names, else keeps the template's text; pieces no heading named follow. */
function filled(theirs: string, pieces: [RegExp, string][]): string[] {
  const sections = theirs.split(/^(?=#{1,6}\s)/m).map((chunk) => {
    if (!/^#{1,6}\s/.test(chunk)) return chunk.trim()
    const [heading = '', ...own] = chunk.split('\n').map((l) => l.trimEnd())
    const at = pieces.findIndex(([named]) => named.test(heading))
    if (at === -1) return [heading, own.join('\n').trim()].filter((p) => p !== '').join('\n\n')
    const [[, piece]] = pieces.splice(at, 1) as [[RegExp, string]]
    return piece.split('\n', 1)[0] === heading ? piece : `${heading}\n\n${piece}`
  })
  return [...sections, ...pieces.map(([, p]) => p)]
}

/** `ci.json` holds only the last judged head's runs: `forkCi` rewrites it per head and `checked` empties it. */
function green(root: string, plan: number): boolean {
  return (JSON.parse(maybe(root, plan, BOARD) ?? '[]') as Board[]).some((r) => r.status === 'completed' && r.conclusion === 'success')
}
