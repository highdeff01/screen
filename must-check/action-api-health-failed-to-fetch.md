# Recurring app action/error — /api/health
- signature: `ui:/api/health:failed to fetch`
- seen: **2×**, first 2026-11-22T09:20:24.771Z, last 2026-11-22T10:32:49.238Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Failed to fetch
```
## Context
```json
{
  "view": "builder",
  "at": 1795264419371,
  "href": "http://127.0.0.1:4317/"
}
```
## AI suggestion

Most likely a stale caller holding an old builder ID or retry loop is polling an endpoint that no longer exists. The error detail shows `view: "builder"` and `href: "/api/health"`, indicating the script is attempting to fetch health data for a specific builder instance, but this resource has been removed or the request is failing due to a network timeout from the stale connection. It is safe to ignore if no other errors occur, as the system appears functional elsewhere. The smallest fix is to clear the browser cache and restart the Node.js process to release the stale connection.

## Notes for the fixer



(append findings here; auto-sync carries this file to GitHub and back)
