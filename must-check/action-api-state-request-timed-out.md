# Recurring app action/error — /api/state
- signature: `ui:/api/state:request timed out.`
- observed twice in each recorded context:
  - 2026-11-19T00:24:41.653Z–2026-11-19T09:56:20.273Z at `http://127.0.0.1:4317/`
  - 2026-11-19T17:37:42.299Z–2026-11-19T18:14:12.125Z at the Builder preview URL recorded in the original local report
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Request timed out.
```
## Context
The reports came from two different preview contexts: a local preview at `http://127.0.0.1:4317/` and the Builder preview recorded in the original local report. Preserve the original Builder URL in the git history rather than repeating its reload token here.

## AI suggestion

The reports suggest a timeout in the state-request path, but do not establish whether the caller is stale or whether polling should be removed. Inspect the current `/api/state` caller and endpoint before changing either; do not remove polling based on this report alone.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
