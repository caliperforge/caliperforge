---
name: fizz_lean
description: Generate Echidna/Medusa-compatible Solidity fuzz suites from Foundry or Hardhat projects. Trigger on "fizz", "generate fuzz suite", "build fuzz harness", "stateful fuzzing", "fuzzing harness", "property testing", and "invariant suite".
---

# Fizz lean

Generate a stateful Solidity fuzz suite under `{SUITE_DIR}` (default: `test/fizz/`), with metadata and fuzzer runtime files under `{META_DIR}` (default: `fizz_data/`).

Use `Echidna` and `Medusa` for invariant campaigns. Use `Foundry` for compilation, smoke testing, and quick debugging.

## Workflow Rules

- Follow the steps in order. Do not skip forward if a required artifact for the current step does not exist yet.
- If a step fails, stop there and report the blocker.
- If tooling is missing, say exactly what was attempted and what is missing.
- Keep the generated Solidity suite isolated under `test/fizz/` and the metadata/runtime files under `fizz_data/` unless the user explicitly asks for different paths.
- Reuse existing project setup and test logic whenever possible; do not invent a deployment flow if the repo already has one.

## Parameters

- `PROJECT_ROOT`: user-provided path, otherwise the current working directory.
- `SKILL_PATH`: the directory containing this `SKILL.md`.
- `SUITE_DIR`: `test/fizz` relative to `PROJECT_ROOT`. Pass `--suite-dir` to suite-generation steps.
- `META_DIR`: `fizz_data` relative to `PROJECT_ROOT`. Pass `--meta-dir` to metadata steps.
- Optional contract arguments narrow handler generation to specific contracts.
- `--no-invariants` skips Step 9 only.
- `--max` (or `--opus`, or "max quality") upgrades every subagent in this run from Sonnet to Opus. See "Subagent Model" below.
- `--guided` / `--automatic` selects the run mode. See "Run Mode" below.

## Run Mode

The skill runs in one of two modes, resolved once at the start of the run and reused for every checkpoint below:

- `{MODE} = "guided"` — the parent agent pauses for user input at key checkpoints: Step 3 (additional docs), Step 4 (interactive function picker UI), Step 4.5 (cost confirmation), Step 6 (setup review), Step 8 (per-cycle coverage decision), Step 9c (property review), Step 10 (fuzzer choice).
- `{MODE} = "automatic"` — the parent agent never pauses. Step 4 runs with `--auto`, Step 8 loops up to 3 coverage cycles then proceeds, Step 10 defaults to Medusa, and the cost estimate from Step 4.5 is printed but not gated on user confirmation.

### Resolving `{MODE}`

- If the user invoked with `--guided` / "guided mode" / "walk me through" / "let me review" → `{MODE} = "guided"`.
- If the user invoked with `--automatic` / `--auto` / "unguided" / "run the whole thing" / "no prompts" → `{MODE} = "automatic"`.
- Otherwise, leave `{MODE}` unresolved; Step 0 asks for it via the selection prompt **after** printing the banner.

Every subsequent instruction referencing `{MODE}` must substitute the resolved value. Do NOT switch modes mid-run.

## Subagent Model

All subagents spawned by this skill (Step 3 fallback Protocol Analyzer, the 5 Step 9b discovery agents, the Step 9c Synthesizer, the 2 Step 9d Implementers, and the Step 11 Report Writer) default to **Sonnet** for cost and latency. 

The parent agent orchestrating the pipeline is whatever model the user's Claude Code session is running (this skill does not control it). Only the delegated subagents are covered by `{AGENT_MODEL}`.

### Resolving `{AGENT_MODEL}`

Resolve once at the start of the run and reuse it for every spawn below:

- If the user invoked with `--max` / `--opus` / "max quality" / "run on opus" / similar → `{AGENT_MODEL} = "opus"`.
- If the user invoked with `--sonnet` / "use sonnet" / "default model" → `{AGENT_MODEL} = "sonnet"`.
- Otherwise, leave `{AGENT_MODEL}` unresolved; Step 0 asks for it via the selection prompt **after** printing the banner.

Every subsequent spawn instruction below references `{AGENT_MODEL}` — substitute the resolved value when making the actual tool call. Do NOT mix tiers within a single run.
