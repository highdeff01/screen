# Auto-test failure — 2026-11-19T22:22:19.881Z

- queued id: `sent_mwo48bmx583b03`
- failing: 1 of the mirror is cloned once, then follows GitHub in both directions (7512.5273ms) tests
  - ✖ the mirror is cloned once, then follows GitHub in both directions

## Output tail

```
 queued check left open for hours is marked stale, not re-read (0.7167ms)
✔ one pass reviews only a handful of fresh runs (14.6346ms)
✔ the loop starts, ticks and stops (1408.9537ms)
✔ status reports an unconfigured tester honestly (50.2781ms)
✔ status validates the URL and honours a settings-configured endpoint (0.4508ms)
✔ testScreenshot refuses to run without configuration, then posts the protocol payload (47.9817ms)
✔ rememberVisualTest keeps the newest tests on the proposal (0.4783ms)
✔ identical screen signatures report no change (1.213ms)
✔ a visible cell change is measured as a percentage (0.1374ms)
✔ small noise below the channel threshold is ignored (0.1073ms)
✔ hashes are stable and change with the grid (0.1646ms)
✔ copy and focus steps do not trigger false no-change warnings (0.1972ms)
✔ screenshot and note steps are not re-audited with a second capture (0.1034ms)
✔ a finished run becomes a scored, reusable workflow episode (58.5305ms)
✔ similar goals recall the prior sequence and its hindrances (1.9452ms)
✔ a different subject is not reused as the remembered question (0.6496ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.9117ms)
✔ a recalled episode can seed a plan with its conditions intact (0.5886ms)
✔ the same run is replaced instead of duplicated (0.4001ms)
✔ state summary exposes memory counts without full step payloads (0.2742ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.6317ms)
✔ a newer matching pass gets a recency advantage over an older one (11.998ms)
✔ a recent failed run applies a success-trend penalty to matching memory (1.0315ms)
✔ template lookup backfills historical runs before selecting a live template (0.4966ms)
✔ a changed app version blocks reuse of a versioned memory (0.5868ms)
✔ unavailable backend falls back for every resolved live mode before queuing (6348.5215ms)
﹣ available backend permits both saved and explicit live modes (0.3392ms) # SKIP
ℹ tests 600
ℹ suites 0
ℹ pass 594
ℹ fail 1
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
ℹ duration_ms 156623.3039

✖ failing tests:

test at test\backup.test.js:67:1
✖ the mirror is cloned once, then follows GitHub in both directions (7512.5273ms)
  AssertionError [ERR_ASSERTION]: The backup folder is not at the GitHub commit.
  + actual - expected
  
  + 'The backup folder is not at the GitHub commit.'
  - ''
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795126780885-2204/test/backup.test.js:88:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'The backup folder is not at the GitHub commit.',
    expected: '',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.

## Resolved

Two real defects in the first cut of `server/backup.js`, both fixed:

1. `ensureMirror` read the origin URL and ran the clone from the project folder
   instead of the root it was given, so a test root mirrored the wrong
   repository. It now takes `root` and uses it for both.
2. After a fast-forward the mirror still reported the pre-merge `behind` count.
   The counts are now cleared on a successful pull or push.

The same test also covers a change made inside the backup folder
flowing back to GitHub, and a pass that would delete tracked files being held
rather than committed. Full suite after the fix: 600 tests, 0 failing.
