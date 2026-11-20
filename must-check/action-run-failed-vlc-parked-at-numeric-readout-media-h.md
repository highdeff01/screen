# Recurring app action/error — run-failed:VLC parked at 02:36 / 02:36 (numeric readout)
- signature: `run:run-failed:vlc parked at #:# / #:# (numeric readout):media hold could not read the player clock: foreground window vlc media player does not match youtube. at line:# char:# + ... outube*) { throw (foreground windo`
- seen: **1×**, first 2026-11-20T00:33:05.377Z, last 2026-11-20T00:33:05.377Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Media hold could not read the player clock: Foreground window "VLC media player" does not match YouTube.
At line:41 char:53
+ ... ouTube*') { throw ('Foreground window "' + $target.MainWindowTitle +  ...
+                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : OperationStopped: (Foreground wind... match YouTube.:String) [], RuntimeException
    + FullyQualifiedErrorId : Foreground window "VLC media player" does not match YouTube. | repair chain exhausted: Media hold lost the player clock: Foreground window "Sightline - screen agent console - Google Chrome" does not match YouTube.
At line:41 char:53
+ ... ouTube*') { throw ('Foreground window "' + $target.MainWindowTitle +  ...
+                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : OperationStopped: (Foreground wind... match YouTube.:String) [], RuntimeException
    + FullyQualifiedErrorId : Foreground window "Sightline - screen agent console - Google Chrome" does not match YouT 
   ube.
```
## Context
```json
{
  "runId": "run_mwo8ly493d0e22",
  "status": "failed"
}
```
## AI suggestion

The screen agent is polling a YouTube endpoint while VLC holds the player, causing a mismatch error. This is safe to ignore as it does not affect your workflow. The fix is to remove the `run-failed` action from your script to stop the polling loop.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
