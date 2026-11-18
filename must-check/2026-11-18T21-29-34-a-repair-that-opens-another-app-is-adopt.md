# Auto-test failure — 2026-11-18T21:29:34.561Z

- queued id: `sent_mwmmwmldaf3f27`
- failing: 4 of a repair that opens another app is adopted by the presenter and verifier (25018.997ms),the engine rewrites the remainder after an irreparable action and still passes (20068.7027ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795037308185-15988\test\agent-replan.test.js (210.425ms),cancellation during retry backoff prevents another attempt (15002.8738ms) tests
  - ✖ a repair that opens another app is adopted by the presenter and verifier
  - ✖ the engine rewrites the remainder after an irreparable action and still passes
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795037308185-15988\test\agent-replan.test.js
  - ✖ cancellation during retry backoff prevents another attempt

## Output tail

```
d',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\agent-replan.test.js:391:1
✖ the engine rewrites the remainder after an irreparable action and still passes (20068.7027ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  0 !== 1
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795037308185-15988/test/agent-replan.test.js:425:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 0,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\agent-replan.test.js:16:1
✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795037308185-15988\test\agent-replan.test.js (210.425ms)
  Error: EPERM, Permission denied: 'C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795037308185-15988\test\tmp-agent-replan-R9dmEl'
      at Object.rmSync (node:fs:1593:18)
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795037308185-15988/test/agent-replan.test.js:21:8)
      at TestHook.runInAsyncScope (node:async_hooks:226:14)
      at TestHook.run (node:internal/test_runner/test:1402:25)
      at TestHook.run (node:internal/test_runner/test:1757:18)
      at TestHook.run (node:internal/util:581:20)
      at Test.runHook (node:internal/test_runner/test:1289:20)
      at after (node:internal/test_runner/test:1342:20)
      at Test.run (node:internal/test_runner/test:1428:13) {
    errno: 1,
    code: 'EPERM',
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\data\\worktrees\\sentinel-1795037308185-15988\\test\\tmp-agent-replan-R9dmEl',
    syscall: 'rm'
  }

test at test\run-retry.test.js:138:1
✖ cancellation during retry backoff prevents another attempt (15002.8738ms)
  Error: Timed out waiting for run state
      at until (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795037308185-15988/test/run-retry.test.js:121:39)
      at async settleQueue (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795037308185-15988/test/run-retry.test.js:132:3)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795037308185-15988/test/run-retry.test.js:139:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
