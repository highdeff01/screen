# Auto-test failure — 2026-11-19T10:01:15.527Z

- queued id: `sent_mwndrapz471087`
- failing: 9 of the engine executes an AI replacement and records the repair (20173.9889ms),a repair that opens another app is adopted by the presenter and verifier (25322.894ms),the engine rewrites the remainder after an irreparable action and still passes (45041.9394ms),API mutations require a valid same-host Origin when one is present (6673.9243ms),continuation requires explicit approval of a tested candidate and queues exactly one retry (30006.6303ms),a type step with a named window proves its destination instead of guessing from the screen (14815.3079ms),a display-name launch target confirms the process it really focused (14328.0257ms),chat() reaches the console provider through the local gateway (25589.8873ms),HTTP endpoints expose state, validate actions and reject cross-origin starts (7012.4048ms),observation review uses stored evidence and is read-only (11940.2145ms) tests
  - ✖ the engine executes an AI replacement and records the repair
  - ✖ a repair that opens another app is adopted by the presenter and verifier
  - ✖ the engine rewrites the remainder after an irreparable action and still passes
  - ✖ API mutations require a valid same-host Origin when one is present
  - ✖ continuation requires explicit approval of a tested candidate and queues exactly one retry
  - ✖ a type step with a named window proves its destination instead of guessing from the screen
  - ✖ a display-name launch target confirms the process it really focused
  - ✖ chat() reaches the console provider through the local gateway
  - ✖ HTTP endpoints expose state, validate actions and reject cross-origin starts
  - ✖ observation review uses stored evidence and is read-only

## Output tail

```
e,
    code: 'ERR_ASSERTION',
    actual: 'running',
    expected: 'passed',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\engine-screen.test.js:109:1
✖ a display-name launch target confirms the process it really focused (14328.0257ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'running'
  - 'passed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/engine-screen.test.js:139:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'running',
    expected: 'passed',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\gateway.test.js:130:1
✖ chat() reaches the console provider through the local gateway (25589.8873ms)
  AssertionError [ERR_ASSERTION]: fetch failed
  
  false !== true
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/gateway.test.js:135:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\live-preview.test.js:259:1
✖ HTTP endpoints expose state, validate actions and reject cross-origin starts (7012.4048ms)
  AssertionError [ERR_ASSERTION]: server started
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/live-preview.test.js:281:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: undefined,
    expected: true,
    operator: '==',
    diff: 'simple'
  }

test at test\observation-review-http.test.js:26:1
✖ observation review uses stored evidence and is read-only (11940.2145ms)
  AssertionError [ERR_ASSERTION]: Sightline console running at http://127.0.0.1:53395
  Data: C:\Users\Dan\AppData\Local\Temp\observation-review-http-T680KC\data
  Platform: win32 — live control via Windows (PowerShell + Win32 SendInput; capture: PowerShell + System.Drawing).
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/observation-review-http.test.js:53:12)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
