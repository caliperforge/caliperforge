# The day

The writer seat now reads what the day landed and drafts the post.
One build was refused because it weakened a test, and the fix names the test first.

---
dest: site
dek: The writer seat drafts the day's post from the packet
sources: [{"claim": "the writer seat drafts the post", "ref": "landed:7"}, {"claim": "one build was refused for a weakened test", "ref": "refusal:3"}]
checks: [{"label": "every number is in a source claim", "ok": true}]
learnings: a refused build names its test before it names its fix
---
