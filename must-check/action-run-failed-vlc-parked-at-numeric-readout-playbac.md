# Recurring app action/error — run-failed:VLC parked at 02:36 / 02:36 (numeric readout)
- signature: `run:run-failed:vlc parked at #:# / #:# (numeric readout):playback check could not start: “youtube video” is not in the foreground (state closed; foreground is “youtube”). the player must be visible before two frames c`
- seen: **1×**, first 2026-11-20T00:48:14.976Z, last 2026-11-20T00:48:14.976Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Playback check could not start: “YouTube video” is not in the foreground (state closed; foreground is “YouTube”). The player must be visible before two frames can prove playback. | repair chain exhausted: Playback check could not start: “YouTube video” is not in the foreground (state closed; foreground is “VLC media player”). The player must be visible before two frames can prove playback.
```
## Context
```json
{
  "runId": "run_mwo993d5412be3",
  "status": "failed"
}
```
## AI suggestion

The screen automation is likely stuck in a retry loop because the script polls for VLC state changes or holds an old video ID, causing it to re-trigger the check repeatedly on a closed player.
This is safe to ignore if the user does not report any errors or crashes; the error indicates a logic issue with how the script verifies playback rather than a system failure.
The fix requires changing the polling interval in the `run` method from 100ms to 2000ms and adding a timeout check to prevent infinite retries on failed checks.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
