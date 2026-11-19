# Auto-test failure — 2026-11-19T01:12:56.059Z

- queued id: `sent_mwmuvv974d8bca`
- failing: 8 of the engine rewrites the remainder after an irreparable action and still passes (20041.2022ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795050402033-29612\test\agent-replan.test.js (292.4871ms),a failed launch is repaired by focusing the existing window and the run passes (30163.413ms),repairs that fail are reported and safe later steps still run (30106.7536ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795050402033-29612\test\repair.test.js (759.7139ms),cancellation during retry backoff prevents another attempt (15000.3286ms),pause during retry backoff holds the retry until resumed (15005.9006ms),cancellation during a failed attempt does not start a retry (3003.297ms) tests
  - ✖ the engine rewrites the remainder after an irreparable action and still passes — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/agent-replan.test.js:426 — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795050402033-29612\test\agent-replan.test.js — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/agent-replan.test.js:21
  - ✖ a failed launch is repaired by focusing the existing window and the run passes — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/repair.test.js:283 — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  - ✖ repairs that fail are reported and safe later steps still run — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/repair.test.js:311 — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795050402033-29612\test\repair.test.js — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/repair.test.js:20
  - ✖ cancellation during retry backoff prevents another attempt — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/run-retry.test.js:121
  - ✖ pause during retry backoff holds the retry until resumed — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/run-retry.test.js:121
  - ✖ cancellation during a failed attempt does not start a retry — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/run-retry.test.js:121

## Output tail

```
ernal/test_runner/test:1757:18)
      at TestHook.run (node:internal/util:581:20)
      at Test.runHook (node:internal/test_runner/test:1289:20)
      at after (node:internal/test_runner/test:1342:20)
      at Test.run (node:internal/test_runner/test:1428:13) {
    errno: 1,
    code: 'EPERM',
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\data\\worktrees\\sentinel-1795050402033-29612\\test\\tmp-repair-6oCi6L',
    syscall: 'rm'
  }

test at test\run-retry.test.js:138:1
✖ cancellation during retry backoff prevents another attempt (15000.3286ms)
  Error: Timed out waiting for run state
      at until (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/run-retry.test.js:121:39)
      at async settleQueue (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/run-retry.test.js:132:3)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/run-retry.test.js:139:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)

test at test\run-retry.test.js:154:1
✖ pause during retry backoff holds the retry until resumed (15005.9006ms)
  Error: Timed out waiting for run state
      at until (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/run-retry.test.js:121:39)
      at async settleQueue (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/run-retry.test.js:132:3)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/run-retry.test.js:155:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)

test at test\run-retry.test.js:179:1
✖ cancellation during a failed attempt does not start a retry (3003.297ms)
  Error: Timed out waiting for run state
      at until (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/run-retry.test.js:121:39)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795050402033-29612/test/run-retry.test.js:190:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
