# Fizz lean: invariants (Steps 9-9)

## Handover

- You are a fresh agent for the steps below and no others.
- Before the first step, read the handoff named by `Start from` and only the files its `## Reads` lists. {MODE}, {AGENT_MODEL} and {FUZZ_BUILD_CMD} are the values {PROJECT_ROOT}/{META_DIR}/context.md records.
- Work from that handoff's fact sections before opening code: open a source file only at a line range they name, or for a fact they do not hold.
- {SKILL_PATH} in the steps below, and every ./references/, ./agents/, ./scripts/ and ./templates/ link, is ~/.claude/skills/fizz: read it, never write it.
- Every sub-agent you spawn writes its full output to {PROJECT_ROOT}/{META_DIR}/reports/invariants-<agent>.md, <agent> being the stem of the agent file it was spawned from, and returns a summary of at most 300 words. Where a step passes one agent's output to another, pass that report's path.
- Give each sub-agent you spawn the path of the handoff named by Start from and, in place of whole source files, only the ## Signatures line ranges of the contracts it works on.
- Fill your handoff's fact sections (## Signatures, ## Guards, ## Roles, ## Limits) with what the next phase needs, each row naming the file and line range you read it at, or - none when there is nothing to carry.
- Before you end, write {META_DIR}/handoff/invariants.md, the path the issue names, from its `# Handoff: invariants` block, with {PROJECT_ROOT}/{META_DIR}/context.md and each file the next phase needs under `## Reads`.
- Before you end, write your own report to {PROJECT_ROOT}/{META_DIR}/reports/invariants-phase.md and return a summary of at most 300 words.
- Before you write the handoff, run both checks in {SKILL_PATH}/references/critic-pass.md and clear every hit the way that file says.

## Step 9: Generate Invariants (5 Parallel Discovery Agents + Synthesizer + 2 Implementers)

Skip this step only when the user passed `--no-invariants`.

This is the make-or-break step. It uses **5 specialized discovery agents in parallel**, each applying a different invariant discovery approach drawn from 50+ real DeFi bugs caught by fuzzers.

### Step 9a: Build Invariant Context

Read [property-generation.md](./references/property-generation.md), then build `INVARIANT_CONTEXT` by reading:

- the invariant notes captured in Step 3 from `{PROJECT_ROOT}/x-ray/x-ray.md` when available, otherwise `{PROJECT_ROOT}/{META_DIR}/protocol-understanding.md`
- `{PROJECT_ROOT}/{META_DIR}/additional-context.md` if it exists (guided-mode supplementary docs/links from Step 3)
- all in-scope source files
- `Base.sol`, `Snapshots.sol`, `Properties.sol`
- all generated handler files

Extract from the codebase:
- **AGGREGATE_VARIABLES**: grep for variables named `total*`, `sum*`, `accumulated*`, or any variable that multiple functions write to
- **PAIRED_OPERATIONS**: match function pairs (deposit/withdraw, mint/burn, add/remove, lock/unlock, open/close, stake/unstake, borrow/repay, create/destroy, join/exit)
- **CONVERSION_FUNCTIONS**: grep for `convertTo*`, `preview*`, `toAssets`, `toShares`, or any function mapping between two unit systems
- **ACCESS_CONTROL**: grep for `onlyOwner`, `onlyAdmin`, `onlyRole`, `require(msg.sender`, custom role modifiers

### Step 9b: Spawn 5 Discovery Agents in Parallel

**CRITICAL**: All 5 agents MUST be spawned in a SINGLE message (one tool call per agent, all in the same response).

| Agent | File | Discovery Approach |
|-------|------|-------------------|
| 1. Conservation Auditor | `{SKILL_PATH}/agents/invariant-discovery/conservation-auditor.md` | Sum-of-parts = tracked-whole for every aggregate variable |
| 2. Round-Trip & Rounding Analyst | `{SKILL_PATH}/agents/invariant-discovery/roundtrip-rounding-analyst.md` | Forward+inverse operations, directional rounding |
| 3. State Transition Mapper | `{SKILL_PATH}/agents/invariant-discovery/state-transition-mapper.md` | Postconditions, monotonicity, entity counts, state machine |
| 4. Adversarial Profit Maximizer | `{SKILL_PATH}/agents/invariant-discovery/adversarial-profit-maximizer.md` | Attacker thinking — DoS, value extraction, edge states |
| 5. Protocol-Type Specialist | `{SKILL_PATH}/agents/invariant-discovery/protocol-type-specialist.md` | Auto-detect type, apply domain templates (vault/lending/AMM/etc.) |

