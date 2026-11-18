# Auto-test failure — 2026-11-18T21:10:49.318Z

- queued id: `sent_mwmm8icm1dd84e`
- failing: 3 of a failed staging push stops before verification (1.4304ms),three real failing runs pause the shared budget and reset re-enables the scheduler (5108.4752ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js (210.9415ms) tests
  - ✖ a failed staging push stops before verification (1.4304ms)
  - ✖ three real failing runs pause the shared budget and reset re-enables the scheduler (5108.4752ms)
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js (210.9415ms)

## Output tail

```
96ms)
✔ a newer matching pass gets a recency advantage over an older one (27.5356ms)
✔ a recent failed run applies a success-trend penalty to matching memory (1.1417ms)
✔ template lookup backfills historical runs before selecting a live template (2.0313ms)
✔ a changed app version blocks reuse of a versioned memory (3.1586ms)
ℹ tests 438
ℹ suites 0
ℹ pass 431
ℹ fail 3
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 52790.7982

✖ failing tests:

test at test\auto-branch.test.js:142:1
✖ a failed staging push stops before verification (1.4304ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /auto\/main/. Input:
  
  'rejected'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/auto-branch.test.js:154:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'rejected',
    expected: /auto\/main/,
    operator: 'match',
    diff: 'simple'
  }

test at test\presentation-live.test.js:73:1
✖ three real failing runs pause the shared budget and reset re-enables the scheduler (5108.4752ms)
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
✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js (210.9415ms)
  Error: EPERM, Permission denied: 'C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\tmp-live-z3mZ0B'
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
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\test\\tmp-live-z3mZ0B',
    syscall: 'rm'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
