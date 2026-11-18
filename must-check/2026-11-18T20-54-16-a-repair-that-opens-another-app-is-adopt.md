# Auto-test failure — 2026-11-18T20:54:16.520Z

- queued id: `sent_mwmln8aw8ab9f3`
- failing: 6 of a repair that opens another app is adopted by the presenter and verifier (25031.6746ms),the engine rewrites the remainder after an irreparable action and still passes (20084.3471ms),three real failing runs pause the shared budget and reset re-enables the scheduler (5154.4555ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js (425.3481ms),a failed launch is repaired by focusing the existing window and the run passes (30182.952ms),cancellation during retry backoff prevents another attempt (15011.5411ms) tests
  - ✖ a repair that opens another app is adopted by the presenter and verifier (25031.6746ms)
  - ✖ the engine rewrites the remainder after an irreparable action and still passes (20084.3471ms)
  - ✖ three real failing runs pause the shared budget and reset re-enables the scheduler (5154.4555ms)
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js (425.3481ms)
  - ✖ a failed launch is repaired by focusing the existing window and the run passes (30182.952ms)
  - ✖ cancellation during retry backoff prevents another attempt (15011.5411ms)

## Output tail

```
1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'running',
    expected: 'failed',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\presentation-live.test.js:18:1
✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js (425.3481ms)
  Error: EPERM, Permission denied: 'C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\tmp-live-tlXviE'
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
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\test\\tmp-live-tlXviE',
    syscall: 'rm'
  }

test at test\repair.test.js:264:1
✖ a failed launch is repaired by focusing the existing window and the run passes (30182.952ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'running'
  - 'passed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/repair.test.js:283:10)
      at runNextTicks (node:internal/process/task_queues:65:5)
      at process.processTimers (node:internal/timers:615:9)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'running',
    expected: 'passed',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\run-retry.test.js:138:1
✖ cancellation during retry backoff prevents another attempt (15011.5411ms)
  Error: Timed out waiting for run state
      at until (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/run-retry.test.js:121:39)
      at async settleQueue (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/run-retry.test.js:132:3)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/run-retry.test.js:139:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
