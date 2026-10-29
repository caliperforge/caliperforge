# Fizz lean: context (Steps 0-4.5)

## Handover

- You are a fresh agent for the steps below and no others.
- {SKILL_PATH} in the steps below, and every ./references/, ./agents/, ./scripts/ and ./templates/ link, is ~/.claude/skills/fizz: read it, never write it.
- Every sub-agent you spawn writes its full output to {PROJECT_ROOT}/{META_DIR}/reports/context-<agent>.md, <agent> being the stem of the agent file it was spawned from, and returns a summary of at most 300 words. Where a step passes one agent's output to another, pass that report's path.
- Write {PROJECT_ROOT}/{META_DIR}/context.md: PROJECT_ROOT, SUITE_DIR, META_DIR, the resolved {MODE} and {AGENT_MODEL}, the Step 3 summary, and the Step 4 selection summary.
- Before you end, write {META_DIR}/handoff/context.md, the path the issue names, from its `# Handoff: context` block, with {PROJECT_ROOT}/{META_DIR}/context.md and each file the next phase needs under `## Reads`.
- Before you end, write your own report to {PROJECT_ROOT}/{META_DIR}/reports/context-phase.md and return a summary of at most 300 words.

## Step 0: Print Banner

At the start of every skill run, **first** print this ASCII banner once before any other output — including any selection prompt:

```text

██████╗  █████╗ ███████╗██╗  ██╗ ██████╗ ██╗   ██╗     ███████╗██╗  ██╗██╗██╗     ██╗     ███████╗
██╔══██╗██╔══██╗██╔════╝██║  ██║██╔═══██╗██║   ██║     ██╔════╝██║ ██╔╝██║██║     ██║     ██╔════╝
██████╔╝███████║███████╗███████║██║   ██║██║   ██║     ███████╗█████╔╝ ██║██║     ██║     ███████╗
██╔═══╝ ██╔══██║╚════██║██╔══██║██║   ██║╚██╗ ██╔╝     ╚════██║██╔═██╗ ██║██║     ██║     ╚════██║
██║     ██║  ██║███████║██║  ██║╚██████╔╝ ╚████╔╝      ███████║██║  ██╗██║███████╗███████╗███████║
╚═╝     ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝   ╚═══╝       ╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝
                                
```

After the banner, resolve `{MODE}` per the "Run Mode" section and `{AGENT_MODEL}` per the "Subagent Model" section. For any value still unresolved from invocation flags, ask the user via a single `AskUserQuestion` tool call containing only the unresolved questions (skip the call entirely if both were resolved from flags).

**Output discipline (mandatory)**: Between the banner block and the `AskUserQuestion` invocation, emit **no user-facing text whatsoever** — no "I'll ask about…", no "loading the tool…", no acknowledgement that flags were missing. If `AskUserQuestion`'s schema needs to be fetched via `ToolSearch` first, do that silently as well. The user should see banner → selection UI → resolved-values lines, with nothing in between. This overrides the default behavior of narrating intent before tool calls.

- **Question for `{MODE}`** — `header: "Run mode"`, `question: "How should I run?"`, options:
  - `label: "Automatic (Recommended)"`, `description: "Run end-to-end with no prompts."`
  - `label: "Guided"`, `description: "Pause at 7 checkpoints: extra docs, entry-point picker (browser UI), cost confirm, setup review, per-cycle coverage decision, property review, fuzzer choice."`
- **Question for `{AGENT_MODEL}`** — `header: "Subagent model"`, `question: "Which model should drive the subagents?"`, options:
  - `label: "Sonnet (Recommended)"`, `description: "Default. Faster and cheaper for the 5 discovery agents, synthesizer, and 2 implementers."`
  - `label: "Opus"`, `description: "Higher quality but ~10× the cost. Equivalent to passing --max / --opus."`

Map the user's selections back to `{MODE}` (`automatic` / `guided`) and `{AGENT_MODEL}` (`sonnet` / `opus`), then print these two lines so the resolved values are visible in transcript:

