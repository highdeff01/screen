# Auto-test failure — 2026-11-19T03:29:31.416Z

- queued id: `sent_mwmzriu0d108c8`
- failing: 1 of literal prose with braces and modifiers stays literal (1.1069ms) tests
  - ✖ literal prose with braces and modifiers stays literal

## Output tail

```
ueued check as history and is not polled (0.3345ms)
✔ each further review of the same run waits longer (0.3766ms)
✔ a queued check left open for hours is marked stale, not re-read (0.1903ms)
✔ one pass reviews only a handful of fresh runs (7.9274ms)
✔ the loop starts, ticks and stops (1411.4298ms)
✔ identical screen signatures report no change (1.5771ms)
✔ a visible cell change is measured as a percentage (0.163ms)
✔ small noise below the channel threshold is ignored (0.1126ms)
✔ hashes are stable and change with the grid (0.1796ms)
✔ copy and focus steps do not trigger false no-change warnings (0.2037ms)
✔ screenshot and note steps are not re-audited with a second capture (0.1051ms)
✔ a finished run becomes a scored, reusable workflow episode (50.0706ms)
✔ similar goals recall the prior sequence and its hindrances (1.2616ms)
✔ a different subject is not reused as the remembered question (0.1938ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.4179ms)
✔ a recalled episode can seed a plan with its conditions intact (0.2569ms)
✔ the same run is replaced instead of duplicated (0.2077ms)
✔ state summary exposes memory counts without full step payloads (0.154ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.2818ms)
✔ a newer matching pass gets a recency advantage over an older one (7.5352ms)
✔ a recent failed run applies a success-trend penalty to matching memory (0.7066ms)
✔ template lookup backfills historical runs before selecting a live template (0.5718ms)
✔ a changed app version blocks reuse of a versioned memory (0.7689ms)
✔ unavailable backend falls back for every resolved live mode before queuing (3366.6498ms)
﹣ available backend permits both saved and explicit live modes (0.3537ms) # SKIP
ℹ tests 534
ℹ suites 0
ℹ pass 528
ℹ fail 1
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
ℹ duration_ms 130182.8447

✖ failing tests:

test at test\sendkeys.test.js:35:1
✖ literal prose with braces and modifiers stays literal (1.1069ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'literal {{}weird{}} 50{%} {^}up'
  - 'literal {{}}weird{}} 50{%} {^}up'
                ^
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795058837327-27352/test/sendkeys.test.js:36:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'literal {{}weird{}} 50{%} {^}up',
    expected: 'literal {{}}weird{}} 50{%} {^}up',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
