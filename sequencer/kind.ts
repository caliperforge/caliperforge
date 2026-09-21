import type { Verdict } from '../store/verdict.ts'
import type { Part } from './brief.ts'

/**
 * What a step produced. `outcome` is the routing decision; `spans` is what a refusal names.
 * `rewind` is the step an outcome goes back to -- the moved base of #35 rule 3 -- and clears the plan's
 * retries; `held` leaves the plan on its step with its retries intact. `message` is the reviewer's
 * own prose, which the builder rebuilds against. `blip` is a checkout the network failed. `to` is the
 * step a refusal goes back to when it is not the one the step map implies. `parts` is the brief writer's
 * answer that the ticket is more than one job (#72); `split` is that answer filed, which ends the plan.
 */
export interface Outcome {
  outcome: Verdict['outcome']
  spans: string[]
  note: string
  message?: string
  rewind?: number
  held?: true
  blip?: true
  to?: number
  parts?: Part[]
  split?: true
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
  stole: number | null
}
