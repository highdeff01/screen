# Recurring app action/error — run-failed:VLC parked at 02:36 / 02:36 (numeric readout)
- signature: `run:run-failed:vlc parked at #:# / #:# (numeric readout):screen check failed (#%): the vlc media player window is visible in the background (left side of the screen), but it is not playing a video. the main content ar`
- seen: **1×**, first 2026-11-18T23:24:53.872Z, last 2026-11-18T23:24:53.872Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Screen check failed (100%): The VLC media player window is visible in the background (left side of the screen), but it is not playing a video. The main content area shows a text document with many paragraphs and a terminal-like code editor on the left. The taskbar at the bottom shows multiple open applications including Chrome, Firefox, and others. | The VLC window is present but inactive (not playing video). The expected state requires the VLC media player to be visible and actively playing a video. [captures/cap_mwmr092kb5a56d.png] | repair chain exhausted: Media hold could not read the player clock: No seek slider or time display found in the foreground media window.
At line:93 char:3
+   throw 'No seek slider or time display found in the foreground media ...
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : OperationStopped: (No seek slider ...d media window.:String) [], RuntimeException
    + FullyQualifiedErrorId : No seek slider or time display found in the foreground media window.
```
## Context
```json
{
  "runId": "run_mwmqsutd7871b0",
  "status": "failed"
}
```
## AI suggestion

The screen-automation tool is trying to control VLC, but it cannot because the window is inactive and not displaying a video player interface.
This is safe to ignore if you do not need to automate VLC specifically; simply skip this task or use a different automation tool for media playback.

## Notes for the fixer



(append findings here; auto-sync carries this file to GitHub and back)
