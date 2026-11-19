# Recurring app action/error — /api/state
- signature: `ui:/api/state:failed to fetch`
- seen: **2×**, first 2026-11-18T23:34:48.479Z, last 2026-11-18T23:52:21.582Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Failed to fetch
```
## Context
```json
{
  "view": "runs",
  "at": 1795043655814,
  "href": "http://127.0.0.1:4317/"
}
```
## AI suggestion

The browser is likely blocked by CORS or the API endpoint requires headers not sent in your request.
It is safe to ignore if you are running a local dev server and the backend isn't actually responding.
Add `fetch('/api/state', { method: 'GET' })` to ensure headers like `Content-Type` are included.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
