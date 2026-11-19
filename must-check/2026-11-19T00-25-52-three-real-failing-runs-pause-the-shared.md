# Auto-test failure — 2026-11-19T00:25:52.646Z

- queued id: `sent_mwmt7cp2c1e895`
- failing: 6 of three real failing runs pause the shared budget and reset re-enables the scheduler (5083.9996ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js (490.8252ms),repairs that fail are reported and safe later steps still run (30058.4528ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\repair.test.js (382.4758ms),cancellation during retry backoff prevents another attempt (15004.0704ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\step-effects.test.js (23590.8025ms) tests
  - ✖ three real failing runs pause the shared budget and reset re-enables the scheduler
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js
  - ✖ repairs that fail are reported and safe later steps still run
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\repair.test.js
  - ✖ cancellation during retry backoff prevents another attempt
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\step-effects.test.js

## Output tail

```
15:1
✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\repair.test.js (382.4758ms)
  Error: EPERM, Permission denied: 'C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\tmp-repair-ttOL26'
      at Object.rmSync (node:fs:1593:18)
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/repair.test.js:20:8)
      at TestHook.runInAsyncScope (node:async_hooks:226:14)
      at TestHook.run (node:internal/test_runner/test:1402:25)
      at TestHook.run (node:internal/test_runner/test:1757:18)
      at TestHook.run (node:internal/util:581:20)
      at Test.runHook (node:internal/test_runner/test:1289:20)
      at after (node:internal/test_runner/test:1342:20)
      at Test.run (node:internal/test_runner/test:1428:13) {
    errno: 1,
    code: 'EPERM',
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\test\\tmp-repair-ttOL26',
    syscall: 'rm'
  }

test at test\run-retry.test.js:138:1
✖ cancellation during retry backoff prevents another attempt (15004.0704ms)
  Error: Timed out waiting for run state
      at until (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/run-retry.test.js:121:39)
      at async settleQueue (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/run-retry.test.js:132:3)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/run-retry.test.js:139:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)

test at test\step-effects.test.js:140:1
✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\step-effects.test.js (23590.8025ms)
  Error: EPERM, Permission denied: 'C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\tmp-step-effects-70cvN2'
      at Object.rmSync (node:fs:1593:18)
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/step-effects.test.js:147:8)
      at TestHook.runInAsyncScope (node:async_hooks:226:14)
      at TestHook.run (node:internal/test_runner/test:1402:25)
      at TestHook.run (node:internal/test_runner/test:1757:18)
      at TestHook.run (node:internal/util:581:20)
      at Test.runHook (node:internal/test_runner/test:1289:20)
      at after (node:internal/test_runner/test:1342:20)
      at Test.run (node:internal/test_runner/test:1428:13) {
    errno: 1,
    code: 'EPERM',
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\test\\tmp-step-effects-70cvN2',
    syscall: 'rm'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
