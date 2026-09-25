import { cpSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Post } from '../cli/watch.ts'
import type { Run } from './checks.ts'

export const PLACES = {
  clone: join(homedir(), 'atelier_build'),
  derived: join(homedir(), '.cf-cache/atelier-release'),
  app: '/Applications/Atelier.app',
}

export type Places = typeof PLACES

type Step = [bin: string, args: string[], cwd: string]

const TAIL = 20

function steps(at: Places): Step[] {
  const clone: Step[] = existsSync(join(at.clone, '.git')) ? []
    : [['git', ['clone', 'https://github.com/caliperforge/atelier.git', at.clone], dirname(at.clone)]]
  return [...clone,
    ['git', ['fetch', '--no-tags', 'origin', 'main'], at.clone],
    ['git', ['checkout', '--detach', 'FETCH_HEAD'], at.clone],
    ['xcodebuild', ['-project', 'Atelier.xcodeproj', '-scheme', 'Atelier', '-configuration', 'Release',
      '-destination', 'platform=macOS', '-derivedDataPath', at.derived, 'build'], at.clone]]
}

export function reinstall(run: Run, post: Post, at: Places = PLACES): void {
  for (const [bin, args, cwd] of steps(at)) {
    const { code, output } = run(args, cwd, bin)
    if (code !== 0) {
      post('CaliperForge · Atelier did not build', `${bin} ${args.join(' ')}\n${output.split('\n').slice(-TAIL).join('\n')}`)
      return
    }
  }
  run(['-e', 'quit app "Atelier"'], at.clone, 'osascript')
  rmSync(at.app, { recursive: true, force: true })
  cpSync(join(at.derived, 'Build/Products/Release/Atelier.app'), at.app, { recursive: true, verbatimSymlinks: true })
  run([at.app], at.clone, 'open')
}
