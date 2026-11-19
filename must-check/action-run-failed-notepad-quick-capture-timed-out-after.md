# Recurring app action/error — run-failed:Notepad quick capture
- signature: `run:run-failed:notepad quick capture:timed out after #ms waiting for window to be present: notepad.exe at line:# char:# + ... not $met) { throw timed out after #ms waiting for window to be p ... + `
- seen: **1×**, first 2026-11-19T04:10:50.128Z, last 2026-11-19T04:10:50.128Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Timed out after 12000ms waiting for window to be present: notepad.exe
At line:44 char:18
+ ... not $met) { throw 'Timed out after 12000ms waiting for window to be p ...
+                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : OperationStopped: (Timed out after...nt: notepad.exe:String) [], RuntimeException
    + FullyQualifiedErrorId : Timed out after 12000ms waiting for window to be present: notepad.exe | repair chain exhausted: Screen check failed before vision: the active window is "Untitled - Notepad" (Notepad), not "notepad.exe". Switch to the right app instead of accepting another window.
```
## Context
```json
{
  "runId": "run_mwn124lp013574",
  "status": "failed"
}
```
## AI suggestion

The screen automation script is failing because it cannot locate the actual Notepad application window; instead, it is detecting a stale "Untitled - Notepad" window from a previous failed attempt. The error explicitly states the active window is "Untitled - Notepad (Notepad)" rather than "notepad.exe", indicating the process was killed or replaced by another instance. This is safe to ignore as long as you do not retry this specific run-id, but if it recurs, the fix is to clear the browser cache and restart the automation tool to force a fresh window creation.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
