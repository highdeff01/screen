# Auto-test failure — 2026-11-18T20:30:50.155Z

- queued id: `sent_mwmkt357d48145`
- failing: 10 of a receive goes to review, and approving applies the files with backups (16.3895ms),answering settles the request and the asker reads the answer back (1.1085ms),workers cap concurrency and finish everything (151.2362ms),a failing handler is recorded, not lost, and re-enqueue retries (1.4378ms),three real failing runs pause the shared budget and reset re-enables the scheduler (11710.4765ms),C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js (259.5358ms),snapshots need a git repository (3098.0713ms),a snapshot captures the folder without touching any branch (1321.9126ms),a second snapshot and a diff between them (2054.0539ms),transferring changes between versions lands them on the current tree (3137.3399ms) tests
  - ✖ a receive goes to review, and approving applies the files with backups (16.3895ms)
  - ✖ answering settles the request and the asker reads the answer back (1.1085ms)
  - ✖ workers cap concurrency and finish everything (151.2362ms)
  - ✖ a failing handler is recorded, not lost, and re-enqueue retries (1.4378ms)
  - ✖ three real failing runs pause the shared budget and reset re-enables the scheduler (11710.4765ms)
  - ✖ C:\Users\Dan\.config\freebuff-desktop\local-projects\40af3ced-48bf-4a9d-a8b7-cb42815bab8f\test\presentation-live.test.js (259.5358ms)
  - ✖ snapshots need a git repository (3098.0713ms)
  - ✖ a snapshot captures the folder without touching any branch (1321.9126ms)
  - ✖ a second snapshot and a diff between them (2054.0539ms)
  - ✖ transferring changes between versions lands them on the current tree (3137.3399ms)

## Output tail

```
eed a git repository (3098.0713ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  true !== false
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/snapshots.test.js:36:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: true,
    expected: false,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\snapshots.test.js:43:1
✖ a snapshot captures the folder without touching any branch (1321.9126ms)
  AssertionError [ERR_ASSERTION]: no commit was made on any branch
  + actual - expected
  
  + 'd14e8ab582ecaf298f69fc0ddf1d74f56dbdd7b3'
  - ''
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/snapshots.test.js:49:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'd14e8ab582ecaf298f69fc0ddf1d74f56dbdd7b3',
    expected: '',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\snapshots.test.js:57:1
✖ a second snapshot and a diff between them (2054.0539ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /app\.txt/. Input:
  
  ''
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/snapshots.test.js:65:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: '',
    expected: /app\.txt/,
    operator: 'match',
    diff: 'simple'
  }

test at test\snapshots.test.js:71:1
✖ transferring changes between versions lands them on the current tree (3137.3399ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'version two'
  - 'version one'
             ^
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/snapshots.test.js:75:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'version two',
    expected: 'version one',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
