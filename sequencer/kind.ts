import type { Verdict } from '../store/verdict.ts'
import type { Part } from './brief.ts'

/**
 * What a step produced. `outcome` is the routing decision; `spans` is what a refusal names.
 * `rewind` is the step an outcome goes back to -- the moved base `baseMoved` answers -- and clears the plan's
 * retries; `held` leaves the plan on its step with its retries intact. `message` is the reviewer's
 * own prose, which the builder rebuilds against. `blip` is a checkout the network failed. `to` is the
 * step a refusal goes back to when it is not the one the step map implies. `parts` is the brief writer's
 * answer that the ticket is more than one job; `split` is that answer filed, which ends the plan.
 * `command` is the brief writer's answer that the whole job is one allow-listed command; `ran` is that
 * command run, which ends the plan. `quiet` is an outcome whose `events` row would repeat the plan's newest
 * row of its kind, so the tick writes none.
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
  command?: string
  ran?: true
  quiet?: true
  /** Main moved under the branch: nobody's fault, so never `shared` or `repeat`. */
  moved?: true
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
  /** The step only waited (the checks lock, another job's files, the network) and spent no model. */
  held?: true
}
