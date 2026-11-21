# Recurring app action/error — /api/health
- signature: `ui:/api/health:failed to fetch`
- seen: **2×**, first 2026-11-19T17:43:27.632Z, last 2026-11-19T17:45:15.233Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Failed to fetch
```
## Context
```json
{
  "view": "builder",
  "at": 1795121018668,
  "href": "https://de0538570e7147d68d55-cool-unit-jezrcsa8.builderio.dev/?reload=1795119481621&builder.preview=interact"
}
```
## AI suggestion

Likely a stale caller holding an old builder session or retry loop. Safe to ignore if the page loads normally after clearing browser cache and closing tabs. Fix: delete the cached file `https://de0538570e7147d68d55-cool-unit-jezrcsa8.builderio.dev/?reload=1795119481621&builder.preview=interact` and clear browser cache.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
