# Auto-test failure — 2026-11-19T04:08:29.185Z

- queued id: `sent_mwn15mo1c07156`
- failing: 2 of a no-op click that changed nothing and has no confirmation still fails (12908.7133ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795061109088-36368\test\engine-screen.test.js (441.7849ms) tests
  - ✖ a no-op click that changed nothing and has no confirmation still fails
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795061109088-36368\test\engine-screen.test.js

## Output tail

```
18ms)
✔ a recalled episode can seed a plan with its conditions intact (0.4499ms)
✔ the same run is replaced instead of duplicated (0.329ms)
✔ state summary exposes memory counts without full step payloads (0.226ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.415ms)
✔ a newer matching pass gets a recency advantage over an older one (13.1977ms)
✔ a recent failed run applies a success-trend penalty to matching memory (1.5457ms)
✔ template lookup backfills historical runs before selecting a live template (1.079ms)
✔ a changed app version blocks reuse of a versioned memory (1.4571ms)
✔ unavailable backend falls back for every resolved live mode before queuing (2658.8102ms)
﹣ available backend permits both saved and explicit live modes (0.4538ms) # SKIP
ℹ tests 540
ℹ suites 0
ℹ pass 533
ℹ fail 2
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
ℹ duration_ms 189425.9989

✖ failing tests:

test at test\engine-screen.test.js:145:1
✖ a no-op click that changed nothing and has no confirmation still fails (12908.7133ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'running'
  - 'failed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795061109088-36368/test/engine-screen.test.js:163:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'running',
    expected: 'failed',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\engine-screen.test.js:14:1
✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795061109088-36368\test\engine-screen.test.js (441.7849ms)
  Error: EPERM, Permission denied: 'C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\data\worktrees\sentinel-1795061109088-36368\test\tmp-engine-screen-tOCnWO'
      at Object.rmSync (node:fs:1593:18)
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795061109088-36368/test/engine-screen.test.js:19:8)
      at TestHook.runInAsyncScope (node:async_hooks:226:14)
      at TestHook.run (node:internal/test_runner/test:1402:25)
      at TestHook.run (node:internal/test_runner/test:1757:18)
      at TestHook.run (node:internal/util:581:20)
      at Test.runHook (node:internal/test_runner/test:1289:20)
      at after (node:internal/test_runner/test:1342:20)
      at Test.run (node:internal/test_runner/test:1428:13) {
    errno: 1,
    code: 'EPERM',
    path: 'C:\\Users\\Dan\\.config\\freebuff-desktop\\local-projects\\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\\data\\worktrees\\sentinel-1795061109088-36368\\test\\tmp-engine-screen-tOCnWO',
    syscall: 'rm'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
