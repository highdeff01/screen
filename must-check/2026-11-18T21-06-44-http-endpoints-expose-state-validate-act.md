# Auto-test failure — 2026-11-18T21:06:44.452Z

- queued id: `sent_mwmm39es722245`
- failing: 8 of HTTP endpoints expose state, validate actions and reject cross-origin starts (6864.687ms),observation review uses stored evidence and is read-only (1013.225ms),a failing run can be read through several lenses, each kept (57.7897ms),an offline model leaves an error on the opinion, not a crash (2.4488ms),a passing run is recorded and the queue stays clear (50.8449ms),a failing run is queued, reported to must-check and left as a note (3.6695ms),the queue settles: dismiss and retry move the same item (0.3486ms),a repair plan can be drafted without a model and degrades gracefully (1.4376ms) tests
  - ✖ HTTP endpoints expose state, validate actions and reject cross-origin starts (6864.687ms)
  - ✖ observation review uses stored evidence and is read-only (1013.225ms)
  - ✖ a failing run can be read through several lenses, each kept (57.7897ms)
  - ✖ an offline model leaves an error on the opinion, not a crash (2.4488ms)
  - ✖ a passing run is recorded and the queue stays clear (50.8449ms)
  - ✖ a failing run is queued, reported to must-check and left as a note (3.6695ms)
  - ✖ the queue settles: dismiss and retry move the same item (0.3486ms)
  - ✖ a repair plan can be drafted without a model and degrades gracefully (1.4376ms)

## Output tail

```
local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/server/sentinel.js:84:16)
      at Module.runSentinelNow (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/server/sentinel.js:182:12)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/sentinel.test.js:57:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)

test at test\sentinel.test.js:64:1
✖ a failing run is queued, reported to must-check and left as a note (3.6695ms)
  ReferenceError [Error]: queueFilePath is not defined
      at sentinelStatus (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/server/sentinel.js:84:16)
      at Module.runSentinelNow (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/server/sentinel.js:182:12)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/sentinel.test.js:65:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)

test at test\sentinel.test.js:87:1
✖ the queue settles: dismiss and retry move the same item (0.3486ms)
  ReferenceError [Error]: queueFilePath is not defined
      at Module.sentinelStatus (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/server/sentinel.js:84:16)
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/sentinel.test.js:88:27)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)

test at test\sentinel.test.js:99:1
✖ a repair plan can be drafted without a model and degrades gracefully (1.4376ms)
  ReferenceError [Error]: queueFilePath is not defined
      at sentinelStatus (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/server/sentinel.js:84:16)
      at Module.runSentinelNow (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/server/sentinel.js:182:12)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/sentinel.test.js:100:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7)
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