Read each agent file, replace `{INVARIANT_CONTEXT}` and `{FILE_PATHS}` with actual values, spawn as `general-purpose` agent with `model: "{AGENT_MODEL}"`.

### Step 9c: Synthesize Property Plan

After all 5 agents return, read the Synthesizer agent file:

| Agent | File |
|-------|------|
| 6. Synthesizer | `{SKILL_PATH}/agents/invariant-discovery/synthesizer.md` |

Replace `{AGENT_OUTPUTS}` with the outputs from agents 1-5, `{META_DIR}` with the actual `{META_DIR}` path, `{PROJECT_ROOT}` with the actual `{PROJECT_ROOT}` path, and `{SUITE_DIR}` with the actual `{SUITE_DIR}` path, then spawn as `general-purpose` agent with `model: "{AGENT_MODEL}"`.
The Synthesizer merges, deduplicates, prioritizes, and writes BOTH:
- `{PROJECT_ROOT}/{META_DIR}/property-plan.md` — implementation tables with stable Spec IDs (`GL-NN`, `SP-NN`)
- `{PROJECT_ROOT}/PROPERTIES.md` — English-language spec with `[ ]` checkboxes, one entry per property, identified by the same Spec IDs. This is the artifact that the `/fizz-convert` command and the implementers in Step 9d operate on.

Each property carries a **Guarantee** tag set at generation time — `SHOULD-HOLD` (explicitly guaranteed by docs/spec/standard or an exact identity, with evidence cited) or `EXPLORATORY` (inferred). This tag is what lets Step 10 triage a violation without post-campaign severity guessing: a violated SHOULD-HOLD property is a confirmed bug, a violated EXPLORATORY property is a lead for human review.

Print a summary: "Generated X properties (N HIGH, N MEDIUM, N LOW; P SHOULD-HOLD, Q EXPLORATORY)" with a brief list of the top properties by priority.

If `{MODE} = "guided"`, pause here: tell the user the file path (`{PROJECT_ROOT}/PROPERTIES.md`), summarise what the Synthesizer produced, and ask *"Review `PROPERTIES.md` and edit freely — rename, add, remove, or reword properties. Keep the Spec IDs (`GL-NN` / `SP-NN`) on entries you want implemented, and leave `[ ]` checkboxes unchanged. Reply 'proceed' when done, or 'regenerate' to re-run the Synthesizer with additional guidance."* If they reply `regenerate`, ask what to change, then re-spawn the Synthesizer (Step 9c) with the extra guidance appended to its input. If they reply `proceed`, continue to Step 9d. In `{MODE} = "automatic"`, skip the pause and proceed directly.

### Step 9d: Implement Properties (2 Parallel Agents)

Read each agent file:

| Agent | File | Scope |
|-------|------|-------|
| 7A. Global Property Implementer | `{SKILL_PATH}/agents/implementers/global-property-implementer.md` | Ghosts in Base.sol, State in Snapshots.sol, global properties in Properties.sol, harness contracts if needed |
| 7B. Specific Property Implementer | `{SKILL_PATH}/agents/implementers/specific-property-implementer.md` | Specific properties in Properties.sol, handler wiring (ghost updates + snapshot calls + property assertions) |

Replace `{META_DIR}` with the actual `{META_DIR}` path, `{SKILL_PATH}` with the actual `{SKILL_PATH}` path, `{PROJECT_ROOT}` with the actual `{PROJECT_ROOT}` path, and `{SUITE_DIR}` with the actual `{SUITE_DIR}` path, then spawn both as `general-purpose` agents with `model: "{AGENT_MODEL}"` in parallel.

Both implementers MUST flip `[ ]` → `[x]` in `{PROJECT_ROOT}/PROPERTIES.md` for each property they actually implement (matching by Spec ID `GL-NN` / `SP-NN`). Properties left as TODO stubs stay `[ ]` so `/fizz-convert` can pick them up later.

### Step 9e: Validate

Run `{FUZZ_BUILD_CMD}` after the edits. Fix any compilation errors.

If a property is low-confidence after implementation, prefer a commented TODO over a brittle assertion.

