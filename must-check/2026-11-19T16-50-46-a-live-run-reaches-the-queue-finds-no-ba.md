# Auto-test failure — 2026-11-19T16:50:46.353Z

- queued id: `sent_mwnsdxoxba848c`
- failing: 1 of a live run reaches the queue, finds no backend, and continues simulated (5782.398ms) tests
  - ✖ a live run reaches the queue, finds no backend, and continues simulated

## Output tail

```
eline is taken once (1.3085ms)
✔ screen reads wait while the person at the desk is typing (0.5737ms)
✔ learned habits are offered as workarounds once the check keeps failing (0.4407ms)
✔ a check that never settles is declared stalled with a strategy suggestion (3.9267ms)
✔ a live step that has not moved for minutes is reported as blocked once (0.41ms)
✔ a failed run keeps its queued check as history and is not polled (0.351ms)
✔ each further review of the same run waits longer (0.4174ms)
✔ a queued check left open for hours is marked stale, not re-read (0.2282ms)
✔ one pass reviews only a handful of fresh runs (11.4333ms)
✔ the loop starts, ticks and stops (1412.487ms)
✔ identical screen signatures report no change (1.3006ms)
✔ a visible cell change is measured as a percentage (0.1588ms)
✔ small noise below the channel threshold is ignored (0.1092ms)
✔ hashes are stable and change with the grid (0.1703ms)
✔ copy and focus steps do not trigger false no-change warnings (0.2444ms)
✔ screenshot and note steps are not re-audited with a second capture (0.1198ms)
✔ a finished run becomes a scored, reusable workflow episode (49.1695ms)
✔ similar goals recall the prior sequence and its hindrances (1.6045ms)
✔ a different subject is not reused as the remembered question (0.2322ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.5658ms)
✔ a recalled episode can seed a plan with its conditions intact (0.2663ms)
✔ the same run is replaced instead of duplicated (0.2185ms)
✔ state summary exposes memory counts without full step payloads (0.2112ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.4168ms)
✔ a newer matching pass gets a recency advantage over an older one (8.5803ms)
✔ a recent failed run applies a success-trend penalty to matching memory (0.7814ms)
✔ template lookup backfills historical runs before selecting a live template (0.6213ms)
✔ a changed app version blocks reuse of a versioned memory (0.9823ms)
✔ unavailable backend falls back for every resolved live mode before queuing (1133.9348ms)
﹣ available backend permits both saved and explicit live modes (0.1935ms) # SKIP
ℹ tests 567
ℹ suites 0
ℹ pass 561
ℹ fail 1
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
ℹ duration_ms 110385.6642

✖ failing tests:

test at test\live-fallback.test.js:26:1
✖ a live run reaches the queue, finds no backend, and continues simulated (5782.398ms)
  AssertionError [ERR_ASSERTION]: the run continues as simulation
  
  false !== true
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795106934445-19040/test/live-fallback.test.js:48:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: 'strictEqual',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.

## Resolution — dismissed as a mid-edit snapshot

The failure came from the sentinel's throwaway worktree while the source and its
test were being changed in the same minute: `server/engine.js` had gained the
`liveFallback` field on a run, but the probe that must confirm the refusal had
not been added yet, so the run stayed live and the old assertion ("the run
continues as simulation") failed with `false !== true`. The test file in that
snapshot was the older `16f70a0` version, which no longer exists at HEAD.

The same sentinel now reports its own suite green on `4f96e16`:
`586 tests, 581 pass, 0 fail, 5 skipped`. Re-ran locally after the change with
the same result (`npm test`, exit 0). Nothing to fix in the tree.
