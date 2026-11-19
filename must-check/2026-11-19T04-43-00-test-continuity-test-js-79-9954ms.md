# Auto-test failure — 2026-11-19T04:43:00.516Z

- queued id: `sent_mwn2e0x0c70fd5`
- failing: 30 of test\continuity.test.js (79.9954ms),test\deliberation.test.js (78.3565ms),test\engine-screen.test.js (131.8504ms),test\focus-launch.test.js (124.8242ms),test\foreground-presenter.test.js (84.5865ms),test\goal-status.test.js (80.3731ms),test\live-fallback.test.js (91.5261ms),test\live-monitor.test.js (83.8296ms),HTTP endpoints expose state, validate actions and reject cross-origin starts (6228.7243ms),test\nudge.test.js (148.6406ms),observation review uses stored evidence and is read-only (175.992ms),test\output-file.test.js (94.8571ms),test\planner.test.js (86.9786ms),test\preflight.test.js (77.808ms),test\presentation-audit.test.js (87.0381ms),test\presentation-index.test.js (101.1471ms),test\presentation-live.test.js (104.3109ms),test\presentations-deep.test.js (131.7373ms),test\repair.test.js (91.8068ms),test\replan.test.js (95.308ms),test\research.test.js (97.8226ms),test\run-recovery.test.js (86.7559ms),test\run-retry.test.js (111.6173ms),test\sendkeys.test.js (73.3519ms),test\shortcuts.test.js (78.8317ms),test\silent-file-check.test.js (93.7943ms),test\step-effects.test.js (104.9355ms),test\step-factoring.test.js (144.0802ms),test\verification-loop.test.js (89.0851ms),unavailable backend falls back for every resolved live mode before queuing (209.1636ms) tests
  - ✖ test\continuity.test.js — test/continuity.test.js
  - ✖ test\deliberation.test.js — test/deliberation.test.js
  - ✖ test\engine-screen.test.js — test/engine-screen.test.js
  - ✖ test\focus-launch.test.js — test/focus-launch.test.js
  - ✖ test\foreground-presenter.test.js — test/foreground-presenter.test.js
  - ✖ test\goal-status.test.js — test/goal-status.test.js
  - ✖ test\live-fallback.test.js — test/live-fallback.test.js
  - ✖ test\live-monitor.test.js — test/live-monitor.test.js
  - ✖ HTTP endpoints expose state, validate actions and reject cross-origin starts — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795063352219-34484/test/live-preview.test.js:281 — AssertionError [ERR_ASSERTION]: server started
  - ✖ test\nudge.test.js — test/nudge.test.js
  - ✖ observation review uses stored evidence and is read-only — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795063352219-34484/server/automation.js:1156 — SyntaxError: Unexpected token 'case'
  - ✖ test\output-file.test.js — test/output-file.test.js
  - ✖ test\planner.test.js — test/planner.test.js
  - ✖ test\preflight.test.js — test/preflight.test.js
  - ✖ test\presentation-audit.test.js — test/presentation-audit.test.js
  - ✖ test\presentation-index.test.js — test/presentation-index.test.js
  - ✖ test\presentation-live.test.js — test/presentation-live.test.js
  - ✖ test\presentations-deep.test.js — test/presentations-deep.test.js
  - ✖ test\repair.test.js — test/repair.test.js
  - ✖ test\replan.test.js — test/replan.test.js
  - ✖ test\research.test.js — test/research.test.js
  - ✖ test\run-recovery.test.js — test/run-recovery.test.js
  - ✖ test\run-retry.test.js — test/run-retry.test.js
  - ✖ test\sendkeys.test.js — test/sendkeys.test.js
  - ✖ test\shortcuts.test.js — test/shortcuts.test.js
  - ✖ test\silent-file-check.test.js — test/silent-file-check.test.js
  - ✖ test\step-effects.test.js — test/step-effects.test.js
  - ✖ test\step-factoring.test.js — test/step-factoring.test.js
  - ✖ test\verification-loop.test.js — test/verification-loop.test.js
  - ✖ unavailable backend falls back for every resolved live mode before queuing — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795063352219-34484/server/automation.js:1156 — SyntaxError: Unexpected token 'case'

## Output tail

```
st.js (101.1471ms)
  'test failed'

test at test\presentation-live.test.js:1:1
✖ test\presentation-live.test.js (104.3109ms)
  'test failed'

test at test\presentations-deep.test.js:1:1
✖ test\presentations-deep.test.js (131.7373ms)
  'test failed'

test at test\repair.test.js:1:1
✖ test\repair.test.js (91.8068ms)
  'test failed'

test at test\replan.test.js:1:1
✖ test\replan.test.js (95.308ms)
  'test failed'

test at test\research.test.js:1:1
✖ test\research.test.js (97.8226ms)
  'test failed'

test at test\run-recovery.test.js:1:1
✖ test\run-recovery.test.js (86.7559ms)
  'test failed'

test at test\run-retry.test.js:1:1
✖ test\run-retry.test.js (111.6173ms)
  'test failed'

test at test\sendkeys.test.js:1:1
✖ test\sendkeys.test.js (73.3519ms)
  'test failed'

test at test\shortcuts.test.js:1:1
✖ test\shortcuts.test.js (78.8317ms)
  'test failed'

test at test\silent-file-check.test.js:1:1
✖ test\silent-file-check.test.js (93.7943ms)
  'test failed'

test at test\step-effects.test.js:1:1
✖ test\step-effects.test.js (104.9355ms)
  'test failed'

test at test\step-factoring.test.js:1:1
✖ test\step-factoring.test.js (144.0802ms)
  'test failed'

test at test\verification-loop.test.js:1:1
✖ test\verification-loop.test.js (89.0851ms)
  'test failed'

test at test\workflow-run-mode.test.js:75:1
✖ unavailable backend falls back for every resolved live mode before queuing (209.1636ms)
  Error: Server exited: file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795063352219-34484/server/automation.js:1156
      case 'wait':
      ^^^^
  
  SyntaxError: Unexpected token 'case'
      at compileSourceTextModule (node:internal/modules/esm/utils:355:16)
      at ModuleLoader.moduleStrategy (node:internal/modules/esm/translators:94:18)
      at #translate (node:internal/modules/esm/loader:441:20)
      at afterLoad (node:internal/modules/esm/loader:509:29)
      at ModuleLoader.loadAndTranslate (node:internal/modules/esm/loader:514:12)
      at #getOrCreateModuleJobAfterResolve (node:internal/modules/esm/loader:567:36)
      at afterResolve (node:internal/modules/esm/loader:614:52)
      at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:620:12)
      at ModuleJob.syncLink (node:internal/modules/esm/module_job:277:33)
      at ModuleJob.link (node:internal/modules/esm/module_job:389:17)
  
  Node.js v26.13.0
  
      at startServer (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795063352219-34484/test/workflow-run-mode.test.js:56:40)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795063352219-34484/test/workflow-run-mode.test.js:76:16)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.

## Dismissed — 2026-11-19

Caught the working tree mid-edit (`automation.js` had a half-written `case`); the settled source parses and the full suite passes. Verified on `d6711c9`: `npm test` → 589 tests, 584 pass, 0 fail, 5 skipped.

Dismissed in the repair queue after that run; re-open it if the same failure returns.
