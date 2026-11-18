# Auto-test failure — 2026-11-18T21:55:13.632Z

- queued id: `sent_mwmntm5cb37d10`
- failing: 8 of a repair that opens another app is adopted by the presenter and verifier (25003.6712ms),the engine rewrites the remainder after an irreparable action and still passes (20675.3834ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795038791414-3548\test\agent-replan.test.js (545.2213ms),three real failing runs pause the shared budget and reset re-enables the scheduler (5041.5592ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795038791414-3548\test\presentation-live.test.js (296.9877ms),cancellation during retry backoff prevents another attempt (15006.2315ms),pause during retry backoff holds the retry until resumed (15007.0138ms),cancellation during a failed attempt does not start a retry (3002.0071ms) tests
  - ✖ a repair that opens another app is adopted by the presenter and verifier — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/agent-replan.test.js:378 — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  - ✖ the engine rewrites the remainder after an irreparable action and still passes — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/agent-replan.test.js:425 — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795038791414-3548\test\agent-replan.test.js — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/agent-replan.test.js:21
  - ✖ three real failing runs pause the shared budget and reset re-enables the scheduler — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/presentation-live.test.js:99 — AssertionError [ERR_ASSERTION]: attempt 1 failed
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795038791414-3548\test\presentation-live.test.js — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/presentation-live.test.js:23
  - ✖ cancellation during retry backoff prevents another attempt — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/run-retry.test.js:121
  - ✖ pause during retry backoff holds the retry until resumed — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/run-retry.test.js:121
  - ✖ cancellation during a failed attempt does not start a retry — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/run-retry.test.js:121

## Output tail

```
 (node:internal/test_runner/test:1757:18)
      at TestHook.run (node:internal/util:581:20)
      at Test.runHook (node:internal/test_runner/test:1289:20)
      at after (node:internal/test_runner/test:1342:20)
      at Test.run (node:internal/test_runner/test:1428:13) {
    errno: 1,
    code: 'EPERM',
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\data\\worktrees\\sentinel-1795038791414-3548\\test\\tmp-live-wAHGTo',
    syscall: 'rm'
  }

test at test\run-retry.test.js:138:1
✖ cancellation during retry backoff prevents another attempt (15006.2315ms)
  Error: Timed out waiting for run state
      at until (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/run-retry.test.js:121:39)
      at async settleQueue (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/run-retry.test.js:132:3)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/run-retry.test.js:139:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)

test at test\run-retry.test.js:154:1
✖ pause during retry backoff holds the retry until resumed (15007.0138ms)
  Error: Timed out waiting for run state
      at until (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/run-retry.test.js:121:39)
      at async settleQueue (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/run-retry.test.js:132:3)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/run-retry.test.js:155:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)

test at test\run-retry.test.js:179:1
✖ cancellation during a failed attempt does not start a retry (3002.0071ms)
  Error: Timed out waiting for run state
      at until (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/run-retry.test.js:121:39)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038791414-3548/test/run-retry.test.js:190:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
