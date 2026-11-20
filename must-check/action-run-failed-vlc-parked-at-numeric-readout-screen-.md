# Recurring app action/error — run-failed:VLC parked at 02:36 / 02:36 (numeric readout)
- signature: `run:run-failed:vlc parked at #:# / #:# (numeric readout):screen check failed (vision #%) | the user expects a playing video, but the screen shows a blank/black video area with just the vlc logo.: a different window is`
- seen: **1×**, first 2026-11-20T00:28:10.489Z, last 2026-11-20T00:28:10.489Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Screen check failed (vision 100%) | The user expects a playing video, but the screen shows a blank/black video area with just the VLC logo.: a different window is in front (hwnd 66874, “Sightline - screen agent console - Google Chrome”), not the run's window (hwnd 1247530) · window facts: fail — a different window is in front (hwnd 66874, “Sightline - screen agent console - Google Chrome”), not the run's window (hwnd 1247530) [captures/cap_mwo8kd538e6c63.png] | repair chain exhausted: UI element not found: “playButton” in vlc after trying [playButton] and a vision fallback (element not present).
```
## Context
```json
{
  "runId": "run_mwo8g97x5cd785",
  "status": "failed"
}
```
## AI suggestion

The error indicates a window conflict where VLC's UI is blocked by a foreground Chrome console window. This is safe to ignore as it does not affect system stability. The fix requires closing the "Sightline - screen agent console" window in Chrome before retrying, or disabling its auto-run functionality if persistent.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
