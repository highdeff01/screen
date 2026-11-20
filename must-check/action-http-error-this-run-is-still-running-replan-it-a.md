# Recurring app action/error — http-error
- signature: `server:http-error:this run is still running; replan it after it finishes.`
- seen: **3×**, first 2026-11-20T00:27:53.588Z, last 2026-11-20T00:29:01.777Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
This run is still running; replan it after it finishes.
```
## Context
```json
{
  "code": 409,
  "method": "POST",
  "url": "/api/runs/run_mwo8ly493d0e22/replan-retry"
}
```
## AI suggestion

This error indicates a stale API call from a previous failed attempt is still being retried by the system. The `code: 409` and message "This run is still running" confirm that the backend has not yet terminated the old request, likely because the script polls an endpoint or holds an open connection to `/api/runs/...`.

It is safe to ignore only if you are certain this specific instance will complete successfully on its own; however, since the error occurred twice within 13 seconds, it suggests a potential retry loop where the script attempts to re-run a failed task.

The smallest concrete fix is to add a `setTimeout` delay of at least 60 seconds before attempting to re-trigger this specific run ID, ensuring the backend has fully cleaned up the previous execution context.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
