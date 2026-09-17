import type { Verdict } from '../store/verdict.ts'

/** What a step produced. `outcome` is the routing decision; `spans` is what a refusal names. */
export interface Outcome {
  outcome: Verdict['outcome']
  spans: string[]
  note: string
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
