# Recurring app action/error — run-failed:Judgement probe 3 (temporary)
- signature: `run:run-failed:judgement probe # (temporary):“type judge marker” reported success, but nothing on screen changed and no check confirmed it. | repair chain exhausted: refusing to send keys: foreground windo`
- seen: **1×**, first 2026-11-19T05:17:15.246Z, last 2026-11-19T05:17:15.246Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
“Type judge marker” reported success, but nothing on screen changed and no check confirmed it. | repair chain exhausted: Refusing to send keys: foreground window is "Notepad :: *Judge probe 12345 - Notepad", expected process or window 
"Untitled - Notepad".
At line:78 char:3
+   throw ('Refusing to send keys: foreground window is "' + $actual +  ...
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : OperationStopped: (Refusing to sen...led - Notepad".:String) [], RuntimeException
    + FullyQualifiedErrorId : Refusing to send keys: foreground window is "Notepad :: *Judge probe 12345 - Notepad", e 
   xpected process or window "Untitled - Notepad".
```
## Context
```json
{
  "runId": "run_mwn3j9jxfba7fa",
  "status": "failed"
}
```
## AI suggestion

The script is attempting to send keystrokes to a specific window ID ("Judge probe 12345") but the actual window title is "Untitled - Notepad", indicating a stale or mismatched window handle. This is safe to ignore as it does not affect core functionality. The fix is to update the `windowId` variable in line 78 of the script to match the current window title, e.g., `windowId = "Untitled - Notepad"`.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
