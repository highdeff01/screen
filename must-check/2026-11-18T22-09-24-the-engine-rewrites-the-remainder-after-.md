# Auto-test failure — 2026-11-18T22:09:24.421Z

- queued id: `sent_mwmobumc45c119`
- failing: 3 of the engine rewrites the remainder after an irreparable action and still passes (20108.2717ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795039684552-33992\test\agent-replan.test.js (352.9763ms),three real failing runs pause the shared budget and reset re-enables the scheduler (14063.1746ms) tests
  - ✖ the engine rewrites the remainder after an irreparable action and still passes
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795039684552-33992\test\agent-replan.test.js
  - ✖ three real failing runs pause the shared budget and reset re-enables the scheduler

## Output tail

```
ory (1.787ms)
ℹ tests 446
ℹ suites 0
ℹ pass 439
ℹ fail 3
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 78190.0147

✖ failing tests:

test at test\agent-replan.test.js:391:1
✖ the engine rewrites the remainder after an irreparable action and still passes (20108.2717ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'running'
  - 'passed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795039684552-33992/test/agent-replan.test.js:426:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'running',
    expected: 'passed',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\agent-replan.test.js:16:1
✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795039684552-33992\test\agent-replan.test.js (352.9763ms)
  Error: EPERM, Permission denied: 'C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795039684552-33992\test\tmp-agent-replan-b35RPh'
      at Object.rmSync (node:fs:1593:18)
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795039684552-33992/test/agent-replan.test.js:21:8)
      at TestHook.runInAsyncScope (node:async_hooks:226:14)
      at TestHook.run (node:internal/test_runner/test:1402:25)
      at TestHook.run (node:internal/test_runner/test:1757:18)
      at TestHook.run (node:internal/util:581:20)
      at Test.runHook (node:internal/test_runner/test:1289:20)
      at after (node:internal/test_runner/test:1342:20)
      at Test.run (node:internal/test_runner/test:1428:13) {
    errno: 1,
    code: 'EPERM',
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\data\\worktrees\\sentinel-1795039684552-33992\\test\\tmp-agent-replan-b35RPh',
    syscall: 'rm'
  }

test at test\presentation-live.test.js:73:1
✖ three real failing runs pause the shared budget and reset re-enables the scheduler (14063.1746ms)
  AssertionError [ERR_ASSERTION]: attempt 3 failed
  + actual - expected
  
  + 'running'
  - 'failed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795039684552-33992/test/presentation-live.test.js:99:12)
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
