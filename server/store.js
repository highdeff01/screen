import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = process.cwd();
export const DATA = path.join(ROOT, 'data');
export const CAPTURES = path.join(DATA, 'captures');
export const NOTES = path.join(DATA, 'notes');
export const TOOLS = path.join(DATA, 'tools');
export const DB_FILE = path.join(DATA, 'db.json');
export const HISTORY_FILE = path.join(DATA, 'conversation_history.txt');

for (const dir of [DATA, CAPTURES, NOTES, TOOLS]) fs.mkdirSync(dir, { recursive: true });

export const uid = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

export const now = () => new Date().toISOString();

export function slug(text, fallback = 'item') {
  return (
    String(text || fallback)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || fallback
  );
}

const WORKFLOW_ONE = 'wf_notepad_smoke';
const WORKFLOW_TWO = 'wf_desktop_click_probe';
const WORKFLOW_THREE = 'wf_desktop_browser_handoff';
const TOOL_WINDOWS = 'tool_window_list';
const TOOL_CAPTURE = 'tool_capture_screen';

function seed() {
  const ts = now();
  return {
    rev: 0,
    settings: {
      baseUrl: 'https://quantumclaw.net/ollama',
      chatPath: '/api/chat',
      endpoint: 'https://quantumclaw.net/ollama/api/chat',
      model: 'qwen3.5:2b',
      dryRun: true,
      autoNotes: true,
      aiSuggestions: true,
      requireToolApproval: true,
      agentTickMs: 5000,
      visionEnabled: true,
      visualChecks: true,
      missionCheckIntervalMs: 5000,
      replanModel: '',
      visualTesterUrl: '',
      visualTesterEnabled: true,
      visualTesterTimeoutMs: 25000,
      autoActEnabled: false,
      autoActThreshold: 80,
      autoForwardFailures: false,
      autoProposeFailures: false,
      autoRecoverFailures: true,
      recoveryMaxAttempts: 2,
      presenterSettleMs: 2000,
      presenterInputPolicy: 'auto',
      presenterAutoContinueMs: 15000,
      companionEnabled: true,
      companionLearning: true,
      companionNotifications: true,
      companionPopupPolicy: 'important',
      companionSystemScan: true,
      continuityEnabled: true,
      continuityAutoContinue: true,
      continuityFrameWatch: true,
      continuityFrameMs: 5000,
      continuityAiReview: false,
      apiStyle: 'ollama',
    },
    admin: {
      username: 'admin',
      salt: 'sightline-local-admin-v1',
      hash: crypto
        .scryptSync(process.env.SIGHTLINE_ADMIN_PASSWORD || 'sightline-admin', 'sightline-local-admin-v1', 64)
        .toString('hex'),
      mustChange: true,
      createdAt: ts,
    },
    missions: [],
    presentations: [],
    proposals: [],
    recoveryPacks: [],
    positionMemory: [],
    workflowMemory: [],
    memory: { conversation: { summaries: [], covered: 0 }, docs: [] },
    patterns: [],
    elementLinks: [],
    workflows: [
      {
        id: WORKFLOW_ONE,
        name: 'Notepad quick capture',
        description:
          'Opens Notepad, types a sample note and verifies the window came up. A safe end-to-end probe for the automation layer.',
        status: 'ready',
        autoRun: false,
        tags: ['smoke', 'desktop'],
        patternTags: ['retry', 'desktop', 'notepad'],
        failurePolicy: {
          onFailure: 'retry',
          maxRetries: 1,
          captureScreenshot: true,
          pauseBeforeRetryMs: 800,
          notifyAgent: true,
        },
        steps: [
          {
            id: 'stp_open_notepad',
            type: 'launchApp',
            name: 'Open Notepad',
            params: { target: 'notepad.exe' },
            timeoutMs: 15000,
            optional: false,
          },
          {
            id: 'stp_wait_boot',
            type: 'wait',
            name: 'Wait for window',
            params: { ms: 1200 },
            timeoutMs: 10000,
            optional: false,
          },
          {
            id: 'stp_focus_notepad',
            type: 'focusWindow',
            name: 'Focus Notepad',
            params: { title: 'Notepad' },
            timeoutMs: 10000,
            optional: false,
          },
          {
            id: 'stp_type_note',
            type: 'type',
            name: 'Type sample note',
            params: { text: 'Sightline screen agent\r\nAutomated typing check.' },
            timeoutMs: 15000,
            optional: false,
          },
          {
            id: 'stp_capture',
            type: 'screenshot',
            name: 'Capture evidence',
            params: { caption: 'Notepad after typing' },
            timeoutMs: 15000,
            optional: false,
          },
          {
            id: 'stp_assert_window',
            type: 'expect',
            name: 'Window is present',
            params: { kind: 'window', value: 'Notepad' },
            timeoutMs: 10000,
            optional: false,
          },
        ],
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: WORKFLOW_TWO,
        name: 'Desktop click probe',
        description:
          'Moves the pointer, double-clicks a desktop coordinate and records the result. Draft until you confirm the coordinates are safe.',
        status: 'draft',
        autoRun: false,
        tags: ['probe'],
        patternTags: ['coordinates', 'desktop', 'calibration'],
        failurePolicy: {
          onFailure: 'stop',
          maxRetries: 0,
          captureScreenshot: true,
          pauseBeforeRetryMs: 500,
          notifyAgent: true,
        },
        steps: [
          {
            id: 'stp_move',
            type: 'move',
            name: 'Move pointer',
            params: { x: 400, y: 300 },
            timeoutMs: 10000,
            optional: false,
          },
          {
            id: 'stp_dbl',
            type: 'doubleClick',
            name: 'Double click',
            params: { x: 400, y: 300, button: 'left' },
            timeoutMs: 10000,
            optional: true,
          },
          {
            id: 'stp_wait_probe',
            type: 'wait',
            name: 'Settle',
            params: { ms: 400 },
            timeoutMs: 10000,
            optional: false,
          },
          {
            id: 'stp_probe_capture',
            type: 'screenshot',
            name: 'Capture desktop',
            params: { caption: 'After double click' },
            timeoutMs: 15000,
            optional: false,
          },
        ],
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: WORKFLOW_THREE,
        name: 'Desktop + browser handoff (multi-agent demo)',
        description:
          'A runnable dry-mode demo of the desktop + browser chain: open the browser leg in Chrome, capture it, open the desktop leg in Notepad, type the handoff token and assert both windows. Run it as a mission to see executor-a, the verifier and the reviewer roles plus the record pattern.',
        status: 'draft',
        autoRun: false,
        tags: ['multi-agent', 'desktop', 'browser', 'handoff', 'demo'],
        patternTags: ['multi-agent', 'desktop', 'browser', 'handoff'],
        failurePolicy: {
          onFailure: 'retry',
          maxRetries: 2,
          captureScreenshot: true,
          pauseBeforeRetryMs: 1500,
          notifyAgent: true,
        },
        steps: [
          {
            id: 'stp_chain_open_chrome',
            type: 'launchApp',
            name: 'Open Chrome for the browser leg',
            params: { target: 'chrome.exe' },
            timeoutMs: 20000,
            optional: false,
          },
          {
            id: 'stp_chain_wait_chrome',
            type: 'waitFor',
            name: 'Wait for the Chrome window',
            params: { kind: 'window', value: 'Chrome', mode: 'present', timeoutMs: 12000, intervalMs: 750 },
            timeoutMs: 15000,
            optional: false,
          },
          {
            id: 'stp_chain_open_url',
            type: 'openUrl',
            name: 'Open the demo console',
            params: { url: 'https://example.com/console/login' },
            timeoutMs: 15000,
            optional: false,
          },
          {
            id: 'stp_chain_capture_browser',
            type: 'screenshot',
            name: 'Capture the browser leg',
            params: { caption: 'Browser leg — demo console' },
            timeoutMs: 15000,
            optional: false,
          },
          {
            id: 'stp_chain_open_notepad',
            type: 'launchApp',
            name: 'Open Notepad for the desktop leg',
            params: { target: 'notepad.exe' },
            timeoutMs: 15000,
            optional: false,
          },
          {
            id: 'stp_chain_wait_notepad',
            type: 'waitFor',
            name: 'Wait for the Notepad window',
            params: { kind: 'window', value: 'Notepad', mode: 'present', timeoutMs: 8000, intervalMs: 500 },
            timeoutMs: 12000,
            optional: false,
          },
          {
            id: 'stp_chain_focus_notepad',
            type: 'focusWindow',
            name: 'Focus Notepad',
            params: { title: 'Notepad' },
            timeoutMs: 10000,
            optional: false,
          },
          {
            id: 'stp_chain_type_token',
            type: 'type',
            name: 'Type the handoff token',
            params: { text: 'TOKEN-EXAMPLE-0001 — handed off from the browser leg.' },
            timeoutMs: 15000,
            optional: false,
          },
          {
            id: 'stp_chain_capture_desktop',
            type: 'screenshot',
            name: 'Capture the desktop leg',
            params: { caption: 'Desktop leg — token in Notepad' },
            timeoutMs: 15000,
            optional: false,
          },
          {
            id: 'stp_chain_assert_notepad',
            type: 'expect',
            name: 'Notepad is still present',
            params: { kind: 'window', value: 'Notepad' },
            timeoutMs: 10000,
            optional: false,
          },
          {
            id: 'stp_chain_assert_chrome',
            type: 'expect',
            name: 'Chrome is still present',
            params: { kind: 'window', value: 'Chrome' },
            timeoutMs: 10000,
            optional: false,
          },
          {
            id: 'stp_chain_note',
            type: 'note',
            name: 'Record the chain contract',
            params: {
              text: 'Executor A proves the browser leg, executor B proves the desktop leg, the verifier compares both captures with the goal, and the reviewer writes the record pattern.',
            },
            timeoutMs: 5000,
            optional: false,
          },
        ],
        createdAt: ts,
        updatedAt: ts,
      },
    ],
    tools: [
      {
        id: TOOL_WINDOWS,
        name: 'List visible windows',
        description: 'Prints every process with a visible window, so the AI can pick a focus target.',
        kind: 'powershell',
        code:
          "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, ProcessName, MainWindowTitle | Format-Table -AutoSize | Out-String -Width 200",
        status: 'approved',
        createdBy: 'human',
        createdAt: ts,
        usage: [],
      },
      {
        id: TOOL_CAPTURE,
        name: 'Capture screen to PNG',
        description: 'Writes a full virtual-screen PNG into the captures folder and prints its path.',
        kind: 'powershell',
        code:
          "Add-Type -AssemblyName System.Windows.Forms\nAdd-Type -AssemblyName System.Drawing\n$b = [System.Windows.Forms.SystemInformation]::VirtualScreen\n$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height\n$g = [System.Drawing.Graphics]::FromImage($bmp)\n$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)\n$out = Join-Path $env:CB_DATA ('captures\\\\tool_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.png')\n$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)\n$g.Dispose(); $bmp.Dispose()\nWrite-Output $out",
        status: 'approved',
        createdBy: 'human',
        createdAt: ts,
        usage: [],
      },
    ],
    runs: [],
    notes: [],
    suggestions: [
      {
        id: 'sug_seed_1',
        text: 'Add a screenshot step immediately before assertion steps so a failure shows the screen at the moment it broke.',
        kind: 'evidence',
        workflowId: WORKFLOW_ONE,
        createdAt: ts,
        dismissed: false,
        status: 'open',
      },
    ],
    agents: [
      {
        id: 'agent_supervisor',
        name: 'Supervisor',
        kind: 'supervisor',
        role: 'supervisor',
        status: 'paused',
        description:
          'Owns the failure queue: diagnoses each failed run, records a suggestion, then delegates evidence capture and note writing to the watchdog.',
        enabled: false,
        intervalMs: 60000,
        delegatesTo: ['agent_watchdog', 'agent_scheduler'],
        lastTickAt: null,
        lastRunAt: null,
        supervisedCount: 0,
        log: [],
      },
      {
        id: 'agent_scheduler',
        name: 'Background scheduler',
        kind: 'scheduler',
        role: 'sub-agent',
        status: 'paused',
        description: 'Queues the bound ready workflow on an interval, stopping the loop on the first failure.',
        enabled: false,
        intervalMs: 300000,
        workflowId: WORKFLOW_ONE,
        stopOnFailure: true,
        lastTickAt: null,
        lastRunAt: null,
        runsStarted: 0,
        log: [],
      },
      {
        id: 'agent_watchdog',
        name: 'Failure watchdog',
        kind: 'watchdog',
        role: 'sub-agent',
        status: 'idle',
        description: 'Reviews failed runs, captures missing evidence and writes a triage note with next actions.',
        enabled: true,
        intervalMs: 5000,
        handled: [],
        lastTickAt: null,
        lastRunAt: null,
        log: [],
      },
      {
        id: 'agent_observer',
        name: 'Observer / drifter',
        kind: 'observer',
        role: 'sub-agent',
        status: 'idle',
        description:
          'Always-on evidence watcher: reviews active mission screenshots and step ledgers, then inserts missed in-between steps and refinements.',
        enabled: true,
        intervalMs: 30000,
        observerCount: 0,
        lastTickAt: null,
        lastRunAt: null,
        log: [],
      },
      {
        id: 'agent_companion',
        name: 'Companion',
        kind: 'companion',
        role: 'sub-agent',
        status: 'idle',
        description:
          'Watches completed runs for repeat apps, files, questions and inputs; proposes new-file, research, cleanup and next-step help while keeping notifications bounded.',
        enabled: true,
        intervalMs: 60000,
        lastTickAt: null,
        lastRunAt: null,
        learned: 0,
        log: [],
      },
      {
        id: 'agent_continuity',
        name: 'Continuity verifier',
        kind: 'continuity',
        role: 'sub-agent',
        status: 'idle',
        description:
          'Separate verification engine: captures frames while a run waits, classifies foreground/background/minimized/closed windows, checks triggers, links, coordinates and current wording, then drafts safe continuation workflows.',
        enabled: true,
        intervalMs: 15000,
        lastTickAt: null,
        lastRunAt: null,
        reviewed: 0,
        log: [],
      },
    ],
    captures: [],
    activity: [],
    usage: [],
  };
}

