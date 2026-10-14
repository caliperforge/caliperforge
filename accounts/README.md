# Accounts

One file per account: who matters there, where we meet them, what they need, what is open, the rules we keep with
them and what has happened. The `account_lead` seat reads its account's file each run and appends to its `## Log`.

The seat corrects the seed from sources on its first run.

Each file follows this shape, with `unknown` where a value is not known:

```markdown
# <account>

## People

### <name>
- Role: <role>
- How we know them: <how>
- Last contact: <YYYY-MM-DD>, <what was said or promised>
- Notes: <notes>

## Repos and channels

## Needs

## Open work

## Rules

## Log

- YYYY-MM-DD <what happened>
```

Log rows run oldest first.
