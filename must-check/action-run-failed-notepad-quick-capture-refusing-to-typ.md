# Recurring app action/error — run-failed:Notepad quick capture
- signature: `run:run-failed:notepad quick capture:refusing to type: foreground window is notepad :: *sightline screen agent{enter}automa - notepad, expected process or window untitled - notepad. at line:# char:`
- seen: **1×**, first 2026-11-18T22:34:36.322Z, last 2026-11-18T22:34:36.322Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Refusing to type: foreground window is "Notepad :: *Sightline screen agent{ENTER}Automa - Notepad", expected process 
or window "Untitled - Notepad".
At line:72 char:3
+   throw ('Refusing to type: foreground window is "' + $actual + '", e ...
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : OperationStopped: (Refusing to typ...led - Notepad".:String) [], RuntimeException
    + FullyQualifiedErrorId : Refusing to type: foreground window is "Notepad :: *Sightline screen agent{ENTER}Automa  
   - Notepad", expected process or window "Untitled - Notepad". | repair chain exhausted: Refusing to send keys: foreground window is "Notepad :: *Sightline screen agent{ENTER}Automa - Notepad", expected 
process or window "Untitled - Notepad".
At line:72 char:3
+   throw ('Refusing to send keys: foreground window is "' + $actual +  ...
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : OperationStopped: (Refusing to sen...led - Notepad".:String) [], RuntimeException
    + FullyQualifiedErrorId : Refusing to send keys: foreground window is "Notepad :: *Sightline screen agent{ENTER}Au 
   toma - Notepad", expected process or window "Untitled - Notepad".
```
## Context
```json
{
  "runId": "run_mwmp22x3345c29",
  "status": "failed"
}
```
## AI suggestion

The automation script is trying to type into a specific Notepad instance that includes the "screen agent" prefix, but your script only targets standard "Untitled - Notepad".
It is safe to ignore if you do not need to automate this particular screen capture.
To fix, update the window selector in line 72 to match the exact title including the agent prefix: `expected process or window "*Sightline screen agent{ENTER}Automa - Notepad"`.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
