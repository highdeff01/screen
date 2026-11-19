# Auto-test failure — 2026-11-19T20:31:43.724Z

- queued id: `sent_mwo0a3580d5251`
- failing: 1 of share proxy only forwards safe reads and dry executions (22.1477ms) tests
  - ✖ share proxy only forwards safe reads and dry executions

## Output tail

```
shes the run and says so (83.7239ms)
✔ open checks are re-reviewed and the screen baseline is taken once (1.1238ms)
✔ screen reads wait while the person at the desk is typing (0.8182ms)
✔ learned habits are offered as workarounds once the check keeps failing (0.5179ms)
✔ a check that never settles is declared stalled with a strategy suggestion (7.7735ms)
✔ a live step that has not moved for minutes is reported as blocked once (0.8273ms)
✔ a failed run keeps its queued check as history and is not polled (0.6123ms)
✔ each further review of the same run waits longer (0.7705ms)
✔ a queued check left open for hours is marked stale, not re-read (0.4167ms)
✔ one pass reviews only a handful of fresh runs (21.1633ms)
✔ the loop starts, ticks and stops (1419.5578ms)
✔ status reports an unconfigured tester honestly (59.1247ms)
✔ status validates the URL and honours a settings-configured endpoint (0.5931ms)
✔ testScreenshot refuses to run without configuration, then posts the protocol payload (47.2535ms)
✔ rememberVisualTest keeps the newest tests on the proposal (0.9424ms)
✔ identical screen signatures report no change (2.4791ms)
✔ a visible cell change is measured as a percentage (0.2889ms)
✔ small noise below the channel threshold is ignored (0.1986ms)
✔ hashes are stable and change with the grid (0.2989ms)
✔ copy and focus steps do not trigger false no-change warnings (0.3937ms)
✔ screenshot and note steps are not re-audited with a second capture (0.2162ms)
✔ a finished run becomes a scored, reusable workflow episode (54.5053ms)
✔ similar goals recall the prior sequence and its hindrances (1.2935ms)
✔ a different subject is not reused as the remembered question (0.2393ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.9888ms)
✔ a recalled episode can seed a plan with its conditions intact (0.6016ms)
✔ the same run is replaced instead of duplicated (0.3404ms)
✔ state summary exposes memory counts without full step payloads (0.1918ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.3266ms)
✔ a newer matching pass gets a recency advantage over an older one (8.3374ms)
✔ a recent failed run applies a success-trend penalty to matching memory (0.6435ms)
✔ template lookup backfills historical runs before selecting a live template (0.4901ms)
✔ a changed app version blocks reuse of a versioned memory (0.611ms)
✔ unavailable backend falls back for every resolved live mode before queuing (2709.247ms)
﹣ available backend permits both saved and explicit live modes (0.2063ms) # SKIP
ℹ tests 595
ℹ suites 0
ℹ pass 589
ℹ fail 1
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
ℹ duration_ms 145316.8579

✖ failing tests:

test at test\share.test.js:71:1
✖ share proxy only forwards safe reads and dry executions (22.1477ms)
  Error: connect EACCES 127.0.0.1:58560
      at TCPConnectWrap.afterConnect [as oncomplete] (node:net:2083:16) {
    errno: -4092,
    code: 'EACCES',
    syscall: 'connect',
    address: '127.0.0.1',
    port: 58560
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
