# Recurring app action/error — start-run:Notepad quick capture
- signature: `run:start-run:notepad quick capture:linux live control needs an x# display (including xwayland), xdotool on path for input.`
- seen: **2×**, first 2026-11-19T17:00:07.703Z, last 2026-11-19T17:03:14.343Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Linux live control needs an X11 DISPLAY (including XWayland), xdotool on PATH for input.
```
## Context
```json
{
  "workflowId": "wf_notepad_smoke",
  "requestedMode": "live",
  "runId": "run_mwnstyua6cf10a"
}
```
## Known advice

This machine is not actually Linux — the console is being reached through a hosted preview that runs on Linux, so the live backend refuses. On Windows, run `npm start` on the desktop machine and open http://127.0.0.1:4317 there. Live runs now fall back to simulated instead of bouncing, so work can continue.

## AI suggestion

The error indicates a Linux backend requirement that is not met because you are running on Windows; this is safe to ignore as it prevents the automation from starting. The fix is to run `npm start` locally and open http://127.0.0.1:4317 instead of using the live control method.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
