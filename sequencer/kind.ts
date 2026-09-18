import type { Verdict } from '../store/verdict.ts'

/**
 * What a step produced. `outcome` is the routing decision; `spans` is what a refusal names.
 * `rewind` is the step a pass has to go back to -- the moved base of #35 rule 3 and nothing else.
 */
export interface Outcome {
  outcome: Verdict['outcome']
  spans: string[]
  note: string
  rewind?: number
}

export interface Fired {
  pipe: string
  plan: number
  step: number
  name: string
  outcome: Verdict['outcome']
  state: string
  spans: string[]
  note: string
}
