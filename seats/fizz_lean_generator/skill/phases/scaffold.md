# Fizz lean: scaffold (Steps 5-7)

## Handover

- You are a fresh agent for the steps below and no others.
- Before the first step, read the handoff named by `Start from` and only the files its `## Reads` lists. {MODE}, {AGENT_MODEL} and {FUZZ_BUILD_CMD} are the values {PROJECT_ROOT}/{META_DIR}/context.md records.
- Work from that handoff's fact sections before opening code: open a source file only at a line range they name, or for a fact they do not hold.
- In Step 7, for each state-changing entry point a property or a Step 3 candidate invariant targets, write a <contract>_<function>_clamped handler beside the raw one that bounds each argument to values the call accepts.
- {SKILL_PATH} in the steps below, and every ./references/, ./agents/, ./scripts/ and ./templates/ link, is ~/.claude/skills/fizz: read it, never write it.
- Every sub-agent you spawn writes its full output to {PROJECT_ROOT}/{META_DIR}/reports/scaffold-<agent>.md, <agent> being the stem of the agent file it was spawned from, and returns a summary of at most 300 words. Where a step passes one agent's output to another, pass that report's path.
- Fill your handoff's fact sections (## Signatures, ## Guards, ## Roles, ## Limits) with what the next phase needs, each row naming the file and line range you read it at, or - none when there is nothing to carry.
- Before you end, write {META_DIR}/handoff/scaffold.md, the path the issue names, from its `# Handoff: scaffold` block, with {PROJECT_ROOT}/{META_DIR}/context.md and each file the next phase needs under `## Reads`.
- Before you end, write your own report to {PROJECT_ROOT}/{META_DIR}/reports/scaffold-phase.md and return a summary of at most 300 words.

## Step 5: Generate Scaffold

Run:

`node {SKILL_PATH}/scripts/generate_suite.js {PROJECT_ROOT} --suite-dir {SUITE_DIR} --meta-dir {META_DIR}`

This copies the full template scaffold into `{PROJECT_ROOT}/{SUITE_DIR}/`, including core harness files and utility files such as `utils/MockERC20.sol`. It also writes the fuzzer config files (`echidna.yaml`, `medusa.json`) into `{PROJECT_ROOT}/`.

It also reads `{PROJECT_ROOT}/{META_DIR}/entry-point-selection.json` and generates one stub handler file per selected contract under `{PROJECT_ROOT}/{SUITE_DIR}/handlers/`. Those stubs include the clamped and unclamped section headers but no sample handler functions. `Handlers.sol` is scaffolded to import and inherit from all generated handler stubs.

Treat the copied files as the starting point only. The next steps must modify them to fit the target protocol.

## Step 6: Modify Core Files And Wire Setup

Read [setup-playbook.md](./references/setup-playbook.md) and [template-map.md](./references/template-map.md).

Modify the scaffolded core files under `{PROJECT_ROOT}/{SUITE_DIR}/`. Use [template-map.md](./references/template-map.md) as the source of truth for the inheritance chain, file roles, and which scaffolded files are expected to be refined in this step versus later steps.

Use [setup-playbook.md](./references/setup-playbook.md) as the source of truth for:

- proxy and upgradeability detection
- setup requirements and good defaults
- mock-versus-real dependency choices
- signature-dependent setup guidance
- `Base.sol` integration points and TODO/FIXME policy

When the target protocol depends on simple external ERC20s that are not part of the in-scope deployment graph, prefer the scaffolded `utils/MockERC20.sol` helper unless the project already includes a more faithful token mock.

The key output of this step is a **compiling** scaffold with a realistic `Base.sol::setup()` function and the rest of the core scaffold adjusted to match it.

If `{MODE} = "guided"`, after the edits to `Base.sol` are complete and before running `forge build`, print a **Setup Review** block summarising what was wired:

- Contracts deployed in `setup()` (name + address variable + constructor args source)
- Proxies detected and which implementation each wraps
- Mocks vs real dependencies used, with the reason for each mock
- Actors configured (addresses + role), and which ones the fuzzer will impersonate via handler caller selection
- Seeded balances (token, recipient, amount)
- Roles / access-control grants (role, grantee)
- Approvals (token, owner, spender, amount)

Then ask the user: *"Setup looks right? Reply 'proceed' to build, or tell me what to adjust."* If the user requests adjustments, apply them and re-print the review block; loop until they approve. In `{MODE} = "automatic"`, skip the review block and continue directly.

Run `cd {PROJECT_ROOT} && forge build` before moving on.

## Step 7: Generate Handlers

Read [handler-patterns.md](./references/handler-patterns.md).

First, run the handler generation script to produce pre-populated stubs with correct function signatures and type mappings:

`node {SKILL_PATH}/scripts/generate_handlers.js {PROJECT_ROOT} --suite-dir {SUITE_DIR} --meta-dir {META_DIR}`

Then read these in parallel:

- `{PROJECT_ROOT}/{SUITE_DIR}/handlers/Handlers.sol`
- each generated `{PROJECT_ROOT}/{SUITE_DIR}/handlers/<Contract>Handler.sol`
- each selected contract source file

Then refine the generated `{PROJECT_ROOT}/{SUITE_DIR}/handlers/<Contract>Handler.sol` for the selected contracts. The stubs already contain correct signatures and clamping hints — focus on wiring the actual protocol calls, adding semantic clamping, and implementing boundary-value stress variants.

Use [handler-patterns.md](./references/handler-patterns.md) as the source of truth for:

- clamped versus unclamped handler structure
- handler shaping and semantic action selection
- caller context
- clamping strategy
- edge-case and signature-dependent handler guidance

Update `Handlers.sol` to import and inherit from all generated handlers.

Run `cd {PROJECT_ROOT} && forge build` and fix compile issues before moving on.

