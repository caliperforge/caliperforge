# Fizz lean: campaigns (Steps 10-11)

## Handover

- You are a fresh agent for the steps below and no others.
- Before the first step, read the handoff named by `Start from` and only the files its `## Reads` lists. {MODE}, {AGENT_MODEL} and {FUZZ_BUILD_CMD} are the values {PROJECT_ROOT}/{META_DIR}/context.md records.
- {SKILL_PATH} in the steps below, and every ./references/, ./agents/, ./scripts/ and ./templates/ link, is ~/.claude/skills/fizz: read it, never write it.
- Every sub-agent you spawn writes its full output to {PROJECT_ROOT}/{META_DIR}/reports/campaigns-<agent>.md, <agent> being the stem of the agent file it was spawned from, and returns a summary of at most 300 words. Where a step passes one agent's output to another, pass that report's path.
- Before you end, write {META_DIR}/handoff/campaigns.md, the path the issue names, from its `# Handoff: campaigns` block.
- Before you end, write your own report to {PROJECT_ROOT}/{META_DIR}/reports/campaigns-phase.md and return a summary of at most 300 words.

## Step 10: Run Campaigns

After invariant generation and validation, run a full fuzzing campaign to find property violations.

### Fuzzer Selection

- `{MODE} = "automatic"`: default to **Medusa** — faster with multi-worker parallelism and better suited for initial runs.
- `{MODE} = "guided"`: ask the user *"Which fuzzer for this campaign — Medusa (default, parallel workers) or Echidna?"* and use their answer. If they express no preference, default to Medusa.

Do not run both fuzzers simultaneously — this consumes excessive resources and can cause system instability or crashes. Campaign Iteration (below) is where a complementary run on the other fuzzer is offered.

### Running the Campaign

Run the wrapper for the chosen fuzzer, either **Medusa** or **Echidna** (ONLY ONE), asynchronously using the agent's command-execution tool, then wait for that tracked background job to finish — the wrapper exits when the fuzzer's own stop condition triggers or the `--timeout` is reached. Both wrappers start a temporary local browser log viewer and print its URL, but do not open the browser by default; read the viewer URL from the wrapper output and provide it to the user. Add `--logs` to the command only if the user asks for the viewer to open in their browser automatically.

For **Medusa**, run this command:

```
node {SKILL_PATH}/scripts/run_medusa.js {PROJECT_ROOT} --meta-dir {META_DIR} --timeout 600
```

For **Echidna**, run this command:

```
node {SKILL_PATH}/scripts/run_echidna.js {PROJECT_ROOT} --meta-dir {META_DIR} --timeout 600
```

If Echidna fails with `unlinked libraries detected in bytecode`, link the libraries in `echidna.yaml`:

```yaml
deployContracts: [["0xf1", "Lib1"], ["0xf2", "Lib2"]]
cryticArgs: ["--compile-libraries=(Lib1,0xf1), (Lib2,0xf2)"]
```

Replace `Lib1`, `Lib2` with the actual library names and `0xf1`, `0xf2` with the desired deployment addresses.

### Interpreting Results

After the campaign completes:

- check for property violations (failed assertions)
- for each violation, extract the call sequence that triggered it
- verify the violation is a real bug, not a harness issue — if the property or handler has a bug, fix it and rerun
- **triage by the violated property's Guarantee tag** (from `PROPERTIES.md`): a violated **SHOULD-HOLD** property is a confirmed bug — the protocol broke a documented/mathematical guarantee, so report it as such; a violated **EXPLORATORY** property is flagged for human review — it may be a real bug or an over-strong inferred assumption, so present the call sequence and let a human judge rather than asserting a bug. Always rule out a harness/property bug first regardless of tag.
- if no violations were found, report that the campaign completed cleanly with the coverage achieved
- if violations were found, document each one with the failing property name, its Guarantee tag, the call sequence, and the contract state at failure

### Campaign Iteration

If the user wants to explore further after the first campaign:

- offer to run the other fuzzer (Echidna if Medusa was used, or vice versa) for a complementary pass
- offer to increase the timeout or test limit
- offer to adjust handler shapes based on coverage gaps observed during the campaign

## Step 11: Validate And Report

Run:

1. `{FUZZ_BUILD_CMD}`
2. If `FoundryTester.sol` exists, `cd {PROJECT_ROOT} && FOUNDRY_PROFILE=fuzz forge test --match-contract FoundryTester` (or without `FOUNDRY_PROFILE` if no fuzz profile was created)

If validation fails:

- fix the specific broken files
- do not regenerate the whole suite unless the user asks
- limit repair retries to 3 cycles, then report the remaining issues cleanly

### Generate Violation Repros

