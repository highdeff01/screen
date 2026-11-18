# Auto-test failure — 2026-11-18T22:03:54.280Z

- queued id: `sent_mwmo4rvsd0b0ef`
- failing: 4 of a repair that opens another app is adopted by the presenter and verifier (25047.3658ms),the engine rewrites the remainder after an irreparable action and still passes (20101.5723ms),three real failing runs pause the shared budget and reset re-enables the scheduler (5201.9706ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795039341968-16836\test\presentation-live.test.js (176.3747ms) tests
  - ✖ a repair that opens another app is adopted by the presenter and verifier
  - ✖ the engine rewrites the remainder after an irreparable action and still passes
  - ✖ three real failing runs pause the shared budget and reset re-enables the scheduler
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795039341968-16836\test\presentation-live.test.js

## Output tail

```
age: true,
    code: 'ERR_ASSERTION',
    actual: 'running',
    expected: 'passed',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\agent-replan.test.js:391:1
✖ the engine rewrites the remainder after an irreparable action and still passes (20101.5723ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'running'
  - 'passed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795039341968-16836/test/agent-replan.test.js:426:10)
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
✖ three real failing runs pause the shared budget and reset re-enables the scheduler (5201.9706ms)
  AssertionError [ERR_ASSERTION]: attempt 1 failed
  + actual - expected
  
  + 'running'
  - 'failed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795039341968-16836/test/presentation-live.test.js:99:12)
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
✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795039341968-16836\test\presentation-live.test.js (176.3747ms)
  Error: EPERM, Permission denied: 'C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795039341968-16836\test\tmp-live-R1yEyw'
      at Object.rmSync (node:fs:1593:18)
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795039341968-16836/test/presentation-live.test.js:23:8)
      at TestHook.runInAsyncScope (node:async_hooks:226:14)
      at TestHook.run (node:internal/test_runner/test:1402:25)
      at TestHook.run (node:internal/test_runner/test:1757:18)
      at TestHook.run (node:internal/util:581:20)
      at Test.runHook (node:internal/test_runner/test:1289:20)
      at after (node:internal/test_runner/test:1342:20)
      at Test.run (node:internal/test_runner/test:1428:13) {
    errno: 1,
    code: 'EPERM',
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\data\\worktrees\\sentinel-1795039341968-16836\\test\\tmp-live-R1yEyw',
    syscall: 'rm'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
