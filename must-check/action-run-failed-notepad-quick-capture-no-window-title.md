# Recurring app action/error — run-failed:Notepad quick capture
- signature: `run:run-failed:notepad quick capture:no window title contains untitled - notepad at line:# char:# + ... oundwindow) { throw no window title contains untitled - notepad } + ~~~~~~~~~~~~~~~~~~~~~~~~~`
- seen: **1×**, first 2026-11-19T04:05:25.896Z, last 2026-11-19T04:05:25.896Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
No window title contains "Untitled - Notepad"
At line:10 char:26
+ ... oundWindow) { throw 'No window title contains "Untitled - Notepad"' }
+                   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : OperationStopped: (No window title...tled - Notepad":String) [], RuntimeException
    + FullyQualifiedErrorId : No window title contains "Untitled - Notepad" | repair chain exhausted: No window matching title "Untitled - Notepad" or process "".
At line:86 char:21
+ ...  $target) { throw ('No window matching title "' + $title + '" or proc ...
+                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : OperationStopped: (No window match... or process "".:String) [], RuntimeException
    + FullyQualifiedErrorId : No window matching title "Untitled - Notepad" or process "".
```
## Context
```json
{
  "runId": "run_mwn0udx615aa0c",
  "status": "failed"
}
```
## AI suggestion

The script is failing because it cannot find a window with the specific title "Untitled - Notepad", which indicates it is trying to capture an old or stale process instance. This is safe to ignore if you are running this as a scheduled task on a fresh system where the process has already terminated; however, if the error persists during execution, it suggests the automation script is polling for a window that no longer exists. The fix is to update the `run-failed` method in your Node.js code to check for alternative window titles or add logic to skip running if the target title is absent.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
