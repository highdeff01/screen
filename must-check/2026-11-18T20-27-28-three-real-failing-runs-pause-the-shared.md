# Auto-test failure — 2026-11-18T20:27:28.082Z

- queued id: `sent_mwmkor826c819c`
- failing: 2 of three real failing runs pause the shared budget and reset re-enables the scheduler (5055.3343ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js (402.3751ms) tests
  - ✖ three real failing runs pause the shared budget and reset re-enables the scheduler (5055.3343ms)
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js (402.3751ms)

## Output tail

```
hange warnings (0.7683ms)
✔ screenshot and note steps are not re-audited with a second capture (0.469ms)
✔ a finished run becomes a scored, reusable workflow episode (65.7467ms)
✔ similar goals recall the prior sequence and its hindrances (1.964ms)
✔ a different subject is not reused as the remembered question (0.3647ms)
✔ a passed episode whose typed question contradicts its goal is excluded (1.0398ms)
✔ a recalled episode can seed a plan with its conditions intact (0.7412ms)
✔ the same run is replaced instead of duplicated (0.8092ms)
✔ state summary exposes memory counts without full step payloads (0.3197ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.4776ms)
✔ a newer matching pass gets a recency advantage over an older one (12.8748ms)
✔ a recent failed run applies a success-trend penalty to matching memory (2.8052ms)
✔ template lookup backfills historical runs before selecting a live template (1.0711ms)
✔ a changed app version blocks reuse of a versioned memory (1.0113ms)
ℹ tests 396
ℹ suites 0
ℹ pass 390
ℹ fail 2
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 43027.1794

✖ failing tests:

test at test\presentation-live.test.js:73:1
✖ three real failing runs pause the shared budget and reset re-enables the scheduler (5055.3343ms)
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

test at test\presentation-live.test.js:18:1
✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js (402.3751ms)
  Error: EPERM, Permission denied: 'C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\tmp-live-7rXohr'
      at Object.rmSync (node:fs:1593:18)
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/presentation-live.test.js:23:8)
      at TestHook.runInAsyncScope (node:async_hooks:226:14)
      at TestHook.run (node:internal/test_runner/test:1402:25)
      at TestHook.run (node:internal/test_runner/test:1757:18)
      at TestHook.run (node:internal/util:581:20)
      at Test.runHook (node:internal/test_runner/test:1289:20)
      at after (node:internal/test_runner/test:1342:20)
      at Test.run (node:internal/test_runner/test:1428:13) {
    errno: 1,
    code: 'EPERM',
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\test\\tmp-live-7rXohr',
    syscall: 'rm'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