If the campaign in Step 10 found property violations, generate a Foundry reproduction test for each distinct violation in `FoundryTester.sol`. This turns fuzzer output into deterministic, one-command proof that the violation is real.

**When to run**: only when `{PROJECT_ROOT}/{META_DIR}/corpus_medusa/test_results/` contains violation JSON files (Medusa) or the Echidna log contains `failed!` lines with call sequences. If the campaign found no violations, skip this sub-step entirely.

**How to generate repros**:

1. Read each violation file (Medusa: one JSON per violation in `test_results/`; Echidna: parse call sequences from the log after each `failed!` line).
2. For each distinct violated property (group multiple reproductions of the same property — use only the shortest call sequence):
   - Create a `test_repro_<propertyName>()` function in `FoundryTester.sol`.
   - Replay the shrunk call sequence by calling the handler functions from the JSON `methodSignature` and `inputValues` fields directly.
   - Between calls, use `vm.roll()` and `vm.warp()` to advance block number and timestamp by the `blockNumberDelay` and `blockTimestampDelay` from each call entry.
   - The fuzzer's `from` addresses map to actors by index: `0x10000` → `actors[0]`, `0x20000` → `actors[1]`, `0x30000` → `actors[2]`. The clamped handlers accept an actor seed parameter that runs through `toActor()`, so pass the raw fuzzer input values — the seed modulus selects the right actor.
   - **Two violation patterns require different test structures**:
     - **Global property violations** (`property_*` functions that return `bool`): replay the full call sequence, then assert the property returns `false`: `assertFalse(property_xxx(), "property should be violated");`. The test **passes** when the property is violated.
     - **Inline assertion violations** (`_prop_*` / `_check*` assertions inside handlers that revert via `assert()` / `t()`): the violating handler call will revert with `panic(0x01)` before any post-call assertion can run. Wrap the violating call in `try this._repro_helperN() { revert("assertion should have fired"); } catch {}`, where `_repro_helperN()` is an `external` helper function that calls the handler. The `try/catch` proves the assertion fired. The test **passes** when the catch triggers.
3. Run `{FUZZ_BUILD_CMD}` and then `cd {PROJECT_ROOT} && FOUNDRY_PROFILE=fuzz forge test --match-contract FoundryTester -vvv` to confirm all repro tests pass.
4. If a repro test fails to compile or does not reproduce the violation, fix it (max 2 attempts per test). If it still fails, comment out the test body with a `// TODO: manual repro needed — fuzzer sequence did not reproduce under Foundry` note and move on.

**Repro naming convention**: `test_repro_<propertyName>` (e.g., `test_repro_property_solvency`, `test_repro_prop_depositIncreasesShares`). If the same property was violated by multiple distinct root causes (different call sequences hitting different code paths), suffix with `_1`, `_2`.

### Final Report

After validation succeeds, spawn the Report Writer subagent to synthesize the final report. Read `{SKILL_PATH}/agents/report-writer.md`, replace `{SKILL_PATH}` with the actual `{SKILL_PATH}`, `{PROJECT_ROOT}` with the actual `{PROJECT_ROOT}`, `{META_DIR}` with the actual `{META_DIR}`, and `{SUITE_DIR}` with the actual `{SUITE_DIR}`, then spawn as a `general-purpose` agent with `model: "{AGENT_MODEL}"`.

The agent reads the campaign outputs (coverage, corpus, `medusa-run.log`, `PROPERTIES.md`, `Properties.sol`, handler files, open TODOs) and writes `{PROJECT_ROOT}/{META_DIR}/report.md`.

The report-writer agent will also print the report content to the conversation (so the user sees it inline) and remind the user of the commands to run campaigns manually:

- `medusa fuzz` (from project root)
- `echidna . --contract FuzzTester --config echidna.yaml`

### Snapshot For Future Re-Use

After the final report is written, capture a sync snapshot so the `/fizz-sync` skill can detect drift on subsequent source changes without re-running the full pipeline:

```
node {SKILL_PATH}/scripts/fizz_sync.js {PROJECT_ROOT} --init --meta-dir {META_DIR} --suite-dir {SUITE_DIR}
```

If the snapshot already exists (because a prior run already initialised it), re-run with `--refresh-snapshot` instead so the new baseline reflects the current state:

```
node {SKILL_PATH}/scripts/fizz_sync.js {PROJECT_ROOT} --refresh-snapshot --meta-dir {META_DIR} --suite-dir {SUITE_DIR}
```

This writes `{PROJECT_ROOT}/{META_DIR}/last-run.json` — a hash+signature snapshot of the in-scope contracts, handlers, and `PROPERTIES.md` entries. Later, when the user modifies sources and invokes `/fizz-sync`, that skill diffs against this file to detect added/removed/changed functions, quarantine stale properties, and regenerate only the drifted handler stubs.
