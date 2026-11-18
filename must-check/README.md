# Must-check

This is the one folder every agent, app and person agrees to read **before**
touching the project — and the one folder every failure report lands in.

How it works:

- The **Sentinel** (the console watching itself) runs the test suite whenever the
  project's source files change, in a separate process. Every failing run is
  written here as a dated markdown report, queued in the console's repair queue,
  and left as a handoff note for the next agent.
- Auto-sync commits and pushes this folder to GitHub, and pulls it back down, so
  every connected app and agent sees the same stream without anyone wiring
  anything new up.
- Anyone — human, agent, or another app — may append findings, fixes and
  follow-up questions directly to a report. Auto-sync carries your words back to
  every other machine.
- Reports older than the newest 40 are pruned automatically; anything worth
  keeping long-term should be promoted into `docs/` or a handoff note.

Emergency rule: if a report is open and unresolved, fix or explicitly dismiss it
before large changes. The console's own repair queue (Sentinel page) shows the
same list with AI-drafted plans.