- `Mode: guided` or `Mode: automatic` — the resolved `{MODE}`.
- `Subagent model: sonnet` (default) or `Subagent model: opus (--max)` (if `--max` / `--opus` / "max quality" / "use opus" / Opus selection was requested).

## Step 1: Verify Tooling And Environment

Run sequentially:

1. Read [template-map.md](./references/template-map.md).
2. Run `forge --version`.
3. If `forge --version` fails, tell the user that Foundry is missing and suggest installing it using the official documentation:
   Foundry install guide: `https://www.getfoundry.sh/introduction/installation`
4. If `forge --version` fails, stop here. Foundry is required before proceeding with the rest of the workflow.
5. Run `bash {SKILL_PATH}/scripts/ensure_foundry.sh {PROJECT_ROOT}`.
6. If `foundry.toml` is missing, allow `ensure_foundry.sh` to create one. If it fails, stop and report the error.
7. Run `medusa --version`.
8. Run `echidna --version`.
9. If either command fails, tell the user which tool is missing and suggest installing it using the official documentation:
   Medusa install guide: `https://secure-contracts.com/program-analysis/medusa/docs/src/getting_started/installation.html`
   Echidna install guide: `https://secure-contracts.com/program-analysis/echidna/introduction/installation.html`
10. If `medusa --version` fails, stop here. Medusa is required before proceeding with the rest of the workflow.
11. If `echidna --version` fails but Foundry and Medusa are installed, you may continue, but keep the installation recommendation in the user-facing summary because Echidna is still expected for the full workflow.

## Step 2: Compile And Extract

Run sequentially:

1. Read `{PROJECT_ROOT}/foundry.toml`.
2. Run `cd {PROJECT_ROOT} && forge build`.
3. Run `node {SKILL_PATH}/scripts/extract_abis.js {PROJECT_ROOT} --meta-dir {META_DIR}`.

## Step 3: Understand The Protocol

This step exists to drive setup, handler selection, and invariant generation quality.

If `{MODE} = "guided"`, before touching any analysis source first ask the user: *"Any additional docs, links, whitepapers, spec files, or prior-audit notes I should consider? (paste paths or URLs, or reply 'none')"*. If the user provides anything, write the raw list to `{PROJECT_ROOT}/{META_DIR}/additional-context.md` (one entry per line, include URLs verbatim). Later sub-steps of this step — and Step 9a — must read that file if it exists and fold it into the protocol-understanding context.

Start by checking whether `{PROJECT_ROOT}/x-ray/` exists and contains `x-ray.md`. `x-ray.md` is REQUIRED — without it, x-ray output is considered unavailable regardless of which other files are present.

If `{PROJECT_ROOT}/x-ray/x-ray.md` exists, read it first as the primary project-understanding source. Then also read any of these supplementary files present in `{PROJECT_ROOT}/x-ray/`:

If `{PROJECT_ROOT}/x-ray/x-ray.md` does NOT exist, you MUST run the **x-ray Acquisition Protocol** below. The Protocol Analyzer fallback (Attempt 4) is FORBIDDEN until Attempts 1–3 have each been executed and their outcomes recorded in `/tmp/x-ray-attempts.md`. "I think x-ray isn't available" is NOT a valid skip — only the recorded output of an actual tool/command counts.

### x-ray Acquisition Protocol

Before Attempt 1, delete `/tmp/x-ray-attempts.md` if it exists (`rm -f /tmp/x-ray-attempts.md`) — stale entries from a previous run would falsely satisfy the Attempt 4 gate. Then create a fresh `/tmp/x-ray-attempts.md` and append one entry per attempt: timestamp, attempt name, command/tool invoked, exact output (or "no output"), outcome (`SUCCESS` / `FAILED: {reason}` / `SKIPPED: {reason}`). Attempt 4 requires the file to contain exactly 3 entries (one per Attempt 1, 2, 3) — `SKIPPED` entries count toward this total.

