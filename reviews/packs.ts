import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../rails/diff.ts'
import { languageOfPath } from '../sequencer/route.ts'
import { profile } from '../store/profile.ts'
import { builder } from '../templates/pr-path.ts'

const LEAD = 'The rules each touched language\'s builder worked under: its prompt up to its answer fence.'

/** The builder rules of each language the diff touches, then the target's notes: what a reviewer of every language judges against. */
export function packs(root: string, diff: string, repo: string | null): string {
  const languages = new Set(parse(diff).map(({ path }) => languageOfPath(path) ?? (/\.tsx?$/.test(path) ? 'typescript' : null)))
  languages.delete(null)
  const rules = [...languages].map((l) => readFileSync(join(root, 'seats', builder(l), 'prompt.md'), 'utf8').replace(/^Answer the [\s\S]*/m, ''))
  return (rules.length === 0 ? '' : `\n\n# Language rules\n\n${LEAD}\n\n${rules.join('')}`) + notes(root, repo)
}

function notes(root: string, repo: string | null): string {
  const notes = repo === null ? [] : profile(root, repo)?.notes ?? []
  return repo === null || notes.length === 0 ? '' : `\n\n# Notes on ${repo}\n\n${notes.map((n) => `- ${n}`).join('\n')}`
}
