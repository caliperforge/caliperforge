import { FENCE } from '../reviews/verdict.ts'
import { maybe, put } from './workspace.ts'

export function premised(root: string, plan: number): void {
  const handback = maybe(root, plan, 'step-2.handback.md')
  const ask = maybe(root, plan, 'ask.md')
  if (handback === null || ask === null) return
  const at = handback.search(FENCE)
  const prose = (at === -1 ? handback : handback.slice(0, at)).trim()
  if (prose !== '') put(root, plan, 'ask.md', `${ask.trimEnd()}\n\n## Answer from the premise\n\n${prose}\n`)
}