- **Attempt 1 — invoke the skill.** Call the `x-ray` skill via the `Skill` tool with `args="{PROJECT_ROOT}"`. Do NOT pre-judge availability — invoke it. Only a runtime error of the form "skill not found" / "unknown skill" counts as unavailable. If it runs, wait for completion, then verify `{PROJECT_ROOT}/x-ray/x-ray.md` was written. If yes → SUCCESS, exit Protocol.
- **Attempt 2 — install from the official source and re-invoke.** Run:
  ```bash
  git clone --depth 1 https://github.com/pashov/skills.git /tmp/pashov-skills-xray-install \
    && mkdir -p ~/.claude/skills \
    && cp -r /tmp/pashov-skills-xray-install/x-ray ~/.claude/skills/x-ray
  ```
  Then re-invoke `Skill('x-ray', args="{PROJECT_ROOT}")`. If `{PROJECT_ROOT}/x-ray/x-ray.md` is produced → SUCCESS, exit Protocol. If the re-invocation still returns "skill not found" / "unknown skill" (auto-discovery did not pick up the freshly installed skill mid-session), do NOT mark this attempt failed yet — instead read `~/.claude/skills/x-ray/SKILL.md` (or `/tmp/pashov-skills-xray-install/x-ray/SKILL.md`) and execute its instructions inline against `{PROJECT_ROOT}`. If that produces `{PROJECT_ROOT}/x-ray/x-ray.md` → SUCCESS, exit Protocol. Only if ALL of (Skill re-invocation, inline execution) fail does this attempt count as FAILED.
- **Attempt 3 — guided-mode user gate (guided only).** If `{MODE} = "guided"` AND Attempts 1–2 both failed, ASK the user: *"Could not obtain x-ray automatically (logs in `/tmp/x-ray-attempts.md`). Options: (a) paste an x-ray.md path, (b) authorize Protocol Analyzer fallback, (c) abort. Choose a/b/c."* Record their answer. If (a) and the file exists → copy to `{PROJECT_ROOT}/x-ray/x-ray.md`, SUCCESS. If (c) → halt the skill. Only (b) — explicit user authorization — permits Attempt 4. In `{MODE} = "automatic"`, skip this attempt and record `SKIPPED: automatic mode`.
- **Attempt 4 — Protocol Analyzer fallback.** Permitted ONLY after Attempts 1–3 are recorded in `/tmp/x-ray-attempts.md` (with status FAILED, SKIPPED, or — for Attempt 3 only — `(b) authorized`). Before spawning, confirm the file exists and contains 3 entries; if not, GO BACK to the missing attempt — do not proceed.

    Fallback: Read `{SKILL_PATH}/agents/protocol-analyzer.md`, replace `{SKILL_PATH}` with the actual `{SKILL_PATH}`, `{PROJECT_ROOT}` with the actual `{PROJECT_ROOT}`, and `{META_DIR}` with the actual `{META_DIR}`, then spawn as a `general-purpose` agent with `model: "{AGENT_MODEL}"`. The agent reads the source files, then writes the analysis to `{PROJECT_ROOT}/{META_DIR}/protocol-understanding.md` so that later steps can read it back instead of relying on conversation context.

From the `x-ray` documentation or `protocol-understanding.md` infer and summarize:

- deployment order
- constructor parameter meaning
- required post-deploy initialization
- actor roles and permissioned actions
- approvals, liquidity, or other state needed before handlers will be useful
- which external functions are real fuzzing entry points versus protocol-internal plumbing
- candidate invariants to carry forward into Step 9

If something is still ambiguous after those reads, keep going with a conservative assumption and leave a targeted TODO later instead of guessing broadly.

Do not plan full ghost-variable layouts, snapshot structs, or final implementation details here. Do record the likely invariants clearly so Step 9 can reuse them from `{PROJECT_ROOT}/x-ray/` or `{PROJECT_ROOT}/{META_DIR}/protocol-understanding.md` as its starting point.

