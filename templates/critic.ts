import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Check } from './fixturn.ts'
import type { Refused } from './handoff.ts'
import { sections } from './map.ts'

const CHECKS = [['Share-Converted Comparisons', 'critic.share_converted'], ['Unbounded Stand-ins', 'critic.stand_in']] as const

const FACTS: Record<string, string[]> = { 'critic.stand_in': ['Outside dependencies', 'Limits'] }

export function critic(pass: string, dir: string, rule?: string): Refused[] {
  const text = readFileSync(pass, 'utf8')
  return CHECKS.filter(([, r]) => rule === undefined || r === rule).flatMap(([heading, rule]) => {
    const block = new RegExp(`^#+ .*${heading}.*\\n(?:(?!#+ |\`\`\`sh).*\\n)*\`\`\`sh\\n([\\s\\S]*?)^\`\`\``, 'm').exec(text)?.[1]
    if (block === undefined) throw new Error(`${pass} has no sh block under ${heading}`)
    return spawnSync('sh', ['-c', block.replaceAll('{SUITE_DIR}', 'test/fizz')], { cwd: dir, encoding: 'utf8' }).stdout
      .split('\n').filter((line) => line !== '').map((note) => ({ rule, note }))
  })
}

export function section(pass: string, rule: string): string {
  const heading = CHECKS.find(([, r]) => r === rule)?.[0]
  const levels = readFileSync(pass, 'utf8').split('\n').map((line) => ({ line, level: /^(#+) /.exec(line)?.[1]?.length ?? Infinity }))
  const start = levels.findIndex(({ line, level }) => heading !== undefined && level !== Infinity && line.includes(heading))
  if (start === -1) throw new Error(`${pass} has no heading for ${rule}`)
  const end = levels.findIndex(({ level }, i) => i > start && level <= (levels[start]?.level ?? 0))
  return levels.slice(start, end === -1 ? undefined : end).map(({ line }) => line).join('\n')
}

export function criticCheck(pass: string, dir: string, rule: string, map: string): Check {
  const named = FACTS[rule] ?? []
  const facts = sections(map).filter(([name]) => named.includes(name)).map(([, s]) => s.trimEnd()).join('\n\n')
  return { name: 'critic', rules: section(pass, rule), facts, run: () => critic(pass, dir, rule) }
}
