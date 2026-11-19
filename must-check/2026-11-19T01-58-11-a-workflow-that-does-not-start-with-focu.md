# Auto-test failure — 2026-11-19T01:58:11.620Z

- queued id: `sent_mwmwi2lgacfe49`
- failing: 2 of a workflow that does not start with focusWindow is left unchanged (60.6968ms),an already repaired plan does not get a second launch step (0.9232ms) tests
  - ✖ a workflow that does not start with focusWindow is left unchanged
  - ✖ an already repaired plan does not get a second launch step

## Output tail

```
 [ERR_ASSERTION]: the repaired plan must not be rewritten
  + actual - expected
  ... Skipped lines
  
    [
      {
        id: 'stp_wf_repaired_probe_0',
  +     intent: 'open',
  +     intentBasis: 'opens or installs an app or page',
        name: 'Open Chrome',
        params: {
          target: 'chrome.exe'
        },
        timeoutMs: 10000,
  ...
        id: 'stp_wf_repaired_probe_1',
  +     intent: 'timing',
  +     intentBasis: 'waits for time or state',
        name: 'Wait for Chrome',
        params: {
          ms: 2000
        },
        timeoutMs: 10000,
  ...
        id: 'stp_wf_repaired_probe_2',
  +     intent: 'window',
  +     intentBasis: 'window management',
        name: 'Focus Chrome',
        params: {
          process: 'chrome',
          title: 'Sightline - screen agent console - Google Chrome'
        },
  ...
        id: 'stp_wf_repaired_probe_3',
  +     intent: 'input-into-window',
  +     intentBasis: 'typing with a named destination window',
        name: 'Ask Chrome',
        params: {
          foreground: 'Chrome',
          text: 'hello'
        },
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795053365716-27352/test/focus-launch.test.js:146:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ { id: 'stp_wf_repaired_probe_0', timeoutMs: 10000, type: 'launchApp', name: 'Open Chrome', params: [Object], intent: 'open', intentBasis: 'opens or installs an app or page' }, { id: 'stp_wf_repaired_probe_1', timeoutMs: 10000, type: 'wait', name: 'Wait for Chrome', params: [Object], intent: 'timing', intentBasis: 'waits for time or state' }, { id: 'stp_wf_repaired_probe_2', timeoutMs: 10000, type: 'focusWindow', name: 'Focus Chrome', params: [Object], intent: 'window', intentBasis: 'window management' }, { id: 'stp_wf_repaired_probe_3', timeoutMs: 10000, type: 'type', name: 'Ask Chrome', params: [Object], intent: 'input-into-window', intentBasis: 'typing with a named destination window' } ],
    expected: [ { id: 'stp_wf_repaired_probe_0', timeoutMs: 10000, type: 'launchApp', name: 'Open Chrome', params: [Object] }, { id: 'stp_wf_repaired_probe_1', timeoutMs: 10000, type: 'wait', name: 'Wait for Chrome', params: [Object] }, { id: 'stp_wf_repaired_probe_2', timeoutMs: 10000, type: 'focusWindow', name: 'Focus Chrome', params: [Object] }, { id: 'stp_wf_repaired_probe_3', timeoutMs: 10000, type: 'type', name: 'Ask Chrome', params: [Object] } ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
