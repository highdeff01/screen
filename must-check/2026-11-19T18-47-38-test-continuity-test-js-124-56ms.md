# Auto-test failure — 2026-11-19T18:47:38.159Z

- queued id: `sent_mwnwk81af15a3e`
- failing: 35 of test\continuity.test.js (124.56ms),configured deep focus reads the current desktop windows each round (19.2397ms),test\deep-focus.test.js (89.4712ms),test\deliberation.test.js (91.4875ms),test\engine-screen.test.js (96.6485ms),test\focus-launch.test.js (86.8646ms),test\foreground-presenter.test.js (97.4575ms),test\goal-status.test.js (85.9428ms),test\live-fallback.test.js (99.922ms),test\live-monitor.test.js (91.5245ms),HTTP endpoints expose state, validate actions and reject cross-origin starts (6266.1804ms),test\missions.test.js (94.9145ms),test\nudge.test.js (99.0645ms),observation review uses stored evidence and is read-only (162.1575ms),test\output-file.test.js (86.4099ms),test\planner.test.js (124.1726ms),test\platform.test.js (77.8211ms),test\preflight.test.js (86.2103ms),test\presentation-audit.test.js (93.7082ms),test\presentation-index.test.js (84.2932ms),test\presentation-live.test.js (87.7106ms),test\presentations-deep.test.js (88.1036ms),test\repair.test.js (86.1051ms),test\replan.test.js (88.2862ms),test\research.test.js (88.5662ms),test\run-recovery.test.js (105.7547ms),test\run-retry.test.js (102.2668ms),test\sendkeys.test.js (90.3735ms),test\share.test.js (105.7746ms),test\shortcuts.test.js (97.6466ms),test\silent-file-check.test.js (96.8137ms),test\step-effects.test.js (105.1812ms),test\step-factoring.test.js (84.1002ms),test\verification-loop.test.js (82.125ms),unavailable backend falls back for every resolved live mode before queuing (276.9371ms) tests
  - ✖ test\continuity.test.js — test/continuity.test.js
  - ✖ configured deep focus reads the current desktop windows each round — test/deep-focus.test.js:1 — SyntaxError [Error]: Unexpected identifier 'unknown'
  - ✖ test\deep-focus.test.js — test/deep-focus.test.js
  - ✖ test\deliberation.test.js — test/deliberation.test.js
  - ✖ test\engine-screen.test.js — test/engine-screen.test.js
  - ✖ test\focus-launch.test.js — test/focus-launch.test.js
  - ✖ test\foreground-presenter.test.js — test/foreground-presenter.test.js
  - ✖ test\goal-status.test.js — test/goal-status.test.js
  - ✖ test\live-fallback.test.js — test/live-fallback.test.js
  - ✖ test\live-monitor.test.js — test/live-monitor.test.js
  - ✖ HTTP endpoints expose state, validate actions and reject cross-origin starts — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795114034245-26704/test/live-preview.test.js:281 — AssertionError [ERR_ASSERTION]: server started
  - ✖ test\missions.test.js — test/missions.test.js
  - ✖ test\nudge.test.js — test/nudge.test.js
  - ✖ observation review uses stored evidence and is read-only — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795114034245-26704/server/platform.js:419 — SyntaxError: Unexpected identifier 'unknown'
  - ✖ test\output-file.test.js — test/output-file.test.js
  - ✖ test\planner.test.js — test/planner.test.js
  - ✖ test\platform.test.js — test/platform.test.js
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
  - ✖ test\share.test.js — test/share.test.js
  - ✖ test\shortcuts.test.js — test/shortcuts.test.js
  - ✖ test\silent-file-check.test.js — test/silent-file-check.test.js
  - ✖ test\step-effects.test.js — test/step-effects.test.js
  - ✖ test\step-factoring.test.js — test/step-factoring.test.js
  - ✖ test\verification-loop.test.js — test/verification-loop.test.js
  - ✖ unavailable backend falls back for every resolved live mode before queuing — /Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795114034245-26704/server/platform.js:419 — SyntaxError: Unexpected identifier 'unknown'

## Output tail

```
test\presentations-deep.test.js (88.1036ms)
  'test failed'

test at test\repair.test.js:1:1
✖ test\repair.test.js (86.1051ms)
  'test failed'

test at test\replan.test.js:1:1
✖ test\replan.test.js (88.2862ms)
  'test failed'

test at test\research.test.js:1:1
✖ test\research.test.js (88.5662ms)
  'test failed'

test at test\run-recovery.test.js:1:1
✖ test\run-recovery.test.js (105.7547ms)
  'test failed'

test at test\run-retry.test.js:1:1
✖ test\run-retry.test.js (102.2668ms)
  'test failed'

test at test\sendkeys.test.js:1:1
✖ test\sendkeys.test.js (90.3735ms)
  'test failed'

test at test\share.test.js:1:1
✖ test\share.test.js (105.7746ms)
  'test failed'

test at test\shortcuts.test.js:1:1
✖ test\shortcuts.test.js (97.6466ms)
  'test failed'

test at test\silent-file-check.test.js:1:1
✖ test\silent-file-check.test.js (96.8137ms)
  'test failed'

test at test\step-effects.test.js:1:1
✖ test\step-effects.test.js (105.1812ms)
  'test failed'

test at test\step-factoring.test.js:1:1
✖ test\step-factoring.test.js (84.1002ms)
  'test failed'

test at test\verification-loop.test.js:1:1
✖ test\verification-loop.test.js (82.125ms)
  'test failed'

test at test\workflow-run-mode.test.js:75:1
✖ unavailable backend falls back for every resolved live mode before queuing (276.9371ms)
  Error: Server exited: file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795114034245-26704/server/platform.js:419
      '$v=if($p.DisplayVersion){$p.DisplayVersion}else{'unknown'}',
                                                        ^^^^^^^
  
  SyntaxError: Unexpected identifier 'unknown'
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
  
      at startServer (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795114034245-26704/test/workflow-run-mode.test.js:56:40)
      at async TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795114034245-26704/test/workflow-run-mode.test.js:76:16)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.

## Dismissed — 2026-11-19

Caught the working tree mid-edit (`server/platform.js` held a half-written string literal, so the suite could not parse it). The settled source passes, and the new Windows probe test runs against the real probe. Verified on `d6711c9`: `npm test` → 589 tests, 584 pass, 0 fail, 5 skipped.

Dismissed in the repair queue after that run; re-open it if the same failure returns.