## Step 4: Select Entry Points

Read [selection-policy.md](./references/selection-policy.md).

Create `{PROJECT_ROOT}/{META_DIR}/entry-point-selection.json` as a filtered copy of `{PROJECT_ROOT}/{META_DIR}/contracts.json` that keeps the functions most likely to produce useful state transitions.

Build the preselection from the protocol understanding gathered in Step 3 — primarily the x-ray entry-point map (if available) and source-level access control observations. If Step 3 produced an entry-point map with caller or access annotations, use that as the primary filter: exclude functions marked as internal-caller-only or contract-to-contract plumbing. Use `{PROJECT_ROOT}/{META_DIR}/contracts.json` only as the structural template for the output JSON format, not to decide which functions to include.

Then run:

- If `{MODE} = "automatic"`:
  `node {SKILL_PATH}/scripts/select_functions.js {PROJECT_ROOT} --contracts {PROJECT_ROOT}/{META_DIR}/contracts.json --selection {PROJECT_ROOT}/{META_DIR}/entry-point-selection.json --meta-dir {META_DIR} --auto`
- If `{MODE} = "guided"`:
  `node {SKILL_PATH}/scripts/select_functions.js {PROJECT_ROOT} --contracts {PROJECT_ROOT}/{META_DIR}/contracts.json --selection {PROJECT_ROOT}/{META_DIR}/entry-point-selection.json --meta-dir {META_DIR}`

The `--auto` flag accepts the inferred selection and exits immediately. Without it, the script opens a browser UI with the inferred selection pre-checked so the user can adjust and confirm. Both paths write `entry-point-selection.json`.

After the script completes, read `{PROJECT_ROOT}/{META_DIR}/entry-point-selection.json`.

If the script exits before writing `entry-point-selection.json`, stop and report that failure.

Print a short summary:

- selected contracts
- selected functions by contract
- notable excluded functions

### Dispatcher for Low-Frequency Functions

After reading the selection, classify the selected functions into two tiers:

- **Primary**: core user flows that should be called frequently by the fuzzer (deposit, withdraw, mint, redeem, borrow, repay, swap, stake, unstake, claim, liquidate, etc.)
- **Secondary**: less common functions that are still useful but should be called less often (admin setters, configuration changes, pause/unpause, role grants, parameter tuning, etc.)

Write this classification to `{PROJECT_ROOT}/{META_DIR}/entry-point-selection.json` by adding a `"tier": "primary"` or `"tier": "secondary"` field to each function entry.

In Step 7, secondary-tier functions will be wrapped in a dispatcher handler that groups them behind a single entry point with an enum selector. This reduces call frequency naturally without excluding them entirely — the fuzzer picks a random selector value, so secondary functions get exercised occasionally but don't dominate the call sequence.

If the user already excluded a function during selection, it stays excluded. The dispatcher is only for functions the user chose to keep but that should be deprioritized.

`{PROJECT_ROOT}/{META_DIR}/entry-point-selection.json` limits handler generation only. It does not limit the setup dependency graph.

## Step 4.5: Cost Estimate

Run:

`node {SKILL_PATH}/scripts/estimate_cost.js {PROJECT_ROOT} --meta-dir {META_DIR} --model {AGENT_MODEL} --mode {MODE}`

The script reads `entry-point-selection.json`, applies a size bucket based on selected-function count, and writes `{PROJECT_ROOT}/{META_DIR}/cost-estimate.md` with a per-stage breakdown plus a total and an expected range. The numbers are Anthropic list-price ballparks; actual cost varies with coverage cycles, re-runs, and prompt-cache hit rate.

Print the cost estimate table to the user. Then:

- If `{MODE} = "automatic"`: continue to Step 5 without pausing.
- If `{MODE} = "guided"`: ask the user *"Proceed with this estimate, or abort?"* and wait for confirmation before continuing. If the user aborts, stop the run and report where the artifacts so far were written.

