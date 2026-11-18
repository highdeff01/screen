# Recurring app action/error — run-failed:VLC parked at 02:36 / 02:36 (numeric readout)
- signature: `run:run-failed:vlc parked at #:# / #:# (numeric readout):screen check failed (#%): the vlc media player window is visible on the left side of the screen, but it shows a black background with an orange traffic cone ico`
- seen: **1×**, first 2026-11-18T23:18:20.653Z, last 2026-11-18T23:18:20.653Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Screen check failed (100%): The VLC media player window is visible on the left side of the screen, but it shows a black background with an orange traffic cone icon in the center. There is no video playing; the application appears to be idle or waiting for input. | The expected state is that the video should be playing, but the VLC window is empty and inactive. [captures/cap_mwmqqugv53ee46.png] | repair chain exhausted: Playback check could not start: “vlc” is not in the foreground (state background; foreground is “Sticky Notes”). The player must be visible before two frames can prove playback.
```
## Context
```json
{
  "runId": "run_mwmqna0a2dad8e",
  "status": "failed"
}
```
## AI suggestion

The VLC window is likely behind a non-video app like Sticky Notes, causing it to appear black and idle.
It is safe to ignore if you do not need video playback in this specific context.
Move the VLC window to the foreground or open it in front of Sticky Notes.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
