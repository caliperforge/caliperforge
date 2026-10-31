import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Refused } from './handoff.ts'

const CHECKS = [['Share-Converted Comparisons', 'critic.share_converted'], ['Unbounded Stand-ins', 'critic.stand_in']] as const

export function critic(pass: string, dir: string): Refused[] {
  const text = readFileSync(pass, 'utf8')
  return CHECKS.flatMap(([heading, rule]) => {
    const block = new RegExp(`^#+ .*${heading}.*\\n(?:(?!#+ |\`\`\`sh).*\\n)*\`\`\`sh\\n([\\s\\S]*?)^\`\`\``, 'm').exec(text)?.[1]
    if (block === undefined) throw new Error(`${pass} has no sh block under ${heading}`)
    return spawnSync('sh', ['-c', block.replaceAll('{SUITE_DIR}', 'test/fizz')], { cwd: dir, encoding: 'utf8' }).stdout
      .split('\n').filter((line) => line !== '').map((note) => ({ rule, note }))
  })
}
