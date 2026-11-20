# Recurring app action/error — /api/runs/run_mwo8ly493d0e22/replan-retry
- signature: `ui:/api/runs/run_mwo#ly#d#e#/replan-retry:this run is still running; replan it after it finishes.`
- seen: **3×**, first 2026-11-20T00:27:53.595Z, last 2026-11-20T00:29:02.162Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
This run is still running; replan it after it finishes.
```
## Context
```json
{
  "view": "runs",
  "at": 1795134541742,
  "href": "http://127.0.0.1:4317/"
}
```
## AI suggestion

This is a stale caller error where the script polls a running run endpoint instead of waiting for completion.
Safe to ignore only if you are polling a live production API and do not need the specific run ID; otherwise, fix the polling logic.
Remove the retry loop or change the `at` parameter to match the actual run's lifecycle state before re-polling.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
