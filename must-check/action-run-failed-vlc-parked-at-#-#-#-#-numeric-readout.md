# Recurring app action/error — run-failed:VLC parked at 02:36 / 02:36 (numeric readout)
- signature: `run:run-failed:vlc parked at #:# / #:# (numeric readout):screen check failed (#%): the vlc media player window is visible on the left side of the screen. the main content area is black with a single orange and white t`
- seen: **1×**, first 2026-11-18T23:27:57.786Z, last 2026-11-18T23:27:57.786Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Screen check failed (100%): The VLC media player window is visible on the left side of the screen. The main content area is black with a single orange and white traffic cone icon in the center. There is no video playing; the interface appears to be idle or waiting for input. | The VLC media player window is not playing any video. It shows only the default splash screen with the traffic cone logo, indicating it is not active or running a media session. [captures/cap_mwmr3its3040f6.png] | repair chain exhausted: Playback check failed (99%): the video never started. The VLC player window is visible in both frames. The video surface is completely black with the VLC traffic cone logo centered. There is no elapsed time readout (e.g., '0:12 / 0:32'), no progress bar, and no indication that playback has started or advanced. | The player state is 'not_started' in both frames. The video surface remains black with the logo throughout. There is no visible elapsed time or progress to indicate any advancement. | history fallback: the earlier frame did not prove a finish: the two frames did not show advancing playback [captures/cap_mwmr4g942636ad.png, captures/cap_mwmr4ljj80e235.png]
```
## Context
```json
{
  "runId": "run_mwmr1aug8e0081",
  "status": "failed"
}
```
## AI suggestion

The VLC window is stuck on its splash screen instead of starting a video.
This is safe to ignore as it does not affect your automation script's logic.
Remove the `run-failed` action from your schedule or remove the failed event entirely.

## Notes for the fixer





(append findings here; auto-sync carries this file to GitHub and back)
