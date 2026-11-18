# Auto-test failure — 2026-11-18T22:09:40.710Z

- queued id: `sent_mwmoc76ue0951c`
- failing: 3 of a repair that opens another app is adopted by the presenter and verifier (25112.3574ms),three real failing runs pause the shared budget and reset re-enables the scheduler (5090.2904ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795039707738-26396\test\presentation-live.test.js (254.9055ms) tests
  - ✖ a repair that opens another app is adopted by the presenter and verifier
  - ✖ three real failing runs pause the shared budget and reset re-enables the scheduler
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795039707738-26396\test\presentation-live.test.js

## Output tail

```
ned memory (1.2491ms)
ℹ tests 447
ℹ suites 0
ℹ pass 440
ℹ fail 3
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 70525.3237

✖ failing tests:

test at test\agent-replan.test.js:334:1
✖ a repair that opens another app is adopted by the presenter and verifier (25112.3574ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'running'
  - 'passed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795039707738-26396/test/agent-replan.test.js:378:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'running',
    expected: 'passed',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\presentation-live.test.js:73:1
✖ three real failing runs pause the shared budget and reset re-enables the scheduler (5090.2904ms)
  AssertionError [ERR_ASSERTION]: attempt 1 failed
  + actual - expected
  
  + 'running'
  - 'failed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795039707738-26396/test/presentation-live.test.js:99:12)
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
✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795039707738-26396\test\presentation-live.test.js (254.9055ms)
  Error: EPERM, Permission denied: 'C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795039707738-26396\test\tmp-live-f0miTs'
      at Object.rmSync (node:fs:1593:18)
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795039707738-26396/test/presentation-live.test.js:23:8)
      at TestHook.runInAsyncScope (node:async_hooks:226:14)
      at TestHook.run (node:internal/test_runner/test:1402:25)
      at TestHook.run (node:internal/test_runner/test:1757:18)
      at TestHook.run (node:internal/util:581:20)
      at Test.runHook (node:internal/test_runner/test:1289:20)
      at after (node:internal/test_runner/test:1342:20)
      at Test.run (node:internal/test_runner/test:1428:13) {
    errno: 1,
    code: 'EPERM',
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\data\\worktrees\\sentinel-1795039707738-26396\\test\\tmp-live-f0miTs',
    syscall: 'rm'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
