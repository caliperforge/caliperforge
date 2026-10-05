# Log

- daily: 3–5 learning items for the day, with no post.

A log is internal, for the operator: what went wrong that day, what it taught and what fixed it.

## Daily

A daily reply is only this closing fence, with no post and no other key. Each item's `what` rests on a
`[landed:N]` or `[refusal:N]` the packet holds, and two items never share a title.

---
items: <JSON list of 3–5 {"title": ..., "what": ..., "lesson": ..., "fix": ..., "status": ...}, status one of fixed, open, ruled or noted>
---

## Examples

### Example 1

```
---
items: [{"title": "A weakened test went green", "what": "A build dropped an assertion and its run still passed [refusal:12]", "lesson": "A green run says nothing once the test is weaker", "fix": "The fence compares the assertions before and after the diff", "status": "fixed"}, {"title": "The writer drafts from the packet", "what": "The writer seat now reads what the day landed [landed:7]", "lesson": "A post written from the packet cites only what landed", "fix": "The draft step hands the writer the packet and nothing else", "status": "noted"}, {"title": "A refusal that names no test", "what": "A refused build left the builder guessing which test it broke [refusal:15]", "lesson": "A refusal that names no test costs a whole rebuild", "fix": "None yet: the refusal still names the fix first", "status": "open"}]
---
```

### Example 2

```
---
items: [{"title": "Two plans on one prompt", "what": "Two plans edited the same prompt and the second waited on the first [landed:21]", "lesson": "Plans that share a file cannot build side by side", "fix": "The operator ruled that the later plan waits for the earlier to land", "status": "ruled"}, {"title": "A token in a fixture", "what": "A test fixture carried a live-looking token and the scan refused it [refusal:30]", "lesson": "A fixture that looks like a secret is treated as one", "fix": "Fixtures use a token the scan knows is fake", "status": "fixed"}, {"title": "CI red on a moved base", "what": "The base moved under a green build and CI went red after the merge [refusal:33]", "lesson": "Green on an old base proves nothing about the new one", "fix": "None yet: the build is not rerun when the base moves", "status": "open"}, {"title": "Digests trail a prompt edit", "what": "A prompt edit landed before its digest was filled [landed:24]", "lesson": "Every prompt edit carries its digest in the same change", "fix": "The kernel fills digests before review", "status": "noted"}]
---
```