let storeDb = null;
let saveTimer = null;

/** Write a file and fsync it, so the bytes cannot sit in the cache after a crash. */
export function writeFileDurable(file, text, { append = false } = {}) {
  const fd = fs.openSync(file, append ? 'a' : 'w');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Durable replace: write a sibling temp file, fsync it, then rename it into place. */
export function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp`;
  writeFileDurable(tmp, text);
  fs.renameSync(tmp, file);
  syncDirectory(path.dirname(file));
}

function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is not supported everywhere; the rename itself still stands.
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function isZeroFilled(buffer) {
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
}

function backupDamagedDb(kind, detail) {
  const target = `${DB_FILE}.${kind}-${Date.now()}`;
  let saved = null;
  try {
    fs.copyFileSync(DB_FILE, target);
    saved = path.basename(target);
  } catch {}
  console.error(
    `[store] ${detail}. ` +
      (saved ? `Backed it up to ${saved} ` : 'Could not back it up ') +
      'before starting from the seed database.'
  );
  return saved;
}

/** A database object always ends with '}'; anything else means the write stopped early. */
function looksTruncated(buffer) {
  const text = buffer.toString('utf8').trimEnd();
  return text.length > 0 && text[text.length - 1] !== '}';
}

function readDb() {
  let raw = null;
  try {
    if (fs.existsSync(DB_FILE)) {
      raw = fs.readFileSync(DB_FILE);
      if (raw.length === 0 || isZeroFilled(raw)) {
        backupDamagedDb(
          raw.length === 0 ? 'empty' : 'zeroed',
          raw.length === 0
            ? `${path.basename(DB_FILE)} is empty (0 bytes)`
            : `${path.basename(DB_FILE)} is zero-filled (${raw.length} bytes, no valid data)`
        );
        return seed();
      }
      const parsed = JSON.parse(raw.toString('utf8'));
      const base = seed();
      const parsedAgents = Array.isArray(parsed.agents) ? parsed.agents : [];
      const agents = [
        ...parsedAgents.map((agent) => ({
          role: agent.kind === 'supervisor' ? 'supervisor' : 'sub-agent',
          status: agent.enabled ? 'idle' : 'paused',
          ...agent,
        })),
        ...base.agents.filter((seeded) => !parsedAgents.some((agent) => agent.id === seeded.id)),
      ];
      const parsedWorkflows = Array.isArray(parsed.workflows) ? parsed.workflows : [];
      const workflows = [
        ...parsedWorkflows,
        ...base.workflows.filter((seeded) => !parsedWorkflows.some((workflow) => workflow.id === seeded.id)),
      ].map((workflow) => ({
        ...workflow,
        patternTags: Array.isArray(workflow.patternTags)
          ? workflow.patternTags
          : String(workflow.patternTags || '')
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean),
      }));
      const runs = (parsed.runs || []).map((run) => ({
        retryCount: (run.steps || []).reduce((total, step) => total + Math.max(0, Number(step.attempts || 0) - 1), 0),
        errorCategory: null,
        failureSignature: null,
        recovered: false,
        patternTags: [],
        matchedPatternTags: [],
        ...run,
      }));
      return {
        ...base,
        ...parsed,
        settings: { ...base.settings, ...(parsed.settings || {}) },
        admin: parsed.admin || base.admin,
        workflows,
        runs,
        presentations: Array.isArray(parsed.presentations) ? parsed.presentations : [],
        proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
        recoveryPacks: Array.isArray(parsed.recoveryPacks) ? parsed.recoveryPacks : [],
        positionMemory: Array.isArray(parsed.positionMemory) ? parsed.positionMemory : [],
        workflowMemory: Array.isArray(parsed.workflowMemory) ? parsed.workflowMemory : [],
        memory: {
          conversation: {
            summaries: Array.isArray(parsed.memory?.conversation?.summaries) ? parsed.memory.conversation.summaries : [],
            covered: Number(parsed.memory?.conversation?.covered || 0),
          },
          docs: Array.isArray(parsed.memory?.docs) ? parsed.memory.docs : [],
        },
        tools: parsed.tools || base.tools,
        agents,
        suggestions: (parsed.suggestions || base.suggestions).map((suggestion) => ({
          status: suggestion.dismissed ? 'dismissed' : 'open',
          ...suggestion,
        })),
      };
    }
  } catch (err) {
    const kind = !raw || raw.length === 0 ? 'unreadable' : looksTruncated(raw) ? 'truncated' : 'corrupt';
    backupDamagedDb(
      kind,
      `${path.basename(DB_FILE)} could not be loaded (${raw ? `${raw.length} bytes` : 'unreadable'}): ${err.message}`
    );
  }
  return seed();
}

export function db() {
  if (!storeDb) storeDb = readDb();
  return storeDb;
}

export function persist() {
  if (!storeDb) return;
  storeDb.rev = (storeDb.rev || 0) + 1;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeFileAtomic(DB_FILE, JSON.stringify(storeDb, null, 2));
    } catch (err) {
      console.error('[store] save failed:', err.message);
    }
  }, 40);
}

export function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!storeDb) return;
  try {
    writeFileAtomic(DB_FILE, JSON.stringify(storeDb, null, 2));
  } catch {}
}

export function logActivity(kind, message, extra = {}) {
  const d = db();
  d.activity.unshift({ id: uid('act'), at: now(), kind, message, ...extra });
  d.activity = d.activity.slice(0, 400);
  persist();
}

export function recordUsage(entry) {
  const d = db();
  d.usage.unshift({ id: uid('use'), at: now(), ...entry });
  d.usage = d.usage.slice(0, 300);
  persist();
}

export function resolveInside(base, target) {
  const resolved = path.resolve(base, target);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}
