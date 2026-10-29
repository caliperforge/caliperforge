# Fizz lean: coverage (Steps 8-8)

## Handover

- You are a fresh agent for the steps below and no others.
- Before the first step, read the handoff named by `Start from` and only the files its `## Reads` lists. {MODE}, {AGENT_MODEL} and {FUZZ_BUILD_CMD} are the values {PROJECT_ROOT}/{META_DIR}/context.md records.
- {SKILL_PATH} in the steps below, and every ./references/, ./agents/, ./scripts/ and ./templates/ link, is ~/.claude/skills/fizz: read it, never write it.
- Every sub-agent you spawn writes its full output to {PROJECT_ROOT}/{META_DIR}/reports/coverage-<agent>.md, <agent> being the stem of the agent file it was spawned from, and returns a summary of at most 300 words. Where a step passes one agent's output to another, pass that report's path.
- When Step 8.0 sets {FUZZ_BUILD_CMD}, append the line FUZZ_BUILD_CMD: <command> to {PROJECT_ROOT}/{META_DIR}/context.md.
- Before you end, write {META_DIR}/handoff/coverage.md, the path the issue names, from its `# Handoff: coverage` block, with {PROJECT_ROOT}/{META_DIR}/context.md and each file the next phase needs under `## Reads`.
- Before you end, write your own report to {PROJECT_ROOT}/{META_DIR}/reports/coverage-phase.md and return a summary of at most 300 words.

## Step 8: Reach Coverage With Medusa

Before generating invariants, ensure the generated harness can drive enough protocol coverage under Medusa.

### Via-IR Coverage Deflation Handling

When `via_ir = true` is set in `foundry.toml`, the Yul IR optimizer aggressively merges and eliminates branches. This deflates Medusa's coverage numbers — you may be at 85% source coverage but Medusa reports 65%. This must be handled before the first Medusa run.

**Step 8.0: Detect and configure fuzz profile.**

1. Read `{PROJECT_ROOT}/foundry.toml` and check whether `via_ir = true` is set under `[profile.default]` or at the top level.
2. If `via_ir` is not enabled, skip this subsection — no fuzz profile is needed.
3. If `via_ir` is enabled, run:

```
bash {SKILL_PATH}/scripts/setup_fuzz_profile.sh {PROJECT_ROOT}
```

This script:
- Appends a `[profile.fuzz]` section to `foundry.toml` with `via_ir = false`
- Runs `FOUNDRY_PROFILE=fuzz forge build`
- If compilation succeeds: exits 0, prints `FUZZ_PROFILE=no-ir`
- If "stack too deep" error: retries with `via_ir = true` and `optimizer_runs = 0`, exits 0, prints `FUZZ_PROFILE=ir-no-opt`
- If both fail: exits 1 (use default profile, accept deflated coverage)

4. Read the script output to determine the fuzz profile mode:
   - `FUZZ_PROFILE=no-ir` → accurate coverage, use standard targets
   - `FUZZ_PROFILE=ir-no-opt` → reduced deflation but still some; lower coverage targets by ~10%
   - Script failed → fall back to default profile; lower coverage targets by ~15-20%

5. Record the profile mode in `{PROJECT_ROOT}/{META_DIR}/coverage-targets.md` at the top:
   - `no-ir`: "Fuzz profile: via_ir disabled — coverage numbers are accurate"
   - `ir-no-opt`: "Fuzz profile: via_ir required (stack too deep), optimizer_runs=0 — coverage deflated ~10%, targets adjusted"
   - default fallback: "Fuzz profile: via_ir required with optimizer — coverage deflated ~15-20%, targets adjusted"

6. For all subsequent `forge build` commands in Steps 8–11, use:
   - `cd {PROJECT_ROOT} && FOUNDRY_PROFILE=fuzz forge build` (if fuzz profile was created)
   - `cd {PROJECT_ROOT} && forge build` (if no fuzz profile needed)

Store the build command in a variable `{FUZZ_BUILD_CMD}` for reuse in later steps.

### Medusa Runs

Every Medusa run in this step must use `run_medusa.js`, including reruns after harness changes. Do not switch to raw `medusa fuzz` for later cycles in this step.

Before launching Medusa, rebuild with the fuzz profile if one was configured:

```
{FUZZ_BUILD_CMD}
```

Run the Medusa script asynchronously using the agent's command-execution tool. This is critical — do NOT use shell backgrounding (`&`), do NOT use `sleep` + `tail` to poll, and do NOT wait synchronously in a single blocking command. Start the process in a way the agent runtime can track and notify on completion.

