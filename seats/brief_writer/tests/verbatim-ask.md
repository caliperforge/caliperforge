# A seat that briefs before any build

**What:** the seat writes its settings file with this block, word for word:

```yaml
seat: brief_writer
effort: high
```

**Why:** a builder that retypes the block drifts from it.
**When it ends:** the settings file holds the block unchanged.
