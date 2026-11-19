# Recurring app action/error — /api/state
- signature: `ui:/api/state:request timed out.`
- seen: **2×**, first 2026-11-19T17:37:42.299Z, last 2026-11-19T18:14:12.125Z
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
  "href": "https://de0538570e7147d68d55-cool-unit-jezrcsa8.builderio.dev/?reload=1795119481621&builder.preview=interact"
}
```
## AI suggestion

Likely cause is a stale caller holding an old builder state ID or retry loop polling an endpoint that no longer exists. Safe to ignore only if the UI remains functional and errors do not propagate; otherwise, fix by updating the `/api/state` method to use a fresh `builderId` and remove any polling logic for this specific URL.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
