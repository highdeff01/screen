# Recurring app action/error — /api/state
- signature: `ui:/api/state:failed to fetch`
- seen: **2×**, first 2026-11-19T14:57:08.606Z, last 2026-11-19T17:07:31.554Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Failed to fetch
```
## Context
```json
{
  "view": "builder",
  "at": 0,
  "href": "https://de0538570e7147d68d55-cool-unit-jezrcsa8.builderio.dev/?reload=1795118779787&builder.preview=interact"
}
```
## AI suggestion

The script is likely retrying an endpoint that has been deleted or moved, causing a stale 404 error. The evidence shows the action `/api/state` was called twice with a `reload=1795118779787` parameter, indicating it's polling a specific URL rather than fetching fresh data. This is safe to ignore if no other errors occur.

## Notes for the fixer



(append findings here; auto-sync carries this file to GitHub and back)