```
node {SKILL_PATH}/scripts/run_medusa.js {PROJECT_ROOT} --meta-dir {META_DIR} --coverage-mode
```

The wrapper starts a temporary local browser log viewer and prints its URL, but does not open the browser by default. Read the viewer URL from the wrapper output and provide it to the user. Add `--logs` to the command only if the user asks for the viewer to open in their browser automatically.

When the background command completes and you are notified, inspect the resulting coverage with focus on the core protocol contracts, not peripheral mocks or helper libraries.

### Dynamic Coverage Targets

Not all contracts require the same coverage. Assign per-contract targets based on the contract's role:

| Contract Role | Target (no-ir) | Target (ir-no-opt) | Target (ir fallback) |
|---|---|---|---|
| Core protocol logic (vault, pool, lending core, staking engine) | 80%+ | 70%+ | 65%+ |
| Access control / role management | 60%+ | 50%+ | 45%+ |
| Peripheral helpers (routers, views, adapters) | 50%+ | 40%+ | 35%+ |
| Libraries and math utilities | Coverage inherited from callers | Same | Same |

Use the column matching the fuzz profile mode determined in Step 8.0.

After the first Medusa run, review the per-contract coverage report and classify each contract. If a contract has legitimately unreachable paths in the harness context (e.g., fork-only branches, multi-block MEV paths, oracle-failure paths), note them and adjust that contract's target downward rather than wasting cycles on unreachable code.

Write the per-contract targets and any skip justifications to `{PROJECT_ROOT}/{META_DIR}/coverage-targets.md` so the user can review them.

### Coverage Iteration Loop

- with `--coverage-mode`, the wrapper runs `medusa fuzz --timeout 300`, allows at least 60 seconds of fuzzing, then stops earlier if 5 consecutive progress lines show no increase in `branches hit`, and prints the coverage report path when finished (add `--logs` to also open it in the browser)
- if coverage is below target, improve handler shapes, clamping, setup, approvals, seed balances, caller roles, and any missing lifecycle actions
- when debugging why a specific handler or call sequence is not reaching the expected code paths, or when validating a hypothesis, use `FoundryTester.sol` to quickly PoC it
- rerun `{FUZZ_BUILD_CMD}` before each new Medusa run
- treat one cycle as: run `node {SKILL_PATH}/scripts/run_medusa.js {PROJECT_ROOT} --meta-dir {META_DIR} --coverage-mode`, inspect coverage, adjust the harness, then rebuild

After each cycle, build and print a per-contract coverage summary table from the Medusa coverage report:

| Contract | Role | Target | Hit | Status |
|---|---|---|---|---|

`Status` is `✅` if Hit ≥ Target, else `❌`. Append the same table to `{PROJECT_ROOT}/{META_DIR}/coverage-targets.md` under a timestamped `## Cycle N` heading so the history is preserved.

Then branch on `{MODE}`:

- `{MODE} = "automatic"`: if all contracts meet target, give a brief summary and proceed. Otherwise loop; cap at 3 cycles total, then log remaining gaps in `coverage-targets.md` and proceed to the next step with the current harness.
- `{MODE} = "guided"`: after every cycle (including cycle 1), ask the user *"iterate / adjust targets / proceed"*. `iterate` = run another cycle with the current harness adjustments. `adjust targets` = let the user edit per-contract targets in `coverage-targets.md` before the next cycle. `proceed` = exit the loop regardless of gaps. Honour the user's choice; there is no hard cap in guided mode.

After exiting the loop, provide the coverage report path for optional review: `{PROJECT_ROOT}/{META_DIR}/corpus_medusa/coverage/coverage_report.html`.

### Acceptable Skip Reasons

It is acceptable to skip coverage for specific functions or paths when:

- the function requires external state that cannot be simulated (e.g., specific oracle prices from a live feed)
- the path is a revert-only guard that is intentionally unreachable in the harness (e.g., `require(msg.sender == bridgeContract)`)
- the function is behind a time-lock or multi-sig that the harness doesn't simulate
- the function interacts with an external protocol that is not mocked

Document each skip in `{PROJECT_ROOT}/{META_DIR}/coverage-targets.md` with the reason.

Do not move to invariant generation while Medusa coverage is still clearly too low for the selected flows, unless the user explicitly tells you to proceed anyway.

