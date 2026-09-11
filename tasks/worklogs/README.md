# Local Task Worklogs

Worklogs preserve execution continuity for meaningful multi-step tasks. Files in this directory are ignored by default because even operational notes can reveal sensitive financial context.

Use `tasks/worklogs/<task-slug>.md` with this structure:

```md
# Task

## Current Ask

## Decisions

## Working State

## Verification

## Next
```

Keep entries concise and evidence-oriented. Never include account identifiers, balances, transactions, credentials, documents, or derived financial totals. Preserve a worklog in Git only when explicitly requested and fully sanitized.
