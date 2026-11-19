# Recurring app action/error — /api/state
- signature: `ui:/api/state:request timed out.`
- seen: **2×**, first 2026-11-19T00:24:41.653Z, last 2026-11-19T09:56:20.273Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Request timed out.
```
## Context
```json
{
  "view": "builder",
  "at": 0,
  "href": "http://127.0.0.1:4317/"
}
```
## AI suggestion

Likely cause: stale caller holding a previous `state` id while the endpoint no longer exists.
Safe to ignore: No, this is a blocking error preventing state updates; ignoring will leave the UI broken.
Smallest fix: Remove the `/api/state` polling loop and update the script to check for new IDs before re-fetching.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
