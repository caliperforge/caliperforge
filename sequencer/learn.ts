import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { graded, type SignalRow } from '../store/signals.ts'
import { languageOfPath } from './route.ts'
import { maybe, planDir, repoName } from './workspace.ts'

export const BLOCK = /^accepted:[ \t]*\r?\n((?:[ \t]+\S.*(?:\r?\n|$))*)/gm

const FINDING = /^- G(\d+) (\S+?)(?::(\d+))? (.*)$/gm

const HEADING = '## Found by Greptile and fixed\n\n'

/** Each Greptile finding an earlier head carried that `sha` no longer does, and no ruling accepted, becomes a worked example for its language. */
export function learned(db: Db, root: string, plan: number, sha: string): void {
  const dir = planDir(root, plan)
  if (!existsSync(dir)) return
  const kept = [...(maybe(root, plan, `findings-${sha}.md`) ?? '').matchAll(/^- (G\d+) /gm)].map((m) => m[1])
  const ruled = [...(maybe(root, plan, 'rulings.md') ?? '').matchAll(BLOCK)]
    .flatMap(([, body = '']) => /^[ \t]+ids:(.*)$/m.exec(body)?.[1]?.match(/G\d+/g) ?? [])
  for (const name of readdirSync(dir)) {
    const head = /^findings-(.+)\.md$/.exec(name)?.[1]
    const signal = head === undefined || head === sha ? null : graded(db, plan, head)
    if (head === undefined || signal === null) continue
    for (const [, id = '', path = '', at, body = ''] of (maybe(root, plan, name) ?? '').matchAll(FINDING)) {
      if (!kept.includes(`G${id}`) && !ruled.includes(`G${id}`)) learn(db, root, plan, signal, head, { id, path, at, body })
    }
  }
}

function learn(db: Db, root: string, plan: number, { repo, pr }: SignalRow, head: string,
  f: { id: string; path: string; at: string | undefined; body: string }): void {
  const language = languageOfPath(f.path) ?? (/\.tsx?$/.test(f.path) ? 'typescript' : null)
  if (language === null) return
  const file = join(root, '.cf/examples', `${language}.md`)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (text?.includes(`#discussion_r${f.id})`) === true) return
  const link = `https://github.com/${repo}/pull/${String(pr)}#discussion_r${f.id}`
  const span = `${repo}@${head.slice(0, 7)}:${f.path}${f.at === undefined ? '' : `:${f.at}`}`
  mkdirSync(join(root, '.cf/examples'), { recursive: true })
  appendFileSync(file, `${text === null ? HEADING : ''}- ${repoName(repo)}#${String(pr)} \`${span}\`: ${f.body.trim()} (${link}).\n`)
  logged(db, { plan, kind: 'examples.learned', actor: 'ready', outcome: 'pass', message: `G${f.id} ${language}`, pointer: link, run: null })
}
