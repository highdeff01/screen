# Auto-test failure — 2026-11-18T21:18:46.350Z

- queued id: `sent_mwmmiqfi02e373`
- failing: 3 of chat() reaches the console provider through the local gateway (363.3868ms),three real failing runs pause the shared budget and reset re-enables the scheduler (5180.1077ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795036674162-29060\test\presentation-live.test.js (237.4682ms) tests
  - ✖ chat() reaches the console provider through the local gateway
  - ✖ three real failing runs pause the shared budget and reset re-enables the scheduler
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795036674162-29060\test\presentation-live.test.js

## Output tail

```
re selecting a live template (2.0005ms)
✔ a changed app version blocks reuse of a versioned memory (1.862ms)
ℹ tests 439
ℹ suites 0
ℹ pass 432
ℹ fail 3
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 50347.6804

✖ failing tests:

test at test\gateway.test.js:130:1
✖ chat() reaches the console provider through the local gateway (363.3868ms)
  AssertionError [ERR_ASSERTION]: fetch failed
  
  false !== true
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795036674162-29060/test/gateway.test.js:135:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\presentation-live.test.js:73:1
✖ three real failing runs pause the shared budget and reset re-enables the scheduler (5180.1077ms)
  AssertionError [ERR_ASSERTION]: attempt 1 failed
  + actual - expected
  
  + 'running'
  - 'failed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795036674162-29060/test/presentation-live.test.js:99:12)
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
✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795036674162-29060\test\presentation-live.test.js (237.4682ms)
  Error: EPERM, Permission denied: 'C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795036674162-29060\test\tmp-live-PwOKtW'
      at Object.rmSync (node:fs:1593:18)
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795036674162-29060/test/presentation-live.test.js:23:8)
      at TestHook.runInAsyncScope (node:async_hooks:226:14)
      at TestHook.run (node:internal/test_runner/test:1402:25)
      at TestHook.run (node:internal/test_runner/test:1757:18)
      at TestHook.run (node:internal/util:581:20)
      at Test.runHook (node:internal/test_runner/test:1289:20)
      at after (node:internal/test_runner/test:1342:20)
      at Test.run (node:internal/test_runner/test:1428:13) {
    errno: 1,
    code: 'EPERM',
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\data\\worktrees\\sentinel-1795036674162-29060\\test\\tmp-live-PwOKtW',
    syscall: 'rm'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
