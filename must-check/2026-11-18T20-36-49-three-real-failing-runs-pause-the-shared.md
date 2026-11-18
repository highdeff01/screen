# Auto-test failure — 2026-11-18T20:36:49.555Z

- queued id: `sent_mwml0sgj6a0635`
- failing: 1 of three real failing runs pause the shared budget and reset re-enables the scheduler (5104.9352ms) tests
  - ✖ three real failing runs pause the shared budget and reset re-enables the scheduler (5104.9352ms)

## Output tail

```
install phase gets no install methods (0.3391ms)
✔ a review that settles the check finishes the run and says so (63.9448ms)
✔ open checks are re-reviewed and the screen baseline is taken once (0.7218ms)
✔ screen reads wait while the person at the desk is typing (0.8572ms)
✔ learned habits are offered as workarounds once the check keeps failing (1.0701ms)
✔ a check that never settles is declared stalled with a strategy suggestion (5.315ms)
✔ a live step that has not moved for minutes is reported as blocked once (2.5551ms)
✔ a failed run keeps its queued check as history and is not polled (0.8137ms)
✔ each further review of the same run waits longer (1.7053ms)
✔ a queued check left open for hours is marked stale, not re-read (0.4101ms)
✔ one pass reviews only a handful of fresh runs (36.7974ms)
✔ the loop starts, ticks and stops (1412.011ms)
✔ identical screen signatures report no change (1.1349ms)
✔ a visible cell change is measured as a percentage (0.2472ms)
✔ small noise below the channel threshold is ignored (0.1522ms)
✔ hashes are stable and change with the grid (0.2749ms)
✔ copy and focus steps do not trigger false no-change warnings (0.2673ms)
✔ screenshot and note steps are not re-audited with a second capture (0.1386ms)
✔ a finished run becomes a scored, reusable workflow episode (69.9466ms)
✔ similar goals recall the prior sequence and its hindrances (1.869ms)
✔ a different subject is not reused as the remembered question (0.3499ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.7766ms)
✔ a recalled episode can seed a plan with its conditions intact (0.4912ms)
✔ the same run is replaced instead of duplicated (0.3657ms)
✔ state summary exposes memory counts without full step payloads (0.2628ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.4505ms)
✔ a newer matching pass gets a recency advantage over an older one (10.5256ms)
✔ a recent failed run applies a success-trend penalty to matching memory (0.6107ms)
✔ template lookup backfills historical runs before selecting a live template (0.4491ms)
✔ a changed app version blocks reuse of a versioned memory (0.6078ms)
ℹ tests 418
ℹ suites 0
ℹ pass 413
ℹ fail 1
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 44049.7029

✖ failing tests:

test at test\presentation-live.test.js:73:1
✖ three real failing runs pause the shared budget and reset re-enables the scheduler (5104.9352ms)
  AssertionError [ERR_ASSERTION]: attempt 1 failed
  + actual - expected
  
  + 'running'
  - 'failed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/presentation-live.test.js:99:12)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'running',
    expected: 'failed',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
