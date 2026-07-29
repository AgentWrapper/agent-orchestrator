# ao review

Manage AO code reviews of a worker's PR.

## Syntax

```
ao review <subcommand> [args] [flags]
```

## Subcommands

---

### ao review submit

Record a reviewer's result for a worker's PR.

**Syntax:**
```
ao review submit [worker-session-id] [flags]
```

**Flags:**

| Flag | Meaning | Default / Required |
|---|---|---|
| `--body string` | Review body: a path to a Markdown file, or `-` to read from stdin | - |
| `--review-id string` | Id of the GitHub PR review just posted (the `.id` from the `gh api` POST that created the review) | - |
| `--reviews string` | JSON review results array or object: a path, or `-` to read from stdin | - |
| `--run string` | Review run id | Required |
| `--session string` | Worker session id (or pass it as the positional argument) | - |
| `--verdict string` | Review verdict: `approved` or `changes_requested` | Required |
| `--addressed` | Reply to and resolve provider review feedback addressed by this run through the AO backend | - |

## Examples

```bash
# Submit an approved review for session mer-3
ao review submit mer-3 --run review-run-1 --verdict approved
```

```bash
# Submit a changes-requested review with a body from stdin
echo "Please fix the null check on line 42." | ao review submit --session mer-3 --run review-run-1 --verdict changes_requested --body -
```

```bash
# After addressing feedback, ask AO to reply and resolve the matching provider review threads
echo "Addressed by adding the nil check and regression test." | ao review submit --addressed --session mer-3 --run review-run-1 --review-id PRR_kwDOExample --body -
```
