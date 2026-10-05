import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { Post } from '../cli/watch.ts'
import type { Run } from './checks.ts'

const TAIL = 20

export function refresh(run: Run, post: Post, web = join(homedir(), 'atelier_web')): void {
  const steps: [bin: string, args: string[]][] = [
    ['git', ['fetch', '--no-tags', 'origin', 'main']],
    ['git', ['merge', '--ff-only', 'FETCH_HEAD']],
    ['launchctl', ['kickstart', '-k', `gui/${String(userInfo().uid)}/com.caliperforge.atelier-web`]],
  ]
  for (const [bin, args] of steps) {
    const ran = run(args, web, bin)
    if (!ran.ok) {
      post('CaliperForge · Atelier web did not update', `${bin} ${args.join(' ')}\n${ran.output.split('\n').slice(-TAIL).join('\n')}`)
      return
    }
  }
}
