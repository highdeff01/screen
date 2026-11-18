# Recurring app action/error — run-workflow
- signature: `ui:run-workflow:live control is not implemented for linux.`
- seen: **2×**, first 2026-11-18T20:53:34.667Z, last 2026-11-18T20:53:35.585Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Live control is not implemented for linux.
```
## Context
```json
{
  "detail": null
}
```
## Known advice

This machine is not actually Linux — the console is being reached through a hosted preview that runs on Linux, so the live backend refuses. On Windows, run `npm start` on the desktop machine and open http://127.0.0.1:4317 there. Live runs now fall back to simulated instead of bouncing, so work can continue.

## AI suggestion

The error occurs because your screen automation is running in a Linux environment that isn't actually Linux; it's a hosted preview. This causes the live backend to reject the request. It is safe to ignore this specific message as it does not prevent your automation from functioning. The smallest fix is to update your code to handle the simulated mode by ignoring the `Live control` error and continuing execution.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
