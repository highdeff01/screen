'use strict';

/* ------------------------------------------------------------------ state */
const ui = {
  data: null,
  view: 'builder',
  selectedWorkflow: null,
  selectedStep: null,
  workflowLint: null,
  draft: null,
  policy: null,
  policyFor: null,
  railTab: 'inspector',
  paletteAt: null,
  planGoal: '',
  planPreview: null,
  planSource: '',
  planNote: '',
  planResearch: null,
  planBusy: false,
  proposalBusy: false,
  proposalShadowBusy: null,
  chat: [],
  chatInput: '',
  chatLoaded: false,
  control: { x: 400, y: 300, text: 'Hello from Sightline', title: 'Notepad', amount: 3 },
  controlOut: null,
  controlErr: false,
  preview: { active: false, busy: false, uncertain: false, detail: null, message: '', timer: null, generation: 0 },
  runFilter: 'all',
  selectedRun: null,
  runDetailOpen: false,
  runBusy: '',
  runDetail: null,
  reviewComment: '',
  presenterInput: '',
  presenterBusy: '',
  presenterCollapsed: false,
  trayCollapsed: false,
  trayExpanded: false,
  trayDismissed: '',
  sim: null,
  simBusy: false,
  review: null,
  reviewBusy: false,
  reviewSort: 'risk',
  observationReview: null,
  observationReviewBusy: false,
  observationProposal: { simulationId: '', proposalId: '' },
  reviewProposalTarget: null,
  captureFilter: 'all',
  toolTab: 'tools',
  toolOutput: null,
  captures: null,
  files: [],
  examples: null,
  shortcuts: null,
  selectedExample: 'ex_notepad_save',
  exampleTab: 'examples',
  python: null,
  pyDraft: null,
  models: null,
  modelsError: '',
  modelsBusy: false,
  localModelBusy: '',
  fileTab: 'files',
  selectedFile: null,
  fileText: null,
  fileError: null,
  fileRead: null,
  fileSummary: null,
  fileAppend: '',
  fileBusy: '',
  memory: null,
  memoryBusy: '',
  workflowMemory: null,
  companion: null,
  ambientBusy: '',
  ambientSeen: new Set(),
  ambientSeenReady: false,
  ambientNote: '',
  companionLoading: false,
  companionNote: '',
  companionSeen: new Set(),
  companionSeenReady: false,
  companionBusy: '',
  continuity: null,
  continuityBusy: '',
  continuityReview: null,
  memoryFilter: 'all',
  memoryWorkflow: '',
  memoryLoading: false,
  settingsDraft: null,
  linkForm: { label: '', window: 'YouTube', name: '', controlType: '', workflowId: '', action: 'mission', mode: 'auto', goal: '', cooldownSeconds: 60 },
  linkPicking: false,
  selectedMission: null,
  missionDetail: null,
  missionDraft: null,
  missionBusy: '',
  missionInput: '',
  missionInputBusy: false,
  missionLoading: false,
  missionEventFilter: { view: 'all', agent: 'all', kind: 'all', severity: 'all', q: '', sort: 'newest' },
  missionSessionFilter: { status: 'all', sort: 'newest' },
  auth: null,
  presentation: null,
  presentationMission: null,
  presentationWorkflow: null,
  presentationDeckId: null,
  presentationDeck: null,
  presentationDeckLoading: false,
  presentationDeckFailedId: null,
  presentationDeckQuery: '',
  presentationDeckResults: null,
  presentationDeckClass: 'all',
  presentationImageDiff: null,
  presentationDiffBusy: false,
  presentationGraph: null,
  presentationGraphBusy: false,
  presentationWatchBusy: false,
  presentationControlBusy: false,
  presentationSlide: 0,
  presentationFocus: 'auto',
  presentationBusy: false,
  presentationAuditBusy: false,
  presentationReapplyBusy: false,
  presentationProposalBusy: false,
  presentationAudit: null,
  presentationError: '',
  videoBusy: false,
  videoUrl: null,
  videoDeckId: null,
  videoError: '',
  presentationLoading: false,
  presentationError: '',
  presentationNote: '',
  workpointFilter: 'all',
  decisionForm: null,
  decisionDraft: { instruction: '', goal: '', workflowId: '' },
  authDraft: { username: 'admin', password: '', current: '', next: '' },
  commandDraft: { command: 'FORCE_REPLAN', reason: '' },
  knack: null,
  modal: null,
  health: null,
  busy: null,
  rev: null,
};

const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const SYNC_CHANNEL = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('sightline-state') : null;

const $ = (sel) => document.querySelector(sel);

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/* ------------------------------------------------------------------ boot */
// Every UI error and every failed server response is reported to the action
// log, so a recurring problem is deduplicated on the server, written into the
// synced must-check folder and offered to the fixer — without anyone copying
// logs around. The last thing the person clicked rides along as context.
let lastUiAction = '';
let lastUiActionAt = 0;

function noteUiAction(label) {
  lastUiAction = String(label || '').slice(0, 120);
  lastUiActionAt = Date.now();
}

function reportUiError(error, action = '') {
  const label = action || lastUiAction || 'unknown';
  api('/api/action-log/report', {
    method: 'POST',
    body: { kind: 'ui', action: label, error: String(error || '').slice(0, 2000), detail: { view: ui.view || '', at: lastUiActionAt, href: location.href } },
  }).catch(() => {});
}

async function api(path, options = {}) {
  // Give long-running actions more time than reads, while ensuring neither a
  // stalled connection nor a stalled response body can block the UI forever.
  const timeoutMs = !options.method || options.method.toUpperCase() === 'GET' ? 15000 : 300000;
  const controller = new AbortController();
  const signal = options.signal;
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Request timed out.'));
        controller.abort();
      }, timeoutMs);
    });
    const request = (async () => {
      const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
        signal: controller.signal,
        body: options.body == null ? undefined : JSON.stringify(options.body),
      });
      const data = await res.json().catch(() => ({ ok: false, error: `Unexpected response (${res.status})` }));
      if (res.status === 401 && /sign in as admin/i.test(data.error || '')) {
        await loadAuth();
        if (!ui.auth?.authenticated) ui.authDraft = { username: ui.auth?.defaultUser || 'admin', password: '', current: '', next: '' };
        openModal('admin');
      }
      return { data, status: res.status };
    })();
    const { data, status } = await Promise.race([request, timeout]);
    if (data && data.ok === false && status >= 400 && !/action-log/.test(path) && typeof reportUiError === 'function') {
      reportUiError(data.error || `HTTP ${status}`, path);
    }
    return data;
  } catch (err) {
    if (!/action-log/.test(path) && typeof reportUiError === 'function') reportUiError(err.message, path);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function toast(message, kind = '') {
  const root = $('#toast-root');
  if (!root) return;
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  root.appendChild(node);
  setTimeout(() => node.remove(), 5200);
}

function announceCompanion(companion) {
  if (!companion?.notifications) return;
  const fresh = companion.notifications.filter((n) => !n.read && !ui.companionSeen.has(n.id));
  for (const n of companion.notifications) ui.companionSeen.add(n.id);
  if (!ui.companionSeenReady) {
    ui.companionSeenReady = true;
    return;
  }
  if (companion.settings?.notifications === false || companion.settings?.popupPolicy === 'off') return;
  for (const n of fresh.slice(0, 2)) {
    toast(`Companion · ${n.title}`, n.important ? 'ok' : '');
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(n.title, { body: n.body || '', tag: n.id });
      }
    } catch {}
  }
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })}`;
}

function fmtDur(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function statusPill(status, label) {
  const text = label || String(status || '').replace(/_/g, ' ');
  return `<span class="pill ${esc(status)}">${esc(text)}</span>`;
}

/**
 * A step that still owes a verification check is not finished, even though its
 * action ran: show it as "checking" until the check answers.
 */
function stepDisplayStatus(run, step) {
  const pending = (run?.pendingVerification || []).some((entry) => entry.stepId === step.id);
  if (!pending) return step.status;
  if (step.status === 'passed') return 'verifying';
  return step.status;
}

function modeBadge(simulated) {
  return simulated ? '<span class="pill simulated">simulated</span>' : '<span class="pill live">live</span>';
}

const TYPE_META = {
  launchApp: { label: 'Launch app', glyph: '▸' },
  openUrl: { label: 'Open URL', glyph: '↗' },
  focusWindow: { label: 'Focus window', glyph: '▣' },
  windowAction: { label: 'Minimize / maximize / restore / close window', glyph: '▣' },
  move: { label: 'Move pointer', glyph: '✥' },
  click: { label: 'Click', glyph: '●' },
  doubleClick: { label: 'Double click', glyph: '◎' },
  rightClick: { label: 'Right click', glyph: '◑' },
  drag: { label: 'Drag / highlight', glyph: '↔' },
  dragCopy: { label: 'Drag-highlight and copy', glyph: '↔' },
  playMedia: { label: 'Start media playback', glyph: '▶' },
  closeWindow: { label: 'Close guarded window', glyph: '✕' },
  verifyScreen: { label: 'Verify screen (vision)', glyph: '◉' },
  verifyPlayback: { label: 'Verify playback (2 frames)', glyph: '⏱' },
  mediaHold: { label: 'Hold until media ends', glyph: '◷' },
  scroll: { label: 'Scroll', glyph: '↕' },
  type: { label: 'Type text', glyph: '⌨' },
  key: { label: 'Press keys / shortcut', glyph: '⎇' },
  clipboard: { label: 'Clipboard (select/copy/paste)', glyph: '▣' },
  aiExtract: { label: 'AI extract text from clipboard', glyph: '✦' },
  wait: { label: 'Wait', glyph: '◷' },
  waitFor: { label: 'Wait for state', glyph: '◴' },
  screenshot: { label: 'Capture screen', glyph: '▤' },
  expect: { label: 'Assert state', glyph: '✓' },
  runTool: { label: 'Run tool', glyph: '⌘' },
  note: { label: 'Add note (run log)', glyph: '✎' },
  writeNote: { label: 'Save interaction note', glyph: '✍' },
  readNote: { label: 'Read note into variable', glyph: '▤' },
  copyLink: { label: 'Copy browser link', glyph: '🔗' },
  downloadMedia: { label: 'Save image / video from URL', glyph: '⤓' },
  saveImage: { label: 'Save image (screen/clipboard/URL)', glyph: '🖼' },
  writeTextFile: { label: 'Save text file', glyph: '📄' },
  recordVideo: { label: 'Record screen video', glyph: '⏺' },
  watchVideo: { label: 'Watch video + take notes', glyph: '▶' },
  installApp: { label: 'Install app (winget or installer)', glyph: '＋' },
  testApp: { label: 'Launch and test app', glyph: '✓' },
};

const FIELDS = {
  launchApp: [
    { key: 'target', label: 'App, executable or document', type: 'text', placeholder: 'Kiro or notepad.exe' },
    { key: 'args', label: 'Arguments (optional)', type: 'text', placeholder: 'C:\\Users\\Dan\\Videos\\sample.mp4' },
  ],
  openUrl: [
    { key: 'url', label: 'URL', type: 'text', placeholder: 'https://example.com' },
    { key: 'urlVar', label: 'Or read URL from variable', type: 'text', placeholder: 'copiedLink' },
  ],
  focusWindow: [
    { key: 'title', label: 'Window title contains', type: 'text', placeholder: 'Kiro' },
    { key: 'process', label: 'Process name (optional)', type: 'text', placeholder: 'Kiro' },
  ],
  windowAction: [
    { key: 'action', label: 'Action', type: 'select', options: ['minimize', 'maximize', 'restore', 'close'], default: 'minimize' },
    { key: 'title', label: 'Window title contains', type: 'text', placeholder: 'Notepad' },
    { key: 'process', label: 'Process name (optional)', type: 'text', placeholder: 'notepad' },
  ],
  move: [
    { key: 'x', label: 'X', type: 'number', placeholder: '400' },
    { key: 'y', label: 'Y', type: 'number', placeholder: '300' },
  ],
  click: [
    { key: 'x', label: 'X', type: 'number', placeholder: '400' },
    { key: 'y', label: 'Y', type: 'number', placeholder: '300' },
    { key: 'button', label: 'Button', type: 'select', options: ['left', 'right', 'middle'], default: 'left' },
    { key: 'foreground', label: 'Require foreground window contains', type: 'text', placeholder: 'YouTube', help: 'Refuses to click if another app is in front.' },
  ],
  doubleClick: [
    { key: 'x', label: 'X', type: 'number', placeholder: '400' },
    { key: 'y', label: 'Y', type: 'number', placeholder: '300' },
    { key: 'foreground', label: 'Require foreground window contains', type: 'text', placeholder: 'YouTube' },
  ],
  rightClick: [
    { key: 'x', label: 'X', type: 'number', placeholder: '400' },
    { key: 'y', label: 'Y', type: 'number', placeholder: '300' },
    { key: 'foreground', label: 'Require foreground window contains', type: 'text', placeholder: 'YouTube' },
  ],
  drag: [
    { key: 'x1', label: 'Start X', type: 'number', placeholder: '400' },
    { key: 'y1', label: 'Start Y', type: 'number', placeholder: '300' },
    { key: 'x2', label: 'End X', type: 'number', placeholder: '700' },
    { key: 'y2', label: 'End Y', type: 'number', placeholder: '300' },
    { key: 'durationMs', label: 'Duration (ms)', type: 'number', placeholder: '600' },
    { key: 'button', label: 'Button', type: 'select', options: ['left', 'right', 'middle'], default: 'left' },
    { key: 'foreground', label: 'Require foreground window contains', type: 'text', placeholder: 'YouTube' },
  ],
  dragCopy: [
    { key: 'text', label: 'Visible text to select (optional with coordinates)', type: 'text', placeholder: 'The sentence to copy' },
    { key: 'window', label: 'Window title contains', type: 'text', placeholder: 'Notepad' },
    { key: 'x1', label: 'Start X (optional)', type: 'number', placeholder: '400' },
    { key: 'y1', label: 'Start Y (optional)', type: 'number', placeholder: '300' },
    { key: 'x2', label: 'End X (optional)', type: 'number', placeholder: '700' },
    { key: 'y2', label: 'End Y (optional)', type: 'number', placeholder: '300' },
    { key: 'outputVar', label: 'Save copied text to variable', type: 'text', placeholder: 'selectedText' },
    { key: 'minChars', label: 'Minimum copied characters', type: 'number', placeholder: '1' },
    { key: 'expectText', label: 'Expected copied text (optional)', type: 'text', placeholder: 'Text that must be present' },
  ],
  scroll: [
    { key: 'amount', label: 'Wheel lines', type: 'number', placeholder: '3', help: 'Positive scrolls up, negative down.' },
    { key: 'x', label: 'X (optional)', type: 'number', placeholder: '' },
    { key: 'y', label: 'Y (optional)', type: 'number', placeholder: '' },
    { key: 'foreground', label: 'Require foreground window contains', type: 'text', placeholder: 'YouTube' },
  ],
  type: [
    { key: 'text', label: 'Text to type', type: 'textarea', rows: 4, placeholder: 'Hello from Sightline' },
    { key: 'textVar', label: 'Use variable instead (optional)', type: 'text', placeholder: 'extractedText' },
    { key: 'foreground', label: 'Require foreground window contains', type: 'text', placeholder: 'Kiro' },
  ],
  key: [
    { key: 'keys', label: 'Shortcut or keys', type: 'text', placeholder: 'ctrl+a, ctrl+c', help: 'Write ctrl+a, ctrl+c, ctrl+v, ctrl+s; separate multiple combos with commas. SendKeys expressions such as ^a or {TAB} still work. “ctr” is accepted as ctrl.' },
    { key: 'repeat', label: 'Repeat', type: 'number', placeholder: '1', help: 'Repeat the key to tab through several controls.' },
    { key: 'intervalMs', label: 'Interval (ms)', type: 'number', placeholder: '120' },
    { key: 'foreground', label: 'Require foreground window contains', type: 'text', placeholder: 'YouTube' },
  ],
  clipboard: [
    { key: 'action', label: 'Action', type: 'select', options: ['copy', 'copyAll', 'cut', 'paste', 'selectAll', 'read', 'write', 'clear'], default: 'copy', help: 'copyAll selects everything then copies. read/write use the clipboard directly.' },
    { key: 'text', label: 'Text to write / paste (optional)', type: 'textarea', rows: 4, placeholder: '' },
    { key: 'textVar', label: 'Use variable (optional)', type: 'text', placeholder: 'extractedText' },
    { key: 'outputVar', label: 'Save clipboard to variable', type: 'text', placeholder: 'clipboardText' },
    { key: 'minChars', label: 'Minimum characters', type: 'number', placeholder: '1', help: 'A copy with fewer characters fails instead of silently passing.' },
    { key: 'foreground', label: 'Require foreground window contains', type: 'text', placeholder: 'Kiro' },
  ],
  aiExtract: [
    { key: 'source', label: 'Source', type: 'select', options: ['clipboard', 'text'], default: 'clipboard' },
    { key: 'instructions', label: 'What to extract', type: 'textarea', rows: 3, placeholder: 'Extract only the assistant’s answer about diamonds, without the sidebar or my prompt.' },
    { key: 'textVar', label: 'Source variable (text mode)', type: 'text', placeholder: 'clipboardText' },
    { key: 'outputVar', label: 'Save result to variable', type: 'text', placeholder: 'extractedText' },
    { key: 'maxChars', label: 'Maximum source characters', type: 'number', placeholder: '24000' },
  ],
  wait: [{ key: 'ms', label: 'Wait (ms)', type: 'number', placeholder: '1000' }],
  waitFor: [
    { key: 'kind', label: 'Watch', type: 'select', options: ['window', 'process', 'file'], default: 'window' },
    { key: 'value', label: 'Value', type: 'text', placeholder: 'Save As' },
    { key: 'mode', label: 'Condition', type: 'select', options: ['present', 'absent'], default: 'present' },
    { key: 'timeoutMs', label: 'Poll until (ms)', type: 'number', placeholder: '30000' },
    { key: 'intervalMs', label: 'Poll interval (ms)', type: 'number', placeholder: '1000' },
  ],
  screenshot: [{ key: 'caption', label: 'Caption', type: 'text', placeholder: 'Final state' }],
  expect: [
    { key: 'kind', label: 'Assert', type: 'select', options: ['window', 'file', 'process', 'foreground'], default: 'window' },
    { key: 'value', label: 'Expected value', type: 'text', placeholder: 'Untitled - Notepad' },
  ],
  verifyScreen: [
    { key: 'question', label: 'What must be visibly true?', type: 'textarea', rows: 3, placeholder: 'The YouTube watch page is visible and the video is playing: no large play overlay, progress is past 0:00.' },
    { key: 'title', label: 'Expected app/page (optional)', type: 'text', placeholder: 'YouTube watch page' },
    { key: 'app', label: 'Foreground app/process must match', type: 'text', placeholder: 'Kiro' },
    { key: 'text', label: 'Expected text in the window (optional)', type: 'text', placeholder: 'Sightline screen agent', help: 'The free judge reads the window with UI Automation; a missing passage fails without spending a model call.' },
    { key: 'absent', label: 'Text that must be gone (optional)', type: 'text', placeholder: 'Untitled', help: 'Useful to prove a stale passage or placeholder was replaced.' },
    { key: 'caption', label: 'Evidence caption', type: 'text', placeholder: 'Screen verification' },
    { key: 'onError', label: 'If the model cannot see', type: 'select', options: ['fail', 'warn'], default: 'fail' },
    { key: 'minConfidence', label: 'Minimum confidence', type: 'number', placeholder: '0.7', help: '0–1. A pass below this threshold fails the step.' },
  ],
  verifyPlayback: [
    { key: 'title', label: 'Expected app/page', type: 'text', placeholder: 'YouTube video' },
    { key: 'caption', label: 'Evidence caption', type: 'text', placeholder: 'Playback still advancing' },
    { key: 'intervalMs', label: 'Frame gap (ms)', type: 'number', placeholder: '4000', help: 'Two screenshots are compared. A video that is paused or stalled has no advancing progress and fails.' },
    { key: 'onError', label: 'If the model cannot compare', type: 'select', options: ['fail', 'warn'], default: 'fail' },
    { key: 'minConfidence', label: 'Minimum confidence', type: 'number', placeholder: '0.7' },
  ],
  mediaHold: [
    { key: 'title', label: 'Window title contains', type: 'text', placeholder: 'YouTube' },
    { key: 'bufferMs', label: 'Extra hold after end (ms)', type: 'number', placeholder: '5000' },
    { key: 'maxMs', label: 'Maximum hold (ms)', type: 'number', placeholder: '900000', help: 'The actual video length drives the hold; this is the safety ceiling.' },
    { key: 'checkMs', label: 'Progress poll (ms)', type: 'number', placeholder: '5000' },
    { key: 'stallMs', label: 'Fail paused after (ms)', type: 'number', placeholder: '30000' },
    { key: 'adGraceMs', label: 'Allow frozen clock for ads (ms)', type: 'number', placeholder: '180000' },
    { key: 'caption', label: 'Evidence caption', type: 'text', placeholder: 'Media ended' },
  ],
  playMedia: [
    { key: 'x', label: 'Play control X', type: 'number', placeholder: '640' },
    { key: 'y', label: 'Play control Y', type: 'number', placeholder: '360' },
    { key: 'title', label: 'Window title contains', type: 'text', placeholder: 'YouTube' },
  ],
  clickElement: [
    { key: 'window', label: 'Window title contains', type: 'text', placeholder: 'YouTube' },
    { key: 'name', label: 'Element name contains', type: 'text', placeholder: 'Pause' },
    { key: 'controlType', label: 'Control type', type: 'select', options: ['', 'Button', 'Link', 'Text', 'Edit', 'Slider', 'CheckBox'] },
    { key: 'button', label: 'Mouse button', type: 'select', options: ['left', 'right', 'middle'], default: 'left' },
    { key: 'fallbackX', label: 'Fallback X (optional)', type: 'number', placeholder: '640' },
    { key: 'fallbackY', label: 'Fallback Y (optional)', type: 'number', placeholder: '360' },
    { key: 'visionFallback', label: 'Vision fallback', type: 'select', options: ['true', 'false'], default: 'true', help: 'If UI Automation cannot find the control, locate it on a fresh screenshot with the vision model and require high confidence.' },
    { key: 'verifyAfter', label: 'Check after click (optional)', type: 'textarea', rows: 2, placeholder: 'The VLC page is open and shows an Install or Open button.' },
    { key: 'preview', label: 'Preview screen before clicking', type: 'select', options: ['false', 'true'], default: 'false', help: 'Reads a screenshot first: skips the click when the expected state is already visible, lists nearby elements and can correct the position.' },
    { key: 'expect', label: 'Expected state after the click (optional)', type: 'text', placeholder: 'A Save dialog is open' },
    { key: 'humanize', label: 'Move pointer through the area', type: 'select', options: ['false', 'true'], default: 'false', help: 'Approach the control instead of jumping, so hover menus and tooltips render.' },
  ],
  closeWindow: [{ key: 'title', label: 'Only close if title contains', type: 'text', placeholder: 'YouTube' }],
  runTool: [{ key: 'toolId', label: 'Tool', type: 'tool' }],
  note: [{ key: 'text', label: 'Note text', type: 'textarea', rows: 3, placeholder: 'Observation for the review log' }],
  writeNote: [
    { key: 'title', label: 'Note title', type: 'text', placeholder: 'Video observations — 2026-11-15' },
    { key: 'text', label: 'Note text / observations', type: 'textarea', rows: 5, placeholder: 'What happened, links copied, files saved, decisions…' },
    { key: 'textVar', label: 'Use variable instead (optional)', type: 'text', placeholder: 'extractedText' },
    { key: 'append', label: 'Append to an existing note with this title', type: 'select', options: ['true', 'false'], default: 'true' },
    { key: 'tags', label: 'Tags (comma-separated)', type: 'text', placeholder: 'video, research, links' },
    { key: 'outputVar', label: 'Save note id to variable', type: 'text', placeholder: 'noteId' },
  ],
  readNote: [
    { key: 'title', label: 'Note title contains (or leave blank)', type: 'text', placeholder: 'Video notes' },
    { key: 'noteId', label: 'Note id (optional)', type: 'text', placeholder: 'note_…' },
    { key: 'path', label: 'Note file (optional)', type: 'text', placeholder: 'data/notes/video-notes-….md' },
    { key: 'outputVar', label: 'Read into variable', type: 'text', placeholder: 'noteText' },
    { key: 'maxChars', label: 'Maximum characters', type: 'number', placeholder: '60000' },
    { key: 'allowMissing', label: 'Allow missing note', type: 'select', options: ['false', 'true'], default: 'false' },
  ],
  copyLink: [
    { key: 'outputVar', label: 'Save link to variable', type: 'text', placeholder: 'copiedLink' },
    { key: 'url', label: 'Known URL (optional)', type: 'text', placeholder: 'https://example.com/watch?v=…' },
    { key: 'urlVar', label: 'Read URL from variable (optional)', type: 'text', placeholder: 'copiedLink' },
    { key: 'foreground', label: 'Browser window must contain', type: 'text', placeholder: 'Chrome' },
    { key: 'noteTitle', label: 'Also save the link in a note (optional)', type: 'text', placeholder: 'Research links' },
  ],
  downloadMedia: [
    { key: 'url', label: 'File URL', type: 'text', placeholder: 'https://…/video.mp4 or image.jpg' },
    { key: 'urlVar', label: 'Or read URL from variable', type: 'text', placeholder: 'copiedLink' },
    { key: 'kind', label: 'Kind', type: 'select', options: ['image', 'video', 'file'], default: 'file' },
    { key: 'filename', label: 'Filename (optional)', type: 'text', placeholder: 'lecture.mp4' },
    { key: 'folder', label: 'Folder under data/', type: 'text', placeholder: 'media' },
    { key: 'maxMB', label: 'Maximum size (MB)', type: 'number', placeholder: '200' },
    { key: 'overwrite', label: 'Overwrite existing file', type: 'select', options: ['false', 'true'], default: 'false' },
    { key: 'outputVar', label: 'Save path to variable', type: 'text', placeholder: 'savedFile' },
    { key: 'noteTitle', label: 'Also note the saved file (optional)', type: 'text', placeholder: 'Saved media' },
  ],
  saveImage: [
    { key: 'source', label: 'Image source', type: 'select', options: ['screen', 'clipboard', 'url'], default: 'screen' },
    { key: 'url', label: 'Image URL (url source)', type: 'text', placeholder: 'https://…/image.png' },
    { key: 'urlVar', label: 'Or read URL from variable', type: 'text', placeholder: 'copiedLink' },
    { key: 'filename', label: 'Filename (optional)', type: 'text', placeholder: 'reference.png' },
    { key: 'folder', label: 'Folder under data/ (URL source)', type: 'text', placeholder: 'media' },
    { key: 'caption', label: 'Evidence caption', type: 'text', placeholder: 'Saved image' },
    { key: 'outputVar', label: 'Save path to variable', type: 'text', placeholder: 'savedImage' },
  ],
  watchVideo: [
    { key: 'title', label: 'Video window title contains', type: 'text', placeholder: 'YouTube' },
    { key: 'notes', label: 'Observations to include in the note', type: 'textarea', rows: 4, placeholder: 'Key points, timestamps, questions…' },
    { key: 'textVar', label: 'Read observations from variable', type: 'text', placeholder: 'extractedText' },
    { key: 'noteTitle', label: 'Note title', type: 'text', placeholder: 'Video notes — lecture' },
    { key: 'maxMs', label: 'Safety ceiling (ms)', type: 'number', placeholder: '900000' },
    { key: 'bufferMs', label: 'Extra hold after end (ms)', type: 'number', placeholder: '5000' },
    { key: 'outputVar', label: 'Save note id to variable', type: 'text', placeholder: 'videoNotesId' },
  ],
  writeTextFile: [
    { key: 'location', label: 'Location', type: 'select', options: ['desktop', 'data'], default: 'desktop', help: 'Desktop is the user Desktop folder; data writes under data/files.' },
    { key: 'path', label: 'Filename / path', type: 'text', placeholder: 'kiro-answer.txt' },
    { key: 'text', label: 'Text to save', type: 'textarea', rows: 4, placeholder: 'Answer text…' },
    { key: 'textVar', label: 'Use variable instead', type: 'text', placeholder: 'answer' },
    { key: 'append', label: 'Append to existing file', type: 'select', options: ['false', 'true'], default: 'false' },
    { key: 'overwrite', label: 'Overwrite existing file', type: 'select', options: ['true', 'false'], default: 'true' },
    { key: 'noteTitle', label: 'Also save a note (optional)', type: 'text', placeholder: 'Saved Kiro answer' },
    { key: 'outputVar', label: 'Save path to variable', type: 'text', placeholder: 'savedTextFile' },
  ],
  recordVideo: [
    { key: 'durationMs', label: 'Record for (ms)', type: 'number', placeholder: '10000', help: 'Maximum 10 minutes. Requires ffmpeg (the install step can add Gyan.FFmpeg).' },
    { key: 'fps', label: 'Frames per second', type: 'number', placeholder: '15' },
    { key: 'filename', label: 'Filename', type: 'text', placeholder: 'recording.mp4' },
    { key: 'folder', label: 'Folder under data/', type: 'text', placeholder: 'media' },
    { key: 'x', label: 'Region X (optional)', type: 'number', placeholder: '' },
    { key: 'y', label: 'Region Y (optional)', type: 'number', placeholder: '' },
    { key: 'width', label: 'Region width (optional)', type: 'number', placeholder: '' },
    { key: 'height', label: 'Region height (optional)', type: 'number', placeholder: '' },
    { key: 'caption', label: 'Evidence caption', type: 'text', placeholder: 'Screen recording' },
    { key: 'note', label: 'Save a note with the file', type: 'select', options: ['true', 'false'], default: 'true' },
    { key: 'noteTitle', label: 'Note title (optional)', type: 'text', placeholder: 'Recording — demo' },
    { key: 'outputVar', label: 'Save path to variable', type: 'text', placeholder: 'savedVideo' },
  ],
  installApp: [
    { key: 'app', label: 'App name', type: 'text', placeholder: 'VLC' },
    { key: 'id', label: 'winget package id (optional)', type: 'text', placeholder: 'VideoLAN.VLC' },
    { key: 'url', label: 'Installer URL (optional)', type: 'text', placeholder: 'https://get.videolan.org/... (blank = search the vendor page)' },
    { key: 'installerArgs', label: 'Installer switches (optional)', type: 'text', placeholder: '/L=1033 /S' },
    { key: 'maxAttempts', label: 'Methods to try', type: 'select', options: ['1', '2', '3', '4'], default: '3' },
    { key: 'source', label: 'Source (optional)', type: 'text', placeholder: 'winget' },
    { key: 'version', label: 'Version (optional)', type: 'text', placeholder: 'latest' },
    { key: 'scope', label: 'Scope', type: 'select', options: ['', 'user', 'machine'], default: '' },
    { key: 'silent', label: 'Silent install', type: 'select', options: ['true', 'false'], default: 'true' },
    { key: 'noteTitle', label: 'Note title (optional)', type: 'text', placeholder: 'Installed app' },
  ],
  testApp: [
    { key: 'target', label: 'App / executable to launch', type: 'text', placeholder: 'notepad.exe' },
    { key: 'title', label: 'Expected window title contains', type: 'text', placeholder: 'Notepad' },
    { key: 'process', label: 'Expected process name', type: 'text', placeholder: 'notepad' },
    { key: 'question', label: 'Optional vision check', type: 'textarea', rows: 3, placeholder: 'Does the app show a usable window with its main controls?' },
    { key: 'waitMs', label: 'Wait for app (ms)', type: 'number', placeholder: '15000' },
    { key: 'settleMs', label: 'Settle before capture (ms)', type: 'number', placeholder: '1500' },
    { key: 'close', label: 'Close after the test', type: 'select', options: ['false', 'true'], default: 'false' },
    { key: 'note', label: 'Save smoke-test note', type: 'select', options: ['true', 'false'], default: 'true' },
    { key: 'noteTitle', label: 'Note title', type: 'text', placeholder: 'App test — Notepad' },
  ],
};

const DEFAULTS = {
  launchApp: { target: '' },
  openUrl: { url: 'https://example.com', urlVar: '' },
  focusWindow: { title: '', process: '' },
  windowAction: { action: 'minimize', title: '', process: '' },
  move: { x: 400, y: 300 },
  click: { x: 400, y: 300, button: 'left' },
  doubleClick: { x: 400, y: 300 },
  rightClick: { x: 400, y: 300 },
  drag: { x1: 400, y1: 300, x2: 700, y2: 300, durationMs: 600, button: 'left' },
  dragCopy: { text: '', window: '', x1: '', y1: '', x2: '', y2: '', outputVar: 'selectedText', minChars: 1, expectText: '' },
  scroll: { amount: 3 },
  type: { text: 'Hello from Sightline' },
  key: { keys: 'ctrl+a, ctrl+c', repeat: 1, intervalMs: 120 },
  clipboard: { action: 'copyAll', outputVar: 'clipboardText', minChars: 1 },
  aiExtract: { source: 'clipboard', instructions: 'Extract the complete answer only, without my prompt or UI text.', outputVar: 'extractedText', maxChars: 24000 },
  wait: { ms: 1000 },
  waitFor: { kind: 'window', value: '', mode: 'present', timeoutMs: 30000, intervalMs: 1000 },
  screenshot: { caption: 'Screen capture' },
  verifyScreen: { question: 'Does the screen show the expected app or page in the expected state?', caption: 'Screen verification', onError: 'fail', minConfidence: 0.7 },
  verifyPlayback: { title: 'YouTube video', caption: 'Playback still advancing', intervalMs: 4000, onError: 'fail', minConfidence: 0.7 },
  mediaHold: { title: 'YouTube', bufferMs: 5000, maxMs: 900000, checkMs: 5000, stallMs: 30000, adGraceMs: 180000, caption: 'Media ended' },
  playMedia: { x: 640, y: 360, title: 'YouTube' },
  clickElement: { window: '', name: '', controlType: 'Button', button: 'left', visionFallback: 'true', verifyAfter: '' },
  closeWindow: { title: 'YouTube' },
  expect: { kind: 'window', value: '' },
  runTool: {},
  note: { text: 'Observation' },
  writeNote: { title: 'Interaction notes', text: '', append: 'true', tags: '', outputVar: 'noteId' },
  readNote: { title: '', noteId: '', path: '', outputVar: 'noteText', maxChars: 60000, allowMissing: 'false' },
  copyLink: { outputVar: 'copiedLink', foreground: '', noteTitle: '' },
  downloadMedia: { url: '', urlVar: '', kind: 'file', filename: '', folder: 'media', maxMB: 200, overwrite: 'false', outputVar: 'savedFile', noteTitle: '' },
  saveImage: { source: 'screen', url: '', urlVar: '', filename: '', folder: 'media', caption: 'Saved image', outputVar: 'savedImage' },
  writeTextFile: { location: 'desktop', path: 'kiro-answer.txt', text: '', textVar: '', append: 'false', overwrite: 'true', noteTitle: '', outputVar: 'savedTextFile' },
  recordVideo: { durationMs: 10000, fps: 15, filename: '', folder: 'media', caption: 'Screen recording', note: 'true', noteTitle: '', outputVar: 'savedVideo' },
  watchVideo: { title: 'YouTube', notes: '', textVar: '', noteTitle: '', maxMs: 900000, bufferMs: 5000, outputVar: 'videoNotesId' },
  installApp: { id: '', source: '', version: '', scope: '', silent: 'true', noteTitle: '' },
  testApp: { target: '', title: '', process: '', question: '', waitMs: 15000, settleMs: 1500, close: 'false', note: 'true', noteTitle: '' },
};

function stepSummary(step) {
  const p = (step && step.params) || {};
  switch (step.type) {
    case 'launchApp':
      return p.target || '(no target)';
    case 'openUrl':
      return p.url || '(no url)';
    case 'focusWindow':
      return `title contains “${p.title || ''}”`;
    case 'windowAction':
      return `${p.action || 'minimize'} · ${p.title || p.process || '(foreground window)'}`;
    case 'move':
      return `to ${p.x ?? 0}, ${p.y ?? 0}`;
    case 'click':
    case 'doubleClick':
    case 'rightClick':
      return `${p.button || 'left'} at ${p.x ?? 0}, ${p.y ?? 0}${p.foreground ? ` · guarded by “${p.foreground}”` : ''}`;
    case 'drag':
      return `${p.x1 ?? 0},${p.y1 ?? 0} → ${p.x2 ?? 0},${p.y2 ?? 0}${p.foreground ? ` · guarded by “${p.foreground}”` : ''}`;
    case 'dragCopy':
      return `${p.text || `${p.x1 ?? '?'},${p.y1 ?? '?'} → ${p.x2 ?? '?'},${p.y2 ?? '?'}`} → ${p.outputVar || 'selectedText'}`;
    case 'verifyScreen':
      return String(p.question || p.title || 'visual check').slice(0, 90);
    case 'verifyPlayback':
      return `two frames ${p.intervalMs ?? 4000} ms apart · “${p.title || 'YouTube'}”`;
    case 'mediaHold':
      return `until actual media end · max ${Math.round((p.maxMs || 900000) / 1000)}s · “${p.title || 'YouTube'}”`;
    case 'playMedia':
      return `check player; click only if paused · “${p.title || 'YouTube'}”`;
    case 'clickElement':
      return `find “${p.name || 'element'}” in ${p.window || 'window'}${p.controlType ? ` · ${p.controlType}` : ''}`;
    case 'closeWindow':
      return `guarded close · “${p.title || 'YouTube'}”`;
    case 'scroll':
      return `${p.amount ?? 0} lines${p.x != null ? ` at ${p.x}, ${p.y}` : ''}`;
    case 'type':
      return `“${String(p.text || '').replace(/\s+/g, ' ').slice(0, 56)}”`;
    case 'key':
      return Array.isArray(p.keys) ? p.keys.join(', ') : String(p.keys || '');
    case 'clipboard':
      return `${p.action || 'copy'}${p.outputVar ? ` → ${p.outputVar}` : ''}${p.foreground ? ` · guarded by “${p.foreground}”` : ''}`;
    case 'aiExtract':
      return `${String(p.instructions || 'extract text').slice(0, 60)}${p.outputVar ? ` → ${p.outputVar}` : ''}`;
    case 'writeNote':
      return `save “${p.title || 'interaction'}”${p.append !== 'false' ? ' · append' : ''}`;
    case 'readNote':
      return `“${p.title || p.noteId || 'latest'}” → ${p.outputVar || 'noteText'}`;
    case 'copyLink':
      return `address bar → ${p.outputVar || 'copiedLink'}`;
    case 'downloadMedia':
      return `${p.kind || 'file'} ← ${p.url || p.urlVar || '(no url)'}`;
    case 'saveImage':
      return `${p.source || 'screen'} image${p.filename ? ` · ${p.filename}` : ''}`;
    case 'writeTextFile':
      return `${p.location === 'data' ? 'data/files' : 'Desktop'}/${p.path || p.filename || 'text.txt'}`;
    case 'recordVideo':
      return `record ${Math.round((p.durationMs || 10000) / 1000)}s · ${p.fps || 15} fps`;
    case 'watchVideo':
      return `watch “${p.title || 'YouTube'}” · note “${p.noteTitle || 'auto'}”`;
    case 'installApp':
      return `winget · ${p.id || '(no package id)'}`;
    case 'testApp':
      return `launch + smoke test ${p.title || p.target || 'app'}`;
    case 'wait':
      return `${p.ms ?? 0} ms`;
    case 'waitFor':
      return `${p.kind || 'window'} “${p.value || ''}” ${p.mode || 'present'} · ${Math.round((p.timeoutMs || 30000) / 1000)}s`;
    case 'screenshot':
      return String(p.caption || 'screen');
    case 'expect':
      return `${p.kind || 'window'} contains “${p.value || ''}”`;
    case 'runTool':
      return (ui.data?.tools.find((t) => t.id === p.toolId)?.name) || p.toolId || '(no tool)';
    case 'note':
      return String(p.text || '').slice(0, 64);
    default:
      return '';
  }
}

function stepResultFor(workflow, stepId) {
  const run = workflow?.runHistory?.[0];
  if (!run) return null;
  const detail = ui.runDetail && ui.runDetail.id === run.id ? ui.runDetail : null;
  const steps = detail ? detail.steps : null;
  return steps ? steps.find((s) => s.id === stepId) : null;
}

/* ------------------------------------------------------------------ header */
function renderHeader() {
  const s = ui.data?.settings;
  const platform = ui.data?.platform || {};
  const available = Boolean(platform.available);
  const targetSelect = $('#target-os-select');
  const targetPlatform = s?.targetPlatform || 'win32';
  const targetLabels = { win32: 'Windows 11', linux: 'Linux/X11', darwin: 'macOS', android: 'Android' };
  if (targetSelect) targetSelect.value = targetPlatform;
  const pill = $('#mode-pill');
  const label = $('#mode-label');
  if (s && pill) {
    const live = !s.dryRun && available;
    pill.classList.toggle('live', live);
    pill.disabled = false;
    label.textContent = live ? 'Live control' : !available ? 'Simulated · check live' : 'Simulated';
    pill.title = !available
      ? `Live is not available until the executor passes a real readiness check. This console runs on ${platform.label || platform.platform || 'an unknown platform'}: ${platform.reason || 'no live desktop backend is available.'} Click to check again. The planning target does not connect another computer.`
      : live
        ? 'Live: runs move the real mouse and type on this desktop. Click to switch to simulated.'
        : 'Simulated: steps are validated without touching the desktop. Click to check the desktop and enable live control.';
  }
  const ai = $('#ai-status');
  if (ai) {
    ai.classList.toggle('ok', Boolean(ui.health?.online));
    ai.classList.toggle('off', ui.health && !ui.health.online);
    $('#ai-label').textContent = ui.health
      ? ui.health.online
        ? `${ui.health.model}${ui.health.modelPresent === false ? ' (not listed)' : ''}`
        : 'AI offline'
      : 'checking AI…';
    ai.title = ui.health?.online
      ? `Connected to ${ui.data?.settings.endpoint}. Local planner is used when the model is unreachable.`
      : `Cannot reach ${ui.data?.settings.endpoint || 'the AI endpoint'}: ${ui.health?.error || 'unreachable'}. Build and run still work with the local planner.`;
  }
  const plat = $('#platform-tag');
  if (plat && ui.data) {
    const label = String(platform.label || platform.platform || 'desktop');
    const target = targetLabels[targetPlatform] || 'Windows 11';
    plat.textContent = `${target} plan · ${platform.available ? `${label} live` : 'executor offline'}`;
    plat.title = platform.available
      ? `AI plans for ${target}; live input runs on this ${label} executor using ${platform.input || 'input'} and ${platform.capture || 'unknown'} capture.`
      : `AI plans for ${target}, but actions execute on this ${label} machine and remain simulated: ${platform.reason || 'no live backend'}. Selecting another target OS does not attach a remote desktop.`;
  }
  const counts = ui.data?.counts;
  $('#badge-suggestions').textContent = counts?.suggestions ? String(counts.suggestions) : '';
  const missionBadge = $('#badge-missions');
  if (missionBadge) missionBadge.textContent = counts?.missionsActive ? String(counts.missionsActive) : '';
  $('#badge-runs').textContent = counts?.failures ? String(counts.failures) : counts?.activeRuns ? String(counts.activeRuns) : '';
  const memoryBadge = $('#badge-memory');
  if (memoryBadge) memoryBadge.textContent = ui.data?.workflowMemory?.count ? String(ui.data.workflowMemory.count) : '';
  const companionBadge = $('#badge-companion');
  if (companionBadge) {
    const c = ui.data?.companion?.summary;
    companionBadge.textContent = c?.unread ? String(c.unread) : c?.proposals ? String(c.proposals) : '';
  }
  const ambientBadge = $('#badge-ambient');
  if (ambientBadge) {
    const a = ui.data?.ambient?.summary;
    ambientBadge.textContent = a?.unread ? String(a.unread) : a?.rulesEnabled ? String(a.rulesEnabled) : '';
  }
  const continuityBadge = $('#badge-continuity');
  if (continuityBadge) {
    const c = ui.data?.continuity?.summary;
    continuityBadge.textContent = c?.readyContinuations ? String(c.readyContinuations) : c?.openSuggestions ? String(c.openSuggestions) : '';
  }
  const sentinelBadge = $('#badge-sentinel');
  if (sentinelBadge) {
    const s = ui.data?.sentinel || {};
    sentinelBadge.textContent = s.openFailures ? String(s.openFailures) : '';
    sentinelBadge.className = s.openFailures ? 'warnbadge' : '';
  }
  const relayBadge = $('#badge-relay');
  if (relayBadge) relayBadge.textContent = ui.data?.relay?.openReviews ? String(ui.data.relay.openReviews) : '';
  const adminBtn = $('#admin-btn');
  if (adminBtn) {
    adminBtn.textContent = ui.auth?.authenticated ? `Admin · ${ui.auth.username}` : 'Admin sign-in';
    adminBtn.title = ui.auth?.authenticated
      ? 'Signed in for operator commands. Click to change the password or sign out.'
      : 'Local admin sign-in for FORCE_REPLAN and other privileged operator commands.';
  }
  const engine = $('#engine-label');
  if (engine && counts) {
    engine.textContent = counts.activeRuns ? `${counts.activeRuns} run active` : 'engine idle';
    const dot = engine.previousElementSibling;
    if (dot) dot.className = counts.activeRuns ? 'dot run' : 'dot ok';
  }
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.nav === ui.view);
  });
}

/* ------------------------------------------------------------------ views */
let lastRenderState = null;

function render() {
  if (!ui.data) {
    $('#view').innerHTML = '<div class="empty"><strong>Connecting…</strong>Loading console state.</div>';
    return;
  }
  const previous = lastRenderState;
  const sameRunsView = previous?.view === 'runs' && ui.view === 'runs';
  const sameFilter = sameRunsView && previous.filter === ui.runFilter;
  const sameRun = sameFilter && previous.run === (ui.selectedRun || null);
  const pageY = sameRun ? window.scrollY : null;
  const listY = sameFilter ? document.querySelector('.runs-list')?.scrollTop ?? null : null;
  renderHeader();
  renderSyncPill();
  const map = {
    builder: renderBuilder,
    runs: renderRuns,
    memory: renderMemory,
    companion: renderCompanion,
    ambient: renderAmbient,
    continuity: renderContinuity,
    captures: renderCaptures,
    examples: renderExamples,
    tools: renderTools,
    python: renderPython,
    files: renderFiles,
    agents: renderAgents,
    shortcuts: renderShortcuts,
    links: renderElementLinks,
    command: renderCommandCenter,
    presentation: renderPresentation,
    sync: renderSync,
    sentinel: renderSentinel,
    relay: renderRelay,
  };
  $('#view').innerHTML = (map[ui.view] || renderBuilder)();
  if (pageY != null) window.scrollTo({ top: pageY, behavior: 'auto' });
  if (listY != null) {
    const list = document.querySelector('.runs-list');
    if (list) list.scrollTop = listY;
  }
  const presenterRoot = $('#presenter-root');
  if (presenterRoot) {
    // The dock itself scrolls. Replacing its markup on every poll resets that
    // scroll to the top, so keep the position and skip identical renders.
    const dock = presenterRoot.querySelector('.presenter-dock');
    const dockScroll = dock ? { top: dock.scrollTop, left: dock.scrollLeft } : null;
    // A poll can arrive mid-sentence; keep the guide field focused with its caret.
    const activeField =
      document.activeElement &&
      presenterRoot.contains(document.activeElement) &&
      document.activeElement.matches('input[data-scope="presenter"]')
        ? document.activeElement
        : null;
    const fieldSelection = activeField
      ? { start: activeField.selectionStart, end: activeField.selectionEnd }
      : null;
    const nextDock = renderPresenterDock();
    if (presenterRoot.innerHTML !== nextDock) {
      presenterRoot.innerHTML = nextDock;
      const restored = presenterRoot.querySelector('.presenter-dock');
      if (restored && dockScroll) {
        restored.scrollTop = dockScroll.top;
        restored.scrollLeft = dockScroll.left;
      }
      if (fieldSelection) {
        const field = presenterRoot.querySelector('input[data-scope="presenter"]');
        if (field && !field.disabled) {
          field.focus({ preventScroll: true });
          try {
            field.setSelectionRange(
              fieldSelection.start ?? field.value.length,
              fieldSelection.end ?? field.value.length
            );
          } catch {
            // Some input types do not expose a selection; focusing is enough.
          }
        }
      }
    }
    presenterRoot.style.display = ui.data.presenter ? '' : 'none';
  }
  const trayRoot = $('#tray-root');
  if (trayRoot) {
    const nextTray = renderRunTray();
    if (trayRoot.innerHTML !== nextTray) trayRoot.innerHTML = nextTray;
  }
  lastRenderState = { view: ui.view, run: ui.selectedRun || null, filter: ui.runFilter };
}

function renderPresenterDock() {
  const p = ui.data?.presenter;
  if (!p) return '';
  const app = p.app || {};
  const ai = p.ai || {};
  const run = (ui.data.runs || []).find((entry) => entry.id === p.runId);
  const active = Boolean(run && ['running', 'queued'].includes(run.status)) || p.active;
  const observations = (p.observations || []).slice(0, 5);
  const review = (p.agentReviews || [])[0] || null;
  const fallbacks = (p.fallbacks || []).slice(0, 3);
  const nearest = (p.position?.nearest || []).slice(0, 2);
  if (ui.presenterCollapsed) {
    return `<button class="presenter-bubble" data-act="presenter-expand" title="Open the foreground presenter">▣ <strong>${esc(app.status || 'presenter')}</strong><small>${esc(ai.status || '')}</small></button>`;
  }
  return `<aside class="presenter-dock ${active ? 'active' : 'finished'}" aria-live="polite">
    <div class="presenter-head">
      <div><span class="presenter-kicker">Foreground presenter</span><strong>${esc(p.workflowName || 'Run')}</strong></div>
      <div class="row wrap">${statusPill(app.status || 'unopened', `app · ${app.status || 'unopened'}`)}${statusPill(ai.status || 'thinking', `ai · ${ai.status || 'thinking'}${ai.action ? ` · ${ai.action}` : ''}`)}<button class="presenter-close" data-act="presenter-collapse" title="Minimize">–</button></div>
    </div>
    <div class="presenter-body">
      <div class="presenter-goal"><span class="dim">Request</span><strong>${esc(p.goal || 'goal not recorded')}</strong></div>
      <div class="presenter-app">
        <div><span class="dim">App</span><strong>${esc(app.target || app.name || 'not identified')}</strong></div>
        <div><span class="dim">Path</span><code>${esc(app.path || 'resolved when the app opens')}</code></div>
        <div><span class="dim">Method</span><span>${esc(app.method || 'foreground interaction')}</span></div>
        <div><span class="dim">Detail</span><span>${esc(app.detail || '')}</span></div>
      </div>
      <div class="presenter-progress"><span style="width:${Math.max(0, Math.min(100, Number(p.progress) || 0))}%"></span></div>
      <div class="presenter-grid">
        <div><span class="dim">Done</span>${esc(p.summary?.whatsDone || '—')}</div>
        <div><span class="dim">Doing</span>${esc(p.summary?.whatDoing || '—')}</div>
        <div><span class="dim">Next</span>${esc(p.summary?.whatsNext || '—')}</div>
        <div><span class="dim">Goal met</span>${p.summary?.goalMet === true ? '<span class="badge okbadge">yes</span>' : p.summary?.goalMet === false ? '<span class="badge warnbadge">not yet</span>' : '<span class="badge">pending</span>'}</div>
      </div>
      ${(p.prep || []).length ? `<div class="presenter-prep"><span class="dim small">Next-step prep</span>${p.prep.map((item) => `<div>${esc(item)}</div>`).join('')}</div>` : ''}
      ${p.verifier ? `<div class="presenter-review"><span class="dim small">Presentation verifier · ${esc(p.verifier.status)}${p.verifier.app?.name ? ` · ${esc(p.verifier.app.name)}` : ''}</span><span>${esc(p.verifier.summary || '')}</span><span class="dim small">${esc(p.verifier.checks?.length || 0)} check(s) · ${esc(p.verifier.evidenceCount || 0)} evidence</span></div>` : ''}
      ${p.needsInput ? `<div class="presenter-needs"><strong>Input needed</strong><span>${esc(p.needsInput.message || 'The run needs a decision.')}</span><span class="dim small">policy: ${esc(p.needsInput.policy || 'auto')}</span></div>` : ''}
      <div class="presenter-observer">
        <span class="dim small">Live observations</span>
        ${observations.length ? observations.map((item) => `<div class="presenter-observation ${esc(item.level || 'info')}"><span class="mono dim">${fmtTime(item.at)}</span>${esc(item.message)}</div>`).join('') : '<div class="dim small">Waiting for the next action.</div>'}
      </div>
      ${(p.userNotes || []).length ? `<div class="presenter-observer"><span class="dim small">User guidance saved</span>${p.userNotes.slice(0, 3).map((note) => `<div class="presenter-observation">${esc(note.text)}</div>`).join('')}</div>` : ''}
      ${review ? `<div class="presenter-review"><span class="dim small">Agent review · ${esc(review.verdict || 'aligned')}</span><span>${esc((review.previous || []).join(' → ') || 'no previous step')} → <strong>${esc(review.current || '')}</strong>${review.next?.length ? ` → ${esc(review.next.join(' → '))}` : ''}</span>${review.agents?.[0]?.advice ? `<span class="dim small">${esc(review.agents[0].name)}: ${esc(review.agents[0].advice)}</span>` : ''}${review.suggestions?.length ? `<span class="dim small">Suggestion: ${esc(review.suggestions[0])}</span>` : ''}${review.override ? `<span class="warn small">Override: ${esc(review.override.reason)}</span>` : ''}</div>` : ''}
      ${fallbacks.length ? `<div class="presenter-fallbacks"><span class="dim small">Fallbacks ready</span>${fallbacks.map((item) => `<span class="badge">${esc(item.label)}</span>`).join('')}</div>` : ''}
      ${nearest.length ? `<div class="presenter-position"><span class="dim small">Position memory</span>${nearest.map((item) => `<span class="badge">${item.x},${item.y} · ${item.similarity}%</span>`).join('')}</div>` : ''}
      <div class="presenter-controls">
        <input type="text" value="${esc(ui.presenterInput || '')}" data-scope="presenter" data-key="input" placeholder="Tell the presenter what to do next…" aria-label="Guide the presenter" ${active ? '' : 'disabled'} />
        <button class="btn btn-sm btn-primary" data-act="presenter-guide" data-id="${esc(p.runId)}" ${active ? '' : 'disabled'}>Guide</button>
        <button class="btn btn-sm btn-ghost" data-act="presenter-cmd" data-id="${esc(p.runId)}" data-cmd="pause" ${active ? '' : 'disabled'}>Pause</button>
        <button class="btn btn-sm btn-ghost" data-act="presenter-cmd" data-id="${esc(p.runId)}" data-cmd="continue" ${active ? '' : 'disabled'}>Continue</button>
        ${run ? `<button class="btn btn-sm" data-act="select-run" data-id="${esc(run.id)}">Open run</button>` : ''}
      </div>
    </div>
  </aside>`;
}

function renderRunTray() {
  const runs = ui.data?.runs || [];
  if (!runs.length) return '';
  const active = runs.find((run) => ['running', 'queued'].includes(run.status)) || null;
  const run = active || runs[0];
  if (!active && ui.trayDismissed === run.id) return '';
  const paused = Boolean(run.paused);
  const skipping = Boolean(run.skipRequested);
  const cancelling = Boolean(run.cancelRequested);
  const total = Number(run.total || 0);
  const settled = Number(run.passed || 0) + Number(run.failed || 0);
  const pct = total ? Math.round((settled / total) * 100) : 0;
  const step = run.position?.step?.name || '';
  const next = run.position?.next?.name || '';
  const control = cancelling
    ? 'cancel requested · finishing the current step'
    : skipping
    ? 'skip queued · the active wait or next step is skipped'
    : paused
    ? 'holding · paused at a step boundary'
    : active
    ? 'running · pause, skip and cancel are live'
    : `finished · ${run.status}`;
  const startedAt = run.startedAt ? Date.parse(run.startedAt) : null;
  const endedAt = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  const seconds = startedAt && Number.isFinite(endedAt) ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : 0;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const failed = (run.failedSteps || []).slice(0, 3);

  if (ui.trayCollapsed) {
    return `<button class="tray-bubble ${active ? 'active' : ''}" data-act="tray-toggle" title="Open run status">
      <span class="dot ${active ? 'ok' : ''}"></span><strong>${esc(run.workflowName || 'run')}</strong>
      <small>${esc(`${settled}/${total} · ${run.status}`)}</small>
    </button>`;
  }

  return `<aside class="tray ${active ? 'active' : 'finished'}" aria-live="polite">
    <div class="tray-head">
      <div class="tray-title">
        <span class="dot ${active ? 'ok' : ''}"></span>
        <div><strong>${esc(run.workflowName || 'Run')}</strong><span class="dim small">${esc(run.dryRun ? 'simulated' : 'live')} · ${esc(run.trigger || 'manual')} · ${clock}</span></div>
      </div>
      <div class="row" style="gap:4px">
        <button class="btn-icon" data-act="tray-details" title="${ui.trayExpanded ? 'Hide details' : 'Show process details'}">${ui.trayExpanded ? '▾' : '▸'}</button>
        <button class="btn-icon" data-act="tray-toggle" title="Minimize">–</button>
        ${active ? '' : `<button class="btn-icon" data-act="tray-dismiss" data-id="${esc(run.id)}" title="Dismiss">✕</button>`}
      </div>
    </div>
    <div class="tray-meter" title="${settled}/${total} steps settled"><i style="width:${pct}%"></i></div>
    <div class="tray-status">${statusPill(run.status, run.status)}<span class="small">${esc(control)}</span></div>
    <div class="tray-step"><b>${esc(step || (active ? 'waiting for the next step' : 'run finished'))}</b><span class="dim small">${settled}/${total} steps · ${Number(run.passed || 0)} passed${Number(run.awaitingChecks) > 0 ? ` (${Number(run.awaitingChecks)} still checking)` : ''} · ${Number(run.failed || 0)} failed · ${Number(run.evidenceCount || 0)} evidence</span></div>
    ${Number(run.awaitingChecks) > 0 && run.verificationState !== 'unverified' ? `<div class="dim small" title="Queued verification checks are being re-read on a timer; the step is not counted as finished until they answer.">${
      run.verificationState === 'stale'
        ? 'queued check left open — not re-read'
        : `checking · review ${Number(run.verificationAttempts) || 1}${run.verificationStalled ? ' · stalled — needs a decision' : ''}`
    }</div>` : ''}
    ${run.presence?.holding ? `<div class="dim small" title="The run is waiting so it does not take the desktop while you work.">waiting for the desktop · ${esc(run.presence.reason || 'the user is active')}${Number(run.presence.deferredMs) > 0 ? ` · held ${Math.round(Number(run.presence.deferredMs) / 1000)}s` : ''}</div>` : ''}
    ${run.presence?.fastPath && !run.presence?.holding ? `<div class="dim small" title="The step went ahead while you were using the desktop because it did not need to interrupt you.">continued while you were active · ${esc(run.presence.reason || 'one quick action')}${Number(run.presence.rechecked?.pending) > 0 ? ` · re-checked ${Number(run.presence.rechecked.pending)} pending check${Number(run.presence.rechecked.pending) === 1 ? '' : 's'}` : ''}</div>` : ''}
    ${ui.trayExpanded ? `<div class="tray-detail">
      ${next ? `<div><span class="dim">Next</span> ${esc(next)}</div>` : ''}
      ${run.position ? `<div><span class="dim">Position</span> ${Number(run.position.stepNumber) || 0}/${Number(run.position.total) || total} · ${esc(run.position.phase || '')}</div>` : ''}
      <div><span class="dim">Control</span> ${esc(control)}</div>
      ${failed.length ? failed.map((item) => `<div><span class="dim">Failed</span> <b>${esc(item.name || 'step')}</b><br><span class="small" style="color:var(--bad)">${esc(item.error || 'no error recorded')}</span></div>`).join('') : ''}
      ${run.followup ? `<div><span class="dim">Independent check</span> ${run.followup.ok ? 'passed' : 'failed'} — ${esc(run.followup.summary || '')}</div>` : ''}
      <div><span class="dim">Run id</span> <span class="mono small">${esc(run.id)}</span></div>
    </div>` : ''}
    <div class="tray-actions">
      ${active ? `<button class="btn btn-sm" data-act="run-control" data-id="${esc(run.id)}" data-cmd="pause" ${paused ? 'disabled' : ''}>Pause</button>
        <button class="btn btn-sm" data-act="run-control" data-id="${esc(run.id)}" data-cmd="skip" ${skipping ? 'disabled' : ''}>Skip step</button>
        <button class="btn btn-sm btn-primary" data-act="run-control" data-id="${esc(run.id)}" data-cmd="resume" ${paused ? '' : 'disabled'}>Resume</button>
        <button class="btn btn-sm btn-danger" data-act="cancel-run" data-id="${esc(run.id)}">Cancel</button>` : `<button class="btn btn-sm" data-act="select-run" data-id="${esc(run.id)}">Open run</button><button class="btn btn-sm btn-ghost" data-act="run-simulate" data-id="${esc(run.id)}" ${ui.simBusy ? 'disabled' : ''}>Screenshot check</button>`}
    </div>
  </aside>`;
}

function emptyState(title, text, actionHtml = '') {
  return `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}${actionHtml ? `<div style="margin-top:14px">${actionHtml}</div>` : ''}</div>`;
}

/* ------------------------------------------------------------------ builder */
function renderBuilder() {
  const d = ui.data;
  const wfs = d.workflows;
  const pendingProposals = (d.proposals || []).filter((proposal) => proposal.status === 'pending').length;
  const head = `
  <div class="page-head">
    <div>
      <h1>AI &amp; UI Builders</h1>
      <p>Compose a desktop workflow from explicit steps, or describe a goal and let the model draft it. Runs execute in a background queue on this machine; failures return with screenshots, logs and a diagnosis.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn btn-ghost" data-act="rail-tab" data-tab="copilot" title="Research-backed workflow proposals waiting for approval">
        ${pendingProposals ? `🔎 ${pendingProposals} proposal${pendingProposals === 1 ? '' : 's'}` : 'Research & propose'}
      </button>
      <button class="btn btn-ghost" data-act="capture-now">Capture screen</button>
      <button class="btn" data-act="new-workflow">＋ New workflow</button>
    </div>
  </div>`;

  if (!wfs.length) {
    return head + emptyState('No workflows yet', 'Create one and add your first step.', '<button class="btn btn-primary" data-act="new-workflow">＋ New workflow</button>');
  }
  if (!ui.selectedWorkflow || !wfs.some((w) => w.id === ui.selectedWorkflow)) ui.selectedWorkflow = wfs[0].id;
  const wf = wfs.find((w) => w.id === ui.selectedWorkflow);
  const lastRun = wf.runHistory[0];
  const platform = d.platform || {};
  const liveAvailable = Boolean(platform.available);
  const sim = Boolean(d.settings.dryRun || !liveAvailable);
  const windowsOnlyTargets = wf.steps
    .filter((step) => step.type === 'launchApp' && /\.exe(?:$|\s)/i.test(String(step.params?.target || '').trim()))
    .map((step) => String(step.params?.target || '').trim());
  const platformNotice = !liveAvailable || (platform.backend !== 'win32' && windowsOnlyTargets.length)
    ? `<div class="hint-box" style="margin:0 0 12px;border-color:rgba(251,191,36,.35)"><strong>${!liveAvailable ? 'Live desktop control is unavailable' : 'Windows-only app target'}</strong> · ${!liveAvailable ? esc(platform.reason || 'No live backend is available.') : ''}${windowsOnlyTargets.length && platform.backend !== 'win32' ? ` ${esc(windowsOnlyTargets.join(', '))} cannot run as a native Linux app; use a Windows desktop for this workflow.` : ''} ${!liveAvailable ? 'Live requests remain blocked unless a real executor readiness check succeeds; simulated runs will not open apps or capture real screenshots.' : ''}</div>`
    : '';

  const rail = `
  <aside class="wf-rail">
    <div class="wf-rail-head"><h3>Workflows</h3><span class="dim small">${wfs.length}</span></div>
    ${wfs
      .map(
        (w) => `
      <button class="wf-item ${w.id === wf.id ? 'active' : ''}" data-act="select-workflow" data-id="${w.id}">
        <strong>${esc(w.name)}</strong>
        <span class="wf-item-meta">
          ${statusPill(w.status)}
          <span>${w.steps.length} step${w.steps.length === 1 ? '' : 's'}</span>
          ${w.runHistory[0] ? `<span class="dim">· ${fmtTime(w.runHistory[0].createdAt)}</span>` : ''}
        </span>
      </button>`
      )
      .join('')}
  </aside>`;

  return (
    head +
    platformNotice +
    `<div class="builder-grid">${rail}${renderBuilderMain(wf, lastRun, sim, liveAvailable, platform.reason)}</div>` +
    `<p class="builder-footnote">Live desktop actions use the available backend on the machine running this console. Simulated runs validate the workflow shape without touching the desktop; live input steps can require a matching foreground window so they refuse to act in the background. “Verify screen” captures fresh pixels and asks the vision model whether the visible app/page and state actually match before the run continues. Coordinates are absolute virtual-screen pixels.</p>`
  );
}

function renderBuilderMain(wf, lastRun, sim, liveAvailable, liveReason) {
  const stepTypes = ui.data.stepTypes;
  const groups = [...new Set(stepTypes.map((t) => t.group))];
  const palette = (index) => {
    if (ui.paletteAt !== index) return '';
    return `
    <div class="palette">
      <div class="palette-head">
        <strong>Insert step at ${index + 1}</strong>
        <button class="btn-icon" data-act="close-palette" title="Close">✕</button>
      </div>
      ${groups
        .map(
          (group) => `
        <div class="palette-group">
          <span>${esc(group)}</span>
          <div class="palette-grid">
            ${stepTypes
              .filter((t) => t.group === group)
              .map(
                (t) => `<button class="palette-item" data-act="pick-step" data-type="${t.type}" data-index="${index}">${esc(
                  t.label
                )}<small>${t.type}</small></button>`
              )
              .join('')}
          </div>
        </div>`
        )
        .join('')}
    </div>`;
  };

  const insertRow = (index) => `
    ${palette(index)}
    <div class="insert-row ${ui.paletteAt === index ? 'open' : ''}">
      <span class="insert-line"></span>
      <button class="insert-btn" data-act="open-palette" data-index="${index}">＋ insert here</button>
      <span class="insert-line"></span>
    </div>`;

  const stepsHtml = wf.steps.length
    ? `<ul class="step-list">
        ${wf.steps
          .map((step, index) => {
            const result = stepResultFor(wf, step.id);
            const cls = [ui.selectedStep === step.id ? 'selected' : '', result?.status === 'failed' ? 'failed' : ''].join(' ');
            return `${insertRow(index)}
            <li class="step-card ${cls}" data-act="select-step" data-id="${step.id}">
              <div class="step-order">${index + 1}</div>
              <div class="step-body">
                <div class="step-top">
                  <span class="type-chip">${esc(TYPE_META[step.type]?.label || step.type)}</span>
                  ${step.optional ? '<span class="badge">optional</span>' : ''}
                  ${step.condition ? `<span class="badge">${esc(step.condition === 'newChat' ? 'only on new chat' : step.condition)}</span>` : ''}
                  ${result ? `<span class="step-result"><span class="dot ${result.status === 'passed' ? 'ok' : result.status === 'failed' ? '' : ''}" style="${
                    result.status === 'failed' ? 'background:#fb7185' : result.status === 'passed' ? 'background:#4ade80' : ''
                  }"></span>${esc(result.status)}</span>` : ''}
                </div>
                <div class="step-name">${esc(step.name)}</div>
                <div class="step-params mono">${esc(stepSummary(step))}</div>
              </div>
              <div class="step-actions">
                <button class="btn-icon" data-act="move-step" data-id="${step.id}" data-dir="up" title="Move up">↑</button>
                <button class="btn-icon" data-act="move-step" data-id="${step.id}" data-dir="down" title="Move down">↓</button>
                <button class="btn-icon" data-act="duplicate-step" data-id="${step.id}" title="Duplicate">⧉</button>
                <button class="btn-icon danger" data-act="delete-step" data-id="${step.id}" title="Delete">✕</button>
              </div>
            </li>`;
          })
          .join('')}
        ${insertRow(wf.steps.length)}
      </ul>`
    : `<div class="empty" style="margin-top:6px">
        <strong>No steps yet</strong>
        Add a step below, or use the AI copilot to draft the sequence from a goal.
      </div>`;

  const lastRunCard = lastRun
    ? `<div class="card section-gap">
        <div class="card-head">
          <h3>Last run · failure evidence</h3>
          <div class="row">
            ${statusPill(lastRun.status)}
            ${modeBadge(lastRun.dryRun)}
            <button class="btn btn-sm" data-act="select-run" data-id="${lastRun.id}">Review run →</button>
          </div>
        </div>
        <div class="card-body">
          ${
            lastRun.evidenceCount
              ? `<div class="row wrap" style="gap:10px"><span class="muted small">${lastRun.evidenceCount} evidence item${
                  lastRun.evidenceCount === 1 ? '' : 's'
                } captured</span><span class="dim small">${lastRun.passed}/${lastRun.total} steps passed</span></div>`
              : `<span class="muted small">${lastRun.liveFallback ? 'No live evidence was captured because this run was converted to simulated mode.' : wf.steps.some((step) => step.type === 'screenshot') ? 'No screenshot evidence was produced by the last run; open the run to inspect where it stopped.' : 'No evidence on the last run yet. Add a Capture screen step before your assertions.'}</span>`
          }
          ${lastRun.liveFallback ? `<div class="hint-box" style="margin-top:9px">Live control was unavailable: ${esc(lastRun.liveFallback)}</div>` : ''}
          ${
            lastRun.failed
              ? `<div class="hint-box" style="margin-top:9px;border-left-color:rgba(251,113,133,.6);background:rgba(251,113,133,.06)">${lastRun.failed} step${
                  lastRun.failed === 1 ? '' : 's'
                } failed. Open the run to inspect the failure screenshot, step error and AI diagnosis.</div>`
              : ''
          }
        </div>
      </div>`
    : '';

  return `
  <section>
    <div class="card wf-head">
      <input class="title-input" value="${esc(wf.name)}" data-scope="wf" data-key="name" data-id="${wf.id}" aria-label="Workflow name" />
      <textarea class="wf-desc" rows="2" data-scope="wf" data-key="description" data-id="${wf.id}" aria-label="Workflow description" placeholder="What does this workflow verify?">${esc(
        wf.description || ''
      )}</textarea>
      <label class="wf-tags"><span class="dim small">Pattern tags</span>
        <input type="text" value="${esc((wf.patternTags || []).join(', '))}" data-scope="wf" data-key="patternTagsCsv" data-id="${wf.id}" placeholder="retry, timeout, login" aria-label="Pattern tags" />
        <span class="dim small">comma-separated · used for filters and retry analytics</span>
      </label>
      <div class="wf-head-row">
        <div class="seg" role="group" aria-label="Workflow status">
          ${['draft', 'ready']
            .map(
              (s) =>
                `<button class="${wf.status === s ? `active ${s}` : ''}" data-act="wf-status" data-id="${wf.id}" data-status="${s}" title="${
                  s === 'draft' ? 'Draft: editable, excluded from background schedules' : 'Ready: can be queued by background agents'
                }">${s === 'draft' ? 'Draft' : 'Ready'}</button>`
            )
            .join('')}
        </div>
        <span class="badge">${wf.steps.length} steps</span>
        ${wf.stats ? `<span class="badge">complexity ${wf.stats.avgComplexity}</span><span class="badge ${wf.stats.flakinessScore > 30 ? 'warnbadge' : ''}">flaky ${wf.stats.flakinessScore}%</span><span class="badge">${wf.stats.totalFailures7d} failures / 7d</span>${wf.stats.requiresAdvancedPlanning ? '<span class="badge ai">advanced planning</span>' : ''}` : ''}
        <span class="spacer"></span>
        <button class="btn" data-act="run-workflow" data-id="${wf.id}" data-mode="${sim ? 'dry' : 'live'}">
          ▶ Run ${sim ? 'simulated' : 'live'}
        </button>
        <button class="btn btn-ghost btn-sm" data-act="run-workflow" data-id="${wf.id}" data-mode="${sim ? 'live' : 'dry'}" title="${esc(sim ? 'Check desktop readiness, then confirm before a live run.' : 'Run once in simulated mode.')}">
          or ${sim ? 'live' : 'simulated'}
        </button>
        <button class="btn btn-ghost btn-sm" data-act="delete-workflow" data-id="${wf.id}" title="Delete workflow">🗑</button>
      </div>
    </div>

    <div class="steps-head">
      <h3>Steps</h3>
      <div class="row">
        <span class="dim small">${wf.status === 'ready' ? 'Ready for scheduling' : 'Draft — manual runs only'}</span>
        <button class="btn btn-sm" data-act="lint-workflow" data-id="${wf.id}">Lint</button>
        <button class="btn btn-sm" data-act="open-palette" data-index="${wf.steps.length}">＋ Add step</button>
      </div>
    </div>
    ${stepsHtml}
    ${renderWorkflowLint(wf)}
    ${lastRunCard}
  </section>`;
}

function renderWorkflowLint(wf) {
  const lint = ui.workflowLint;
  if (!lint || lint.workflowId !== wf.id) return '';
  return `<div class="card section-gap">
    <div class="card-head"><h3>Workflow lint</h3><div class="row"><span class="badge ${lint.issues.length ? 'warnbadge' : 'okbadge'}">${lint.issues.length} issue${lint.issues.length === 1 ? '' : 's'}</span><button class="btn btn-sm btn-ghost" data-act="lint-workflow" data-id="${wf.id}">Re-run</button></div></div>
    <div class="card-body">${lint.issues.length ? `<ul class="small" style="margin:0;padding-left:18px">${lint.issues.map((issue) => `<li><strong>${esc(issue.code)}</strong>${issue.stepNumber ? ` · step ${issue.stepNumber}` : ''}${issue.message ? ` — ${esc(issue.message)}` : ''}</li>`).join('')}</ul>` : '<p class="muted small" style="margin:0">No lint issues found.</p>'}</div>
  </div>`;
}

function renderBuilderRail(wf) {
  const tabs = [
    ['inspector', 'Step'],
    ['rules', 'Rules'],
    ['copilot', 'AI'],
    ['factoring', 'Factors'],
    ['control', 'Control'],
  ];
  const suggestions = ui.data.suggestions.filter((s) => !s.workflowId || s.workflowId === wf.id);
  return `
  <aside class="side-rail">
    <div class="tabs" role="tablist">
      ${tabs.map(([key, label]) => `<button class="${ui.railTab === key ? 'active' : ''}" data-act="rail-tab" data-tab="${key}">${label}</button>`).join('')}
    </div>
    ${ui.railTab === 'inspector' ? renderInspector(wf) : ''}
    ${ui.railTab === 'rules' ? renderRules(wf) : ''}
    ${ui.railTab === 'copilot' ? renderCopilot(wf, suggestions) : ''}
    ${ui.railTab === 'factoring' ? renderFactoringPanel(wf) : ''}
    ${ui.railTab === 'control' ? renderControlPanel() : ''}
  </aside>`;
}

function renderFactoringPanel(wf) {
  const factoring = ui.data?.factoring || {};
  const patterns = factoring.patterns || [];
  const plans = (factoring.plans || []).slice(0, 5);
  const pinned = (wf.steps || []).filter((step) => step.intent);
  const intentCounts = {};
  for (const step of pinned) intentCounts[step.intent] = (intentCounts[step.intent] || 0) + 1;
  const intents = Object.entries(intentCounts).map(([intent, count]) => `<span class="badge" title="${esc(intent)}">${esc(intent)} ×${count}</span>`).join(' ');
  return `
  <div class="side-card">
    <div class="side-card-head"><h3>Step factoring</h3><span class="dim small">${factoring.patternCount || 0} pattern(s)</span></div>
    <div class="side-card-body">
      <p class="muted small" style="margin-bottom:8px">Every run fingerprints each step (type + params) into a shared ledger. Steps that keep passing in any workflow grow stronger — their proven form is offered to later runs that hit the same step form.</p>
      <div class="row wrap" style="gap:5px;margin-bottom:8px">${intents || '<span class="dim small">No intents pinned yet — they pin automatically on the next run.</span>'}</div>
      <div class="row wrap" style="gap:6px">
        <button class="btn btn-sm" data-act="factoring-pin" data-id="${esc(wf.id)}">Pin intents</button>
        <button class="btn btn-sm" data-act="factoring-plan">Scan for refactors</button>
      </div>
      ${patterns.length ? `<div class="stack" style="gap:6px;margin-top:10px"><div class="dim small">Strongest proven forms (upscaled learning)</div>${patterns.map((pattern) => `<div class="hint-box small"><strong>${esc(pattern.intent)}</strong> · strength ${pattern.strength} · passed ${pattern.successes}×${pattern.failures ? `, failed ${pattern.failures}×` : ''}${pattern.sample ? `<br><span class="dim">“${esc(pattern.sample.stepName)}” in “${esc(pattern.sample.workflowName)}”</span>` : ''}</div>`).join('')}</div>` : ''}
      ${plans.length ? `<div class="stack" style="gap:6px;margin-top:10px"><div class="dim small">Refactor plans</div>${plans.map((plan) => `<div class="hint-box small"><strong>${esc(plan.summary)}</strong><br><span class="dim">${fmtTime(plan.at)} · ${esc(plan.status)}</span>${plan.status === 'proposed' ? ` <button class="btn btn-sm" data-act="factoring-apply" data-id="${esc(plan.id)}" style="margin-left:6px">Push to builder</button>` : ''}</div>`).join('')}</div>` : ''}
    </div>
  </div>`;
}

function renderInspector(wf) {
  if (!ui.draft) {
    return `<div class="side-card"><div class="side-card-body">
      <h3 style="font-size:12px;margin-bottom:8px">Step inspector</h3>
      <p class="muted small">Select a step to edit its coordinates, text, timing and assertions. Use the dashed “insert here” buttons in the list to add a step at an exact position.</p>
    </div></div>`;
  }
  const draft = ui.draft;
  const fields = FIELDS[draft.type] || [];
  const fieldHtml = fields
    .map((f) => {
      const raw = draft.params[f.key];
      const value = raw == null ? '' : raw;
      if (f.type === 'textarea') {
        return `<label class="field"><span>${esc(f.label)}</span><textarea rows="${f.rows || 3}" data-scope="draft" data-key="${f.key}" placeholder="${esc(
          f.placeholder || ''
        )}">${esc(value)}</textarea>${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</label>`;
      }
      if (f.type === 'select') {
        return `<label class="field"><span>${esc(f.label)}</span><select data-scope="draft" data-key="${f.key}">${(f.options || [])
          .map((o) => `<option value="${esc(o)}" ${String(value) === String(o) ? 'selected' : ''}>${esc(o)}</option>`)
          .join('')}</select></label>`;
      }
      if (f.type === 'tool') {
        return `<label class="field"><span>${esc(f.label)}</span><select data-scope="draft" data-key="${f.key}">${ui.data.tools
          .map((t) => `<option value="${t.id}" ${value === t.id ? 'selected' : ''}>${esc(t.name)}${t.status !== 'approved' ? ' (unapproved)' : ''}</option>`)
          .join('')}</select></label>`;
      }
      return `<label class="field"><span>${esc(f.label)}</span><input type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(
        value
      )}" data-scope="draft" data-key="${f.key}" placeholder="${esc(f.placeholder || '')}" />${
        f.help ? `<span class="help">${esc(f.help)}</span>` : ''
      }</label>`;
    })
    .join('');

  return `
  <div class="side-card">
    <div class="side-card-head">
      <h3>Step inspector</h3>
      <span class="badge">${esc(draft.type)}</span>
    </div>
    <div class="side-card-body">
      <label class="field"><span>Step name</span><input type="text" value="${esc(draft.name)}" data-scope="draft" data-key="name" /></label>
      <label class="field"><span>Step type</span><select data-scope="drafttype">${ui.data.stepTypes
        .map((t) => `<option value="${t.type}" ${draft.type === t.type ? 'selected' : ''}>${esc(t.label)}</option>`)
        .join('')}</select></label>
      <label class="field"><span>Run condition</span><select data-scope="draft" data-key="condition">
        <option value="" ${!draft.condition ? 'selected' : ''}>Always run</option>
        <option value="newChat" ${draft.condition === 'newChat' ? 'selected' : ''}>Only when a new chat/session is requested</option>
      </select><span class="help">A conditional step is skipped when the mission goal asks to reuse the current session, or when the current chat already shows the same question.</span></label>
      ${fieldHtml || '<p class="muted small">This step takes no parameters.</p>'}
      <div class="field-row">
        <label class="field"><span>Timeout (ms)</span><input type="number" value="${esc(draft.timeoutMs || 15000)}" data-scope="draft" data-key="timeoutMs" /></label>
        <label class="field" style="justify-content:flex-end"><span>Behavior</span><label class="check"><input type="checkbox" data-scope="draft" data-key="optional" ${
          draft.optional ? 'checked' : ''
        } /> Optional — failure won't stop the run</label></label>
      </div>
      <div class="row" style="margin-top:4px">
        <button class="btn btn-primary" data-act="save-step" data-id="${esc(draft.id)}">Save step</button>
        <button class="btn btn-ghost" data-act="clear-step">Cancel</button>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" data-act="delete-step" data-id="${esc(draft.id)}">Delete</button>
      </div>
      <div class="hint-box section-gap">${esc(stepSummary(draft) || 'No parameters set.')}</div>
    </div>
  </div>`;
}

function renderRules(wf) {
  if (!ui.policy || ui.policyFor !== wf.id) {
    ui.policy = { ...wf.failurePolicy };
    ui.policyFor = wf.id;
  }
  const p = ui.policy;
  return `
  <div class="side-card">
    <div class="side-card-head"><h3>Failure handling</h3><span class="badge">applies per run</span></div>
    <div class="side-card-body">
      <div class="field">
        <span>On step failure</span>
        <div class="seg" style="width:100%">
          ${[
            ['stop', 'Stop'],
            ['retry', 'Retry'],
            ['continue', 'Continue'],
          ]
            .map(
              ([key, label]) =>
                `<button class="${p.onFailure === key ? 'active' : ''}" data-act="policy-set" data-key="onFailure" data-value="${key}" title="${
                  key === 'stop'
                    ? 'End the run as Failed, skipping remaining steps'
                    : key === 'retry'
                    ? 'Retry the step, then fail if attempts run out'
                    : 'Keep running remaining steps; finish as Needs review'
                }">${label}</button>`
            )
            .join('')}
        </div>
      </div>
      <div class="field-row">
        <label class="field"><span>Max retries</span><input type="number" min="0" max="5" value="${p.maxRetries}" data-scope="policy" data-key="maxRetries" ${
    p.onFailure === 'retry' ? '' : 'disabled'
  } /></label>
        <label class="field"><span>Pause before retry (ms)</span><input type="number" min="0" value="${p.pauseBeforeRetryMs}" data-scope="policy" data-key="pauseBeforeRetryMs" /></label>
      </div>
      <label class="check" style="margin-bottom:7px"><input type="checkbox" data-scope="policy" data-key="captureScreenshot" ${
        p.captureScreenshot ? 'checked' : ''
      } /> Capture a screenshot when a step fails</label>
      <label class="check" style="margin-bottom:11px"><input type="checkbox" data-scope="policy" data-key="notifyAgent" ${
        p.notifyAgent ? 'checked' : ''
      } /> Let the failure watchdog triage this run</label>
      <button class="btn btn-primary" data-act="save-policy" data-id="${wf.id}">Save rules</button>
      <div class="divider" style="margin:13px 0"></div>
      <h4 style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px">Run statuses</h4>
      <ul class="rule-list">
        <li><b>Queued</b> — waiting in the background run queue.</li>
        <li><b>Running</b> — a step is executing now.</li>
        <li><b>Passed</b> — every step succeeded.</li>
        <li><b>Failed</b> — a required step failed and the policy stopped the run.</li>
        <li><b>Needs review</b> — steps failed under “continue”, or only optional steps failed.</li>
        <li><b>Cancelled</b> — stopped by you; the in-flight step finishes first.</li>
      </ul>
      <div class="hint-box section-gap">Workflow status: <b>Draft</b> is editable and manual-only, <b>Ready</b> can be queued by background agents.</div>
    </div>
  </div>`;
}

function renderCopilot(wf, suggestions) {
  const plan = ui.planPreview;
  const research = ui.planResearch;
  const proposals = [...(ui.data.proposals || [])]
    .sort((a, b) => Number(b.id === ui.reviewProposalTarget) - Number(a.id === ui.reviewProposalTarget) || Number(a.status !== 'pending') - Number(b.status !== 'pending'))
    .slice(0, 4);
  return `
  <div class="side-card">
    <div class="side-card-head"><h3>AI copilot</h3><span class="badge ai">${esc(ui.data.settings.model)}</span></div>
    <div class="side-card-body">
      <label class="field"><span>Describe the goal</span><textarea rows="3" data-scope="plan" placeholder="Open Kiro, ask a question, select and copy the answer, then save it in Notepad">${esc(
        ui.planGoal
      )}</textarea></label>
      <button class="btn btn-primary" data-act="plan-generate" data-id="${wf.id}" ${ui.planBusy ? 'disabled' : ''}>
        ${ui.planBusy ? '<span class="spinner"></span> Drafting steps…' : '✦ Draft steps with AI'}
      </button>
      <button class="btn section-gap" data-act="proposal-generate" data-id="${wf.id}" ${ui.proposalBusy ? 'disabled' : ''}>
        ${ui.proposalBusy ? '<span class="spinner"></span> Researching history…' : '🧭 Research & propose'}
      </button>
      <span class="help" style="display:block;margin-top:5px">Cross-references the conversation, failed and passed attempts, screenshots and every workflow. Nothing changes until you approve the proposal.</span>
      ${
        plan
          ? `<div class="section-gap">
              <div class="row" style="margin-bottom:6px">
                <span class="badge ${ui.planSource === 'ai' ? 'ai' : ''}">${ui.planSource === 'ai' ? 'model draft' : 'local planner'}</span>
                <span class="dim small">${plan.length} steps</span>
              </div>
              ${ui.planNote ? `<div class="hint-box" style="margin-bottom:7px">${esc(ui.planNote)}</div>` : ''}
              ${research?.summary ? `<div class="dim small" style="margin-bottom:7px">Reviewed ${research.summary.failedAttempts || 0} failed attempt(s), ${research.summary.screenshots || 0} screenshot(s), ${research.summary.conversationMessages || 0} conversation message(s) and ${research.summary.workflows || 0} workflow(s).</div>` : ''}
              <div class="plan-preview">
                ${plan
                  .map(
                    (s, i) => `<div class="plan-step">
                      <span class="n">${i + 1}</span>
                      <div style="flex:1">
                        <div class="m">${esc(s.name)}</div>
                        <div class="p">${esc(s.type)} · ${esc(stepSummary(s))}${s.condition ? ` · ${esc(s.condition === 'newChat' ? 'only on new chat' : s.condition)}` : ''}</div>
                      </div>
                      <button class="btn-icon" data-act="plan-remove" data-index="${i}" title="Remove from draft">✕</button>
                    </div>`
                  )
                  .join('')}
              </div>
              <div class="row" style="margin-top:8px">
                <button class="btn btn-primary btn-sm" data-act="plan-apply" data-id="${wf.id}" data-mode="append">Append</button>
                <button class="btn btn-sm" data-act="plan-apply" data-id="${wf.id}" data-mode="replace">Replace steps</button>
                <span class="spacer"></span>
                <button class="btn btn-ghost btn-sm" data-act="plan-discard">Discard</button>
              </div>
            </div>`
          : ''
      }
      ${renderProposalInbox(wf, proposals)}
      <div class="divider" style="margin:14px 0"></div>
      ${renderChat()}
      ${
        suggestions.length
          ? `<div class="divider" style="margin:13px 0"></div>
             <h4 style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:7px">Suggestions</h4>
             <div class="stack" style="gap:7px">
             ${suggestions
               .map(
                 (s) => `<div class="suggestion"><span>${esc(s.text)}</span><button class="x" data-act="dismiss-suggestion" data-id="${s.id}" title="Dismiss">✕</button></div>`
               )
               .join('')}
             </div>`
          : ''
      }
    </div>
  </div>`;
}

function renderProposalInbox(wf, proposals) {
  if (!proposals.length) return '';
  return `<div class="section-gap">
    <h4 style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:7px">Workflow proposals</h4>
    <div class="stack" style="gap:9px">
      ${proposals
        .map((proposal) => {
          const summary = proposal.research?.summary || {};
          const failures = (proposal.research?.failedAttempts || []).slice(0, 3);
          const shots = (proposal.research?.screenshots || []).slice(0, 3);
          const changes = proposal.changes || {};
          return `<article class="suggestion" style="display:block">
            <div class="row wrap" style="gap:6px;align-items:center">
              <strong>${esc(proposal.workflowName || wf.name)}</strong>
              ${statusPill(proposal.status)}
              <span class="badge">${esc(proposal.planSource || 'plan')}</span>
              ${proposal.confidence != null ? `<span class="badge">${Math.round(Number(proposal.confidence) * 100)}% confidence</span>` : ''}
              <span class="spacer"></span>
              <span class="dim small">${esc(fmtTime(proposal.createdAt))}</span>
            </div>
            <p class="small" style="margin:7px 0 5px">${esc(proposal.note || proposal.goal || '')}</p>
            <div class="dim small" style="margin-bottom:6px">
              ${Number(summary.failedAttempts || 0)} failed · ${Number(summary.passedAttempts || 0)} passed · ${Number(summary.screenshots || 0)} screenshot(s) · ${Number(summary.workflows || 0)} workflow(s)
              ${changes.changed ? ` · ${changes.changed} step change(s)` : ''}
              ${proposal.backups?.length ? ` · ${proposal.backups.length} backup phase(s)` : ''}
              ${proposal.rejectedSteps?.length ? ` · ${proposal.rejectedSteps.length} rejected step(s)` : ''}
            </div>
            ${proposal.rejectedSteps?.length ? `<details class="log" style="margin-bottom:6px"><summary>${proposal.rejectedSteps.length} non-probable step(s) rejected</summary><ul class="rule-list">${proposal.rejectedSteps.slice(0, 6).map((item) => `<li><b>${esc(item.name || item.type)}</b> — ${esc(item.reason)}</li>`).join('')}</ul></details>` : ''}
            ${proposal.backups?.length ? `<details class="log" style="margin-bottom:6px"><summary>${proposal.backups.length} backup phase(s)</summary><ul class="rule-list">${proposal.backups.slice(0, 6).map((item) => `<li><b>${esc(item.phase)}</b> — ${esc(item.reason)}</li>`).join('')}</ul></details>` : ''}
            ${proposal.preflight?.length ? `<details class="log" style="margin-bottom:6px"><summary>Preflight ${proposal.preflight.filter((item) => item.ok).length}/${proposal.preflight.length} checks</summary><ul class="rule-list">${proposal.preflight.map((item) => `<li>${item.ok ? '✓' : '✕'} <b>${esc(item.check)}</b> — ${esc(item.reason)}</li>`).join('')}</ul></details>` : ''}
            ${failures.length ? `<div class="hint-box" style="margin-bottom:6px"><strong>Negative evidence</strong>${failures.map((item) => `<div class="small">${esc(item.workflowName)} · ${esc(item.failureSignature || item.failed?.[0] || item.status)}</div>`).join('')}</div>` : ''}
            ${shots.length ? `<div class="row wrap" style="gap:5px;margin-bottom:7px">${shots.map((shot) => `<div style="position:relative;width:116px;height:68px;overflow:hidden;border:1px solid var(--line);border-radius:5px" title="${esc(shot.caption)} · ${esc(shot.runStatus)} ">
              <img src="/api/files/raw?path=${encodeURIComponent(shot.path)}" alt="${esc(shot.caption)}" style="width:100%;height:100%;object-fit:cover" loading="lazy" />
              ${(shot.marks || []).map((mark) => `<span title="${esc(mark.label)}" style="position:absolute;left:${Number(mark.x) || 0}%;top:${Number(mark.y) || 0}%;transform:translate(-50%,-50%);background:#e5484d;color:#fff;border-radius:50%;font-size:9px;width:14px;height:14px;line-height:14px;text-align:center;font-weight:700">${esc(mark.number)}</span>`).join('')}
            </div>`).join('')}</div>` : ''}
            ${proposal.visualTests?.length ? `<details class="log" style="margin-bottom:6px"><summary>${proposal.visualTests.length} external visual test(s)</summary>${proposal.visualTests.slice(0, 3).map((test) => `<div class="cc-note small"><b>${test.ok ? 'passed' : 'needs review'}</b> · ${esc(test.caption || test.imagePath)}<br />${esc(test.summary || '')}${test.annotations?.length ? ` · ${test.annotations.length} annotation(s)` : ''}${renderVisualAnnotations(test, shots)}</div>`).join('')}</details>` : ''}
            ${proposal.shadowTest ? `<details class="log" style="margin-bottom:6px"><summary>Shadow test ${esc(proposal.shadowTest.status)} · ${proposal.shadowTest.passed}/${proposal.shadowTest.total} steps · ${proposal.shadowTest.checksPassed ?? '?'}/${proposal.shadowTest.checksTotal ?? '?'} checks · simulated</summary><ul class="rule-list">${(proposal.shadowTest.checks || []).map((check) => `<li>${check.ok ? '✓' : '✕'} ${esc(check.label)}${check.detail ? ` — ${esc(check.detail)}` : ''}</li>`).join('')}</ul>${proposal.shadowTest.failures?.length ? `<div class="small" style="color:var(--bad)">${proposal.shadowTest.failures.map((failure) => esc(`${failure.name}: ${failure.reason}`)).join('<br />')}</div>` : ''}<div class="dim small" style="margin-top:4px">run ${esc(proposal.shadowTest.runId || '—')} · ${esc(proposal.shadowTest.runStatus || 'unknown')}${proposal.shadowTest.skipped ? ` · ${proposal.shadowTest.skipped} skipped` : ''}</div></details>` : ''}
            ${ui.data.visualTester?.configured && shots.length ? `<div class="row" style="margin-bottom:6px"><button class="btn btn-sm btn-ghost" data-act="proposal-visual-test" data-id="${esc(proposal.id)}">Test screenshot with external program</button></div>` : ''}
            <div class="row" style="margin-bottom:6px"><button class="btn btn-sm btn-ghost" data-act="proposal-shadow-test" data-id="${esc(proposal.id)}" ${ui.proposalShadowBusy === proposal.id ? 'disabled' : ''}>${ui.proposalShadowBusy === proposal.id ? 'Running shadow simulation…' : '◐ Shadow test'}</button></div>
            ${proposal.status === 'pending' ? `<div class="row wrap" style="gap:5px">
              <button class="btn btn-sm btn-primary" data-act="proposal-approve" data-id="${esc(proposal.id)}" data-mode="replace">Approve &amp; replace</button>
              <button class="btn btn-sm" data-act="proposal-approve" data-id="${esc(proposal.id)}" data-mode="append">Approve &amp; append</button>
              <button class="btn btn-sm btn-ghost" data-act="proposal-reject" data-id="${esc(proposal.id)}">Reject</button>
            </div>` : proposal.status === 'blocked' ? `<div class="memory-alert small">Blocked by ${Number(proposal.lint?.errors || 0)} lint error(s). Request a new proposal.</div>` : ''}
          </article>`;
        })
        .join('')}
    </div>
  </div>`;
}

function renderVisualAnnotations(test, shots) {
  const annotations = (test.annotations || []).filter((item) =>
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(item[key])))
  );
  if (!annotations.length) return '';
  const shot = (shots || []).find((item) => item.path === test.imagePath);
  const width = Number(test.width || shot?.width || 0);
  const height = Number(test.height || shot?.height || 0);
  if (!width || !height) return '';
  return `<div style="position:relative;display:inline-block;max-width:100%;margin-top:5px">
    <img src="/api/files/raw?path=${encodeURIComponent(test.imagePath)}" alt="${esc(test.caption || 'Visual test')}" style="display:block;max-width:100%;border:1px solid var(--line);border-radius:4px" loading="lazy" />
    ${annotations.map((item) => `<span title="${esc(item.label)}" style="position:absolute;left:${(Number(item.x) / width) * 100}%;top:${(Number(item.y) / height) * 100}%;width:${(Number(item.width) / width) * 100}%;height:${(Number(item.height) / height) * 100}%;border:2px solid ${esc(item.color || '#e5484d')};border-radius:2px;box-sizing:border-box"><em style="position:absolute;left:-2px;top:-16px;background:${esc(item.color || '#e5484d')};color:#fff;font-size:9px;line-height:14px;padding:0 3px;border-radius:2px;font-style:normal;white-space:nowrap">${esc(item.label)}</em></span>`).join('')}
  </div>`;
}

function renderChat() {
  const messages = (ui.chat || []).slice(-6);
  return `
    <h4 style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:7px">Ask the console AI</h4>
    <div class="chat-log">
      ${
        messages.length
          ? messages
              .map(
                (m) =>
                  `<div class="chat-msg ${m.role === 'user' ? 'user' : 'assistant'}"><span class="who">${
                    m.role === 'user' ? 'you' : 'sightline'
                  }</span>${esc(m.content)}</div>`
              )
              .join('')
          : '<p class="dim small">Ask how to test a dialog, which coordinates to use, or to turn a goal into steps.</p>'
      }
    </div>
    <label class="field" style="margin-top:8px"><span>Message</span><textarea rows="2" data-scope="chat" placeholder="How should I assert the Save dialog appeared?">${esc(
      ui.chatInput
    )}</textarea></label>
    <div class="row">
      <button class="btn btn-sm" data-act="chat-send">Send</button>
      <button class="btn btn-ghost btn-sm" data-act="chat-clear">Clear history</button>
      ${ui.chatBusy ? '<span class="spinner"></span>' : ''}
    </div>`;
}

function renderControlPanel() {
  const live = !ui.data.settings.dryRun;
  const c = ui.control;
  return `
  <div class="side-card">
    <div class="side-card-head"><h3>Quick control</h3>${live ? '<span class="pill live">live</span>' : '<span class="pill simulated">simulated</span>'}</div>
    <div class="side-card-body">
      <p class="muted small" style="margin-bottom:10px">Probe the desktop while you build. Actions use the current mode from the header switch.</p>
      <div class="field-row">
        <label class="field"><span>X</span><input type="number" value="${esc(c.x)}" data-scope="control" data-key="x" /></label>
        <label class="field"><span>Y</span><input type="number" value="${esc(c.y)}" data-scope="control" data-key="y" /></label>
      </div>
      <div class="row wrap" style="gap:6px">
        <button class="btn btn-sm" data-act="ctl" data-type="move">Move</button>
        <button class="btn btn-sm" data-act="ctl" data-type="click">Click</button>
        <button class="btn btn-sm" data-act="ctl" data-type="doubleClick">Double</button>
        <button class="btn btn-sm" data-act="ctl" data-type="rightClick">Right</button>
        <button class="btn btn-sm" data-act="ctl" data-type="scroll">Scroll</button>
      </div>
      <label class="field section-gap"><span>Window title</span><input type="text" value="${esc(c.title)}" data-scope="control" data-key="title" /></label>
      <button class="btn btn-sm" data-act="ctl" data-type="focusWindow">Focus window</button>
      <label class="field section-gap"><span>Text to type</span><textarea rows="2" data-scope="control" data-key="text">${esc(c.text)}</textarea></label>
      <div class="row" style="gap:6px">
        <button class="btn btn-sm" data-act="ctl" data-type="type">Type</button>
        <button class="btn btn-sm" data-act="ctl" data-type="key" data-keys="{ENTER}">Enter</button>
        <button class="btn btn-sm" data-act="ctl" data-type="key" data-keys="^s">Ctrl+S</button>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-sm" data-act="capture-now">Capture screen</button>
        <span class="dim small">${live ? 'moves your mouse' : 'no desktop input'}</span>
      </div>
      ${ui.controlOut ? `<pre class="console-out section-gap ${ui.controlErr ? 'err' : ''}">${esc(ui.controlOut)}</pre>` : ''}
    </div>
  </div>
  ${renderLiveWatch()}
  ${renderLivePreview()}`;
}

function renderPreviewOutput() {
  const state = ui.preview;
  const preview = state.detail;
  const image = state.active && preview?.running && preview.available !== false && !preview.error && preview.imagePath;
  const status = state.message || (state.active ? (image ? 'Preview is running.' : 'Waiting for a screenshot…') : 'Preview is off.');
  return `<p class="small ${state.message ? 'preview-error' : 'dim'}" role="status">${esc(status)}</p>
    <div class="preview-image">${image ? `<figure class="preview-frame"><img src="/api/files/raw?path=${encodeURIComponent(preview.imagePath)}&t=${encodeURIComponent(preview.cacheKey)}" alt="Latest read-only screenshot of the desktop" data-preview-image /><figcaption class="dim small">Captured ${esc(fmtTime(preview.capturedAt))} · refresh interval ${esc(preview.intervalMs || 2000)} ms</figcaption></figure>` : ''}</div>
    ${image ? `<button class="btn btn-sm btn-ghost" data-act="annotate-live-frame" data-path="${esc(preview.imagePath)}" title="Open the current live frame full-size and draw on it">✎ Annotate this frame</button>` : ''}`;
}

function renderLivePreview() {
  const state = ui.preview;
  const canStop = state.active || state.uncertain;
  return `<div class="side-card section-gap" id="live-preview-card">
    <div class="side-card-head"><h3>Screen preview</h3><span class="pill ${state.active && state.detail ? 'live' : 'simulated'}">${state.active ? (state.detail ? 'on' : 'unconfirmed') : state.uncertain ? 'unconfirmed' : 'off'}</span></div>
    <div class="side-card-body">
      <p class="muted small" style="margin-bottom:8px">Opt-in and read-only: refreshed 2D screenshots, not true 3D. This shows the computer running Sightline, not a remote desktop. Capture stops when you leave this view or the viewer disconnects.</p>
      <button class="btn btn-sm ${canStop ? 'btn-ghost' : 'btn-primary'}" data-act="live-preview" data-mode="${canStop ? 'stop' : 'start'}" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Please wait…' : canStop ? 'Stop preview' : 'Start preview'}</button>
      <div class="preview-output section-gap">${renderPreviewOutput()}</div>
    </div>
  </div>`;
}

function updatePreviewCard(full = false) {
  const card = document.getElementById('live-preview-card');
  if (!card) return;
  if (full) {
    const focused = card.contains(document.activeElement);
    card.outerHTML = renderLivePreview();
    if (focused) document.querySelector('#live-preview-card button:not(:disabled)')?.focus();
  } else {
    const output = card.querySelector('.preview-output');
    if (!output) return;
    const next = document.createElement('div');
    next.innerHTML = renderPreviewOutput();
    const status = output.querySelector('[role="status"]');
    const nextStatus = next.querySelector('[role="status"]');
    if (status.textContent !== nextStatus.textContent) status.textContent = nextStatus.textContent;
    status.className = nextStatus.className;
    const image = output.querySelector('.preview-image');
    const nextImage = next.querySelector('.preview-image');
    if (image.innerHTML !== nextImage.innerHTML) image.innerHTML = nextImage.innerHTML;
    const pill = card.querySelector('.side-card-head .pill');
    pill.className = `pill ${ui.preview.detail ? 'live' : 'simulated'}`;
    pill.textContent = ui.preview.detail ? 'on' : 'unconfirmed';
  }
}

function previewDetail(preview) {
  return { ...preview, cacheKey: preview.capturedAt || Date.now() };
}

function schedulePreviewPoll() {
  const state = ui.preview;
  if (!state.active) return;
  const interval = Number(state.detail?.intervalMs) || 2000;
  state.timer = setTimeout(pollPreview, Math.max(500, Math.min(interval, 5000)));
}

async function pollPreview() {
  const state = ui.preview;
  const generation = state.generation;
  if (!state.active) return;
  if (!document.getElementById('live-preview-card') || document.hidden) {
    await changeLivePreview('stop');
    return;
  }
  const res = await api('/api/live/preview', { method: 'POST', body: { action: 'heartbeat' } });
  if (!state.active || generation !== state.generation) return;
  if (!res.ok || !res.preview) {
    state.detail = null;
    state.message = `Preview status unavailable: ${res.error || 'Unexpected response'}. Capture may still be running; use Stop preview.`;
  } else {
    state.detail = previewDetail(res.preview);
    if (!res.preview.running) {
      state.active = false;
      state.message = res.preview.error || res.preview.reason || 'Preview stopped.';
      updatePreviewCard(true);
      return;
    }
    state.message = res.preview.error || (res.preview.available === false ? res.preview.reason || 'Preview is unavailable.' : '');
  }
  updatePreviewCard();
  schedulePreviewPoll();
}

async function changeLivePreview(action) {
  const state = ui.preview;
  if (state.busy) return;
  state.generation += 1;
  clearTimeout(state.timer);
  state.active = false;
  state.detail = null;
  state.busy = true;
  state.message = action === 'stop' ? 'Stopping preview…' : 'Starting preview…';
  updatePreviewCard(true);
  const res = await api('/api/live/preview', { method: 'POST', body: { action, intervalMs: 2000 } });
  state.busy = false;
  const preview = res.preview;
  if (!res.ok || !preview) {
    state.uncertain = true;
    state.message = `Could not confirm preview ${action}: ${res.error || preview?.error || preview?.reason || 'Unexpected response'}. Try Stop preview to ensure capture is stopped.`;
  } else if (action === 'stop') {
    state.uncertain = Boolean(preview.running);
    state.message = state.uncertain ? 'Preview may still be running; try Stop preview again.' : 'Preview stopped.';
  } else if (!preview.running || preview.available === false) {
    state.uncertain = Boolean(preview.running);
    state.message = preview.error || preview.reason || 'Preview could not be started on this system.';
  } else {
    state.active = true;
    state.uncertain = false;
    state.detail = previewDetail(preview);
    state.message = preview.error || '';
    schedulePreviewPoll();
  }
  updatePreviewCard(true);
}

function renderLiveWatch() {
  const live = ui.data?.live || {};
  const running = Boolean(live.running);
  const current = live.current || null;
  const event = (live.events || [])[0] || null;
  const suggestions = event?.suggestions || ui.data?.liveSuggestions || [];
  return `<div class="side-card section-gap" id="live-watch-card">
    <div class="side-card-head"><h3>Live watch</h3>${running ? '<span class="pill live">watching</span>' : '<span class="pill simulated">idle</span>'}</div>
    <div class="side-card-body">
      <p class="muted small" style="margin-bottom:8px">A read-only background watcher polls the foreground window, captures it when it changes and proposes the next sub-step. Nothing is clicked or typed.</p>
      <div class="row wrap" style="gap:6px;align-items:center">
        <button class="btn btn-sm ${running ? 'btn-ghost' : 'btn-primary'}" data-act="live-watch" data-mode="${running ? 'stop' : 'start'}">${running ? 'Stop watching' : 'Start watching'}</button>
        <span class="dim small">${running ? `every ${live.intervalMs || 500}ms · ${(live.events || []).length} change(s)` : 'not running'}</span>
      </div>
      ${current ? `<div class="section-gap small"><strong>${esc(current.process || 'window')}</strong> · ${esc(current.title || '(no title)')}<br><span class="dim">${esc(current.at || '')}${current.capture ? ` · ${esc(current.capture)}` : ''}</span></div>` : running ? '<p class="dim small section-gap">Waiting for the first foreground change…</p>' : ''}
      ${suggestions.length ? `<div class="section-gap"><span class="dim small">Next sub-steps</span><ul class="small" style="margin:4px 0 0;padding-left:16px">${suggestions.map((s) => `<li><strong>${esc(s.type)}</strong> — ${esc(s.name)}${s.why ? `<br><span class="dim">${esc(s.why)}</span>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${(live.errors || []).length ? `<pre class="console-out err section-gap">${esc(live.errors[0].message || '')}</pre>` : ''}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ runs */
function renderRuns() {
  const d = ui.data;
  const filters = [
    ['all', 'All runs'],
    ['failed', 'Failed'],
    ['needs_review', 'Needs review'],
    ['running', 'Running'],
    ['passed', 'Passed'],
    ['queued', 'Queued'],
  ];
  let runs = d.runs;
  if (ui.runFilter === 'running') runs = runs.filter((r) => r.status === 'running' || r.status === 'queued');
  else if (ui.runFilter !== 'all') runs = runs.filter((r) => r.status === ui.runFilter);
  if (!ui.selectedRun || !d.runs.some((r) => r.id === ui.selectedRun)) {
    ui.selectedRun = (runs[0] || d.runs[0] || {}).id || null;
    ui.runDetail = null;
    ui.reviewComment = '';
  }
  const detail = ui.runDetail && ui.runDetail.id === ui.selectedRun ? ui.runDetail : d.runs.find((r) => r.id === ui.selectedRun);

  const list = runs.length
    ? runs
        .map(
          (r) => `
      <button class="run-item ${r.id === ui.selectedRun ? 'active' : ''}" data-act="select-run" data-id="${r.id}">
        <span class="run-item-top">
          ${statusPill(r.status)}
          <strong>${esc(r.workflowName)}</strong>
          ${modeBadge(r.dryRun)}
          ${r.shadow ? '<span class="badge">shadow</span>' : ''}
        </span>
        <span class="run-item-meta">
          <span>${fmtTime(r.createdAt)}</span>
          <span>· ${fmtDur(r.durationMs)}</span>
          <span>· ${r.passed}/${r.total} steps</span>
          ${r.retryCount ? `<span>· ${r.retryCount} retries</span>` : ''}
          ${r.errorCategory ? `<span>· ${r.errorCategory}</span>` : ''}
          ${r.repairCount ? `<span>· ${r.repairCount} live repair(s)</span>` : ''}
          ${r.replanCount ? `<span>· ${r.replanCount} AI replan(s)</span>` : ''}
          ${r.replannedAfterFailure ? '<span class="badge ai">replanned</span>' : ''}
          ${r.recovered ? '<span class="badge okbadge">recovered</span>' : ''}
          ${r.recoveryPackId ? `<span class="badge ${r.recoveryStatus === 'retrying' ? 'ai' : ''}">recovery · ${esc(r.recoveryStatus || 'pack')}</span>` : ''}
          ${r.nudges ? `<span class="badge" title="Operator input noticed while the console waited — read as a continue signal">✋ ${r.nudges} nudge${r.nudges === 1 ? '' : 's'}</span>` : ''}
          ${r.evidenceCount ? `<span>· ${r.evidenceCount} evidence</span>` : ''}
          ${r.trigger === 'agent' ? '<span class="badge ai">agent</span>' : ''}
          ${r.trigger === 'retry' ? '<span class="badge">retry</span>' : ''}
        </span>
        ${r.errorSummary ? `<span class="run-item-error">${esc(r.errorSummary)}</span>` : ''}
      </button>`
        )
        .join('')
    : emptyState('No runs match', 'Change the filter, or run a workflow from the builder.');

  return `
  <div class="page-head">
    <div>
      <h1>Test runs</h1>
      <p>Every run executes in a background queue on this machine, so you can close the tab while it works. Failures keep their step error, log, screenshot and AI diagnosis for review.</p>
    </div>
    <div class="page-head-actions">
      <div class="chip-row">
        ${filters
          .map(
            ([key, label]) =>
              `<button class="chip ${ui.runFilter === key ? 'active' : ''}" data-act="run-filter" data-filter="${key}">${label}${
                key === 'failed' && d.counts.failures ? ` · ${d.counts.failures}` : ''
              }</button>`
          )
          .join('')}
      </div>
    </div>
  </div>
  <div class="runs-layout ${ui.runDetailOpen && detail ? 'show-detail' : ''}">
    <div class="runs-list">${list}</div>
    ${detail ? renderRunDetail(detail) : emptyState('Nothing selected', 'Pick a run to review its evidence.')}
  </div>`;
}

function renderRecoveryPack(pack) {
  if (!pack) return '';
  const selected = (pack.candidates || []).find((candidate) => candidate.id === pack.selectedCandidateId) || null;
  const statusClass = pack.status === 'passed' ? 'okbadge' : pack.status === 'failed' || pack.status === 'needs_review' ? 'warnbadge' : '';
  const stageRows = (pack.stages || [])
    .map(
      (stage) => `<div class="recovery-stage">
        <div class="row wrap"><span class="badge ${stage.status === 'failed' ? 'warnbadge' : stage.status === 'warning' ? 'warnbadge' : 'okbadge'}">${esc(stage.status)}</span><strong>${esc(stage.name)}</strong></div>
        <p class="small" style="margin:5px 0">${esc(stage.summary)}</p>
        ${(stage.supersteps || [])
          .map(
            (superstep) => `<details class="hint-box" style="margin:5px 0"><summary><strong>${esc(superstep.name)}</strong> · ${(superstep.substeps || []).length} substep(s)</summary><ul class="small" style="margin:6px 0 0 16px">${(superstep.substeps || [])
              .map((substep) => `<li><strong>${esc(substep.name || substep.type || 'step')}</strong>${substep.detail ? ` — ${esc(substep.detail)}` : ''}</li>`)
              .join('')}</ul></details>`
          )
          .join('')}
      </div>`
    )
    .join('');
  const candidateRows = (pack.candidates || [])
    .map(
      (candidate) => `<div class="hint-box" style="margin:6px 0">
        <div class="row wrap"><strong>${esc(candidate.label)}</strong><span class="badge ${candidate.test?.ok ? 'okbadge' : 'warnbadge'}">${esc(candidate.test?.status || 'untested')}</span><span class="badge">${Number(candidate.score || 0)}%</span>${candidate.id === pack.selectedCandidateId ? '<span class="badge ai">selected</span>' : ''}<span class="spacer"></span>${candidate.test?.ok ? `<button class="btn btn-sm" data-act="apply-recovery" data-id="${pack.id}" data-candidate="${candidate.id}">Use this plan</button>` : ''}</div>
        <p class="dim small" style="margin:4px 0">${esc(candidate.reason || '')}</p>
        ${(candidate.steps || []).length ? `<details><summary class="small">${candidate.steps.length} recorded step(s)</summary><ol class="small" style="margin:5px 0 0 16px">${candidate.steps.map((step) => `<li>${esc(step.name || step.type)} <span class="mono dim">${esc(step.type)}</span></li>`).join('')}</ol></details>` : ''}
      </div>`
    )
    .join('');
  const logRows = (pack.logs || []).slice(-18)
    .map((entry) => `<div class="log-row ${entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'warn' : ''}"><span class="mono dim">${fmtTime(entry.at)}</span><span class="badge">${esc(entry.level || 'info')}</span><span class="mono dim">${esc(entry.stage || '')}</span><span>${esc(entry.message)}</span></div>`)
    .join('');
  return `<div class="card" style="border-color:rgba(129,140,248,.35)">
    <div class="card-head"><div><h3 style="margin:0">Recovery pack <span class="mono dim small">${esc(pack.id)}</span></h3><p class="dim small" style="margin-top:3px">${esc(pack.goal)}</p></div><div class="row wrap">${statusPill(pack.status)}<span class="badge ${statusClass}">${pack.depth || 0} loop(s)</span>${pack.incorporated ? '<span class="badge okbadge">incorporated</span>' : ''}</div></div>
    <div class="card-body">
      <div class="chip-row" style="margin-bottom:9px"><span class="badge">${(pack.agents || []).length} agent(s)</span><span class="badge">${(pack.candidates || []).length} candidate(s)</span><span class="badge">${(pack.logs || []).length} log line(s)</span>${pack.retryRunId ? `<span class="badge ai">retry ${esc(pack.retryRunId)}</span>` : ''}</div>
      ${stageRows}
      ${candidateRows ? `<div style="margin-top:10px"><h4 style="margin-bottom:3px">Tested candidates</h4>${candidateRows}</div>` : ''}
      ${selected && !pack.incorporated ? `<button class="btn btn-sm btn-primary" data-act="apply-recovery" data-id="${pack.id}" data-candidate="${selected.id}">Incorporate selected plan</button>` : ''}
      ${selected ? `<button class="btn btn-sm btn-ghost" data-act="retry-recovery" data-id="${pack.id}" data-candidate="${selected.id}">Aggressive test this plan</button>` : ''}
      ${logRows ? `<details style="margin-top:10px"><summary class="small"><strong>Recovery log</strong> · leveled trace</summary><div style="margin-top:6px">${logRows}</div></details>` : ''}
    </div>
  </div>`;
}

function renderRunDetail(run) {
  const full = run.steps ? run : null;
  if (!full) {
    return `<div class="run-detail"><div class="card"><div class="card-body"><p class="muted small">Loading run detail…</p></div></div></div>`;
  }
  const failedSteps = full.steps.filter((s) => s.status === 'failed');
  const evidence = full.evidence || [];
  const shots = evidence.filter((e) => e.kind === 'screenshot');
  const workflow = ui.data.workflows.find((w) => w.id === full.workflowId);
  const canCancel = full.status === 'running' || full.status === 'queued';
  const runPaused = Boolean(full.pauseRequested || full.paused);
  const analyzed = full.analysis;
  const retryBusy = ui.runBusy === `retry:${full.id}`;
  const analyzeBusy = ui.runBusy === `analyze:${full.id}`;

  const evidenceHtml = shots.length
                  ? `<div class="evidence-grid">${shots
        .map(
          (e) => `<button class="evidence-card" data-act="open-capture" data-id="${esc(e.id)}" data-sim="${e.simulated ? '1' : '0'}" data-path="${esc(e.path)}" data-caption="${esc(
            e.caption || ''
          )}">
            <span class="evidence-wrap">
              <img src="/api/files/raw?path=${encodeURIComponent(e.path)}" alt="${esc(e.caption || 'Screenshot')}" loading="lazy" />
              ${e.simulated ? '<span class="evidence-tag">SIMULATED</span>' : ''}
            </span>
            <span class="cap">${esc(e.caption || 'Screenshot')}<span>${fmtTime(e.createdAt)}${e.width ? ` · ${e.width}×${e.height}` : ''}</span></span>
          </button>`
        )
        .join('')}</div>`
    : `<p class="muted small">No screenshots for this run. ${
        failedSteps.length ? 'Enable “Capture a screenshot when a step fails” in failure rules, or capture evidence now.' : ''
      }</p>`;

  const logs = evidence.filter((e) => e.kind === 'log' && e.path);
  const logsHtml = logs.length
    ? `<div class="stack" style="gap:4px;margin-top:8px">${logs
        .map((e) => `<div class="small mono">${esc(e.caption || 'Setup output')} · ${esc(e.path)}</div>`)
        .join('')}</div>`
    : '';

  return `
  <div class="run-detail">
    <button class="btn btn-sm btn-ghost runs-back" data-act="runs-back">← All test runs</button>
    <div class="card run-hero">
      <div class="run-hero-top">
        <div>
          <div class="row wrap">${statusPill(full.status)}${runPaused ? '<span class="badge warnbadge">paused</span>' : ''}${modeBadge(full.dryRun)}${full.shadow ? '<span class="badge">shadow</span>' : ''}<span class="badge">${esc(full.trigger)}</span>${
    full.review?.status === 'reviewed' ? '<span class="badge okbadge">reviewed</span>' : ''
  }</div>
          <h2>${esc(full.workflowName)}</h2>
          <div class="run-meta">
            <span>id <b>${esc(full.id)}</b></span>
            <span>started <b>${fmtTime(full.startedAt || full.createdAt)}</b></span>
            <span>duration <b>${fmtDur(full.durationMs)}</b></span>
            <span>steps <b>${full.steps.filter((s) => s.status === 'passed').length}/${full.steps.length}</b></span>
            <span>policy <b>${esc(full.policy?.onFailure || 'stop')}</b></span>
            <span>retries <b>${full.retryCount || 0}</b></span>
            <span>repairs <b>${full.repairCount || 0}</b></span>
            <span>AI replans <b>${full.replanCount || 0}</b></span>
            <span>complexity <b>${full.runComplexityScore ?? '—'}</b></span>
            ${full.errorCategory ? `<span>error <b>${esc(full.errorCategory)}</b></span>` : ''}
            ${full.lastErrorCode ? `<span>code <b>${esc(full.lastErrorCode)}</b></span>` : ''}
            ${full.requiresAdvancedPlanning ? '<span class="badge ai">advanced planning</span>' : ''}
            ${full.recovered ? '<span class="badge okbadge">recovered</span>' : ''}
          </div>
          ${(full.patternTags || []).length ? `<div class="chip-row" style="margin-top:7px">${full.patternTags.map((tag) => `<span class="badge">${esc(tag)}</span>`).join('')}</div>` : ''}
          ${full.failureSignature ? `<p class="dim small mono" style="margin-top:5px">signature: ${esc(full.failureSignature)}</p>` : ''}
          ${full.errorSummary ? `<div class="hint-box" style="margin-top:8px;border-color:rgba(251,113,133,.35)"><strong>${failedSteps.length} step${failedSteps.length === 1 ? '' : 's'} failed</strong><div class="small" style="margin-top:4px">${esc(full.errorSummary)}</div>${full.continuedAfterFailure ? '<div class="small dim" style="margin-top:4px">The run continued with the remaining independent steps after the failure.</div>' : ''}</div>` : ''}
          ${full.recheck && full.recheck.status !== 'checking' ? `<div class="hint-box" style="margin-top:8px;border-color:${full.recheck.status === 'resolved' ? 'rgba(74,222,128,.3)' : 'rgba(56,189,248,.35)'}"><strong>Pending recheck · ${esc(String(full.recheck.status || '').replace(/_/g, ' '))}</strong><div class="small" style="margin-top:4px">${Number(full.recheck.resolved || 0)} step(s) passed · ${Number(full.recheck.unresolved || 0)} still open · ${Number(full.recheck.needsRun || 0)} to re-run${full.recheck.continued ? ` · continuing as ${esc(full.recheck.retryRunId || 'a new run')}` : ''}</div>${(full.recheck.notes || []).slice(-3).map((note) => `<div class="small dim" style="margin-top:2px">${esc(note)}</div>`).join('')}</div>` : ''}
          ${(full.carriedSteps || []).length ? `<div class="hint-box" style="margin-top:8px;border-color:rgba(74,222,128,.25)"><strong>Passed through ${full.carriedSteps.length} completed step(s)</strong><div class="small dim" style="margin-top:3px">${full.carriedSteps.slice(0, 6).map((step) => esc(step.name || step.type || 'step')).join(' · ')}</div></div>` : ''}
          ${(full.recheckTasks || []).filter((task) => task.status === 'open').length ? `<div class="hint-box" style="margin-top:8px;border-color:rgba(251,191,36,.35)"><strong>Tasks assigned by the recheck</strong>${(full.recheckTasks || []).filter((task) => task.status === 'open').slice(-4).map((task) => `<div class="small" style="margin-top:3px"><b>${esc(task.name || task.type || 'step')}</b> · ${esc(task.reason || '')} <span class="dim">(${esc(task.assignedTo || 'operator')})</span></div>`).join('')}</div>` : ''}
          ${full.followup ? `<div class="hint-box" style="margin-top:8px;border-color:${full.followup.ok ? 'rgba(74,222,128,.3)' : 'rgba(251,191,36,.35)'}"><strong>Follow-up check · ${full.followup.ok ? 'passed' : 'needs review'}</strong><div class="small" style="margin-top:4px">${esc(full.followup.summary)}</div>${(full.followup.verificationFailed || []).length ? `<div class="small" style="color:var(--bad);margin-top:3px">Failed checks: ${esc((full.followup.verificationFailed || []).join(', '))}</div>` : ''}</div>` : ''}
          ${(() => { const co = full.closeout; if (!co || !co.action) return ''; const stepsText = (co.followUpSteps || []).map((step) => `${step.type}: ${esc(step.name || '')}`).join(' · '); const button = co.appended ? '<div class="small" style="color:var(--ok);margin-top:4px">Steps already appended to the workflow.</div>' : (co.followUpSteps || []).length ? `<button class="btn btn-sm" data-act="closeout-append" data-id="${esc(run.id)}" style="margin-top:6px">Append to workflow</button>` : ''; return `<div class="hint-box" style="margin-top:8px;border-color:rgba(56,189,248,.35)"><strong>Predicted follow-up · ${esc(co.action)}</strong><div class="small" style="margin-top:4px">${esc((co.reasons || []).join('; '))}</div>${stepsText ? `<div class="small dim" style="margin-top:4px">Proposed: ${stepsText}</div>` : ''}${button}</div>`; })()}
          ${(full.agentReplans || []).length ? `<div class="hint-box" style="margin-top:8px;border-color:rgba(129,140,248,.35)"><strong>AI repair agent</strong>${full.agentReplans.map((replan) => `<div class="small" style="margin-top:6px"><b>${esc(replan.step)}</b> · ${esc(replan.method)}${replan.confidence != null ? ` · ${Math.round(Number(replan.confidence) * 100)}% confidence` : ''}${replan.diagnosis ? `<div class="dim" style="margin-top:2px">${esc(replan.diagnosis)}</div>` : ''}<div class="dim" style="margin-top:2px">${replan.replacesStep ? 'replaced the failed step' : 'ran prerequisites, then retried'}${(replan.steps || []).length ? ` · ${esc((replan.steps || []).join(' → '))}` : ''}${(replan.remaining || []).length ? ` · rewrote ${replan.remaining.length} remaining step(s)` : ''}</div></div>`).join('')}</div>` : ''}
          ${full.replannedAfterFailure ? `<div class="hint-box" style="margin-top:8px"><strong>AI replanned the remainder</strong><div class="small" style="margin-top:4px">${esc((full.supersededSteps || []).length)} failed action step(s) were superseded; later steps were rebuilt from the current screen.</div></div>` : ''}
        </div>
          ${full.presence?.holding ? `<div class="hint-box" style="margin-top:8px;border-color:rgba(251,191,36,.4)"><strong>Waiting for your desktop to go quiet</strong><div class="small" style="margin-top:3px">${esc(full.presence.reason || 'the presence guard is holding this step')} · held ${Math.round((Number(full.presence.deferredMs) || 0) / 1000)}s so far — live steps start the moment you stop moving the mouse, or press <b>Run now anyway</b>.</div></div>` : ''}
          ${full.presence?.fastPath && !full.presence?.holding ? `<div class="hint-box" style="margin-top:8px;border-color:rgba(56,189,248,.35)"><strong>Continued while you were active</strong><div class="small" style="margin-top:3px">${esc(full.presence.reason || 'the step did not need to interrupt you')}${Number(full.presence.rechecked?.pending) > 0 ? ` · re-checked ${Number(full.presence.rechecked.pending)} pending verification check(s) before continuing` : ''}.</div></div>` : ''}
          ${full.liveOffer ? `<div class="hint-box" style="margin-top:8px;border-color:rgba(56,189,248,.35)"><strong>This machine can run it live</strong><div class="small" style="margin-top:4px">The run was downgraded to simulated (“${esc(full.liveOffer.reason || 'no live backend')}”) but a probe answered (${esc(full.liveOffer.detail || 'ok')}). It stayed simulated — switching to real desktop input needs your consent. <button class="btn btn-sm" data-act="run-live-offer" data-id="${esc(full.id)}" style="margin-left:6px">Start it live</button></div></div>` : ''}
          ${renderDeepFocusCard(full)}
        <div class="row wrap">
          <button class="btn btn-sm" data-act="retry-run" data-id="${full.id}" ${retryBusy ? 'disabled' : ''}>${retryBusy ? 'Re-planning…' : '↻ Re-plan & retry'}</button>
          ${['failed', 'needs_review', 'passed', 'cancelled'].includes(full.status) ? `<button class="btn btn-sm btn-ghost" data-act="recheck-run" data-id="${full.id}" ${full.recheck?.status === 'checking' ? 'disabled' : ''}>${full.recheck?.status === 'checking' ? 'Rechecking…' : '⟳ Recheck & keep progress'}</button>` : ''}
          ${['failed', 'needs_review', 'cancelled'].includes(full.status) ? `<button class="btn btn-sm btn-ghost" data-act="propose-run" data-id="${full.id}">🧭 Research repair proposal</button>` : ''}
          ${canCancel ? `<button class="btn btn-sm" data-act="run-control" data-id="${full.id}" data-cmd="pause" ${runPaused ? 'disabled' : ''}>Pause</button>` : ''}
          ${canCancel && runPaused ? `<button class="btn btn-sm btn-primary" data-act="run-control" data-id="${full.id}" data-cmd="resume">Resume</button>` : ''}
          ${canCancel ? `<button class="btn btn-sm" data-act="run-control" data-id="${full.id}" data-cmd="skip">Skip step</button>` : ''}
          ${canCancel && full.presence?.holding ? `<button class="btn btn-sm btn-primary" data-act="run-control" data-id="${full.id}" data-cmd="bypass" title="Skip the presence wait and take focus right away">Run now anyway</button>` : ''}
          ${canCancel ? `<button class="btn btn-sm btn-ghost" data-act="run-control" data-id="${full.id}" data-cmd="continue">Continue</button>` : ''}
          ${canCancel ? `<button class="btn btn-sm btn-danger" data-act="cancel-run" data-id="${full.id}">Cancel</button>` : ''}
          <button class="btn btn-sm" data-act="capture-run" data-id="${full.id}">Capture now</button>
        </div>
      </div>
      <div class="run-actions">
        <button class="btn btn-sm" data-act="analyze-run" data-id="${full.id}" ${analyzeBusy ? 'disabled' : ''}>${analyzeBusy ? 'Analyzing…' : '✦ Analyze with AI'}</button>
        ${full.status === 'failed' || full.status === 'needs_review' ? `<button class="btn btn-sm" data-act="forward-run" data-id="${full.id}">⇢ Forward to Control Center</button>` : ''}
        ${analyzed?.suggestedSteps?.length ? `<button class="btn btn-sm" data-act="apply-suggestions" data-id="${full.id}">Apply ${analyzed.suggestedSteps.length} suggested step(s)</button>` : ''}
        ${workflow ? `<button class="btn btn-sm btn-ghost" data-act="select-workflow" data-id="${workflow.id}">Open in builder</button>` : ''}
        <span class="spacer"></span>
        <button class="btn btn-sm ${full.review?.status === 'reviewed' ? 'btn-ghost' : ''}" data-act="review-run" data-id="${full.id}" data-status="${
    full.review?.status === 'reviewed' ? 'unreviewed' : 'reviewed'
  }">${full.review?.status === 'reviewed' ? 'Reopen review' : '✓ Mark reviewed'}</button>
      </div>
    </div>
    <div class="card"><div class="card-head"><h3>Screenshot check review</h3><button class="btn btn-sm" data-act="run-simulate" data-id="${esc(full.id)}" ${ui.simBusy ? 'disabled' : ''}>Screenshot check</button></div><div class="card-body">${renderSimulationCard(ui.sim?.runId === full.id ? ui.sim.record : null) || '<p class="muted small">No screenshot check loaded for this run.</p>'}</div></div>
    <div class="card"><div class="card-head"><h3>Test review</h3><div class="row" style="gap:6px;align-items:flex-end"><label class="field" style="margin:0;min-width:130px"><span>Sort</span><select data-scope="review-sort" data-id="${esc(full.id)}" ${ui.reviewBusy ? 'disabled' : ''}>${['risk', 'phase', 'status', 'seq', 'name'].map((mode) => `<option value="${mode}" ${ui.reviewSort === mode ? 'selected' : ''}>${mode}</option>`).join('')}</select></label><button class="btn btn-sm" data-act="run-review" data-id="${esc(full.id)}" ${ui.reviewBusy ? 'disabled' : ''}>${ui.reviewBusy ? 'Reviewing…' : 'Build review'}</button></div></div><div class="card-body">${renderTestReviewCard(ui.review?.runId === full.id ? ui.review.record : null)}</div></div>

    ${
      failedSteps.length
        ? `<div class="card" style="border-color:rgba(251,113,133,.28)">
            <div class="card-head"><h3 style="color:#fda4b0">Failure evidence</h3><span class="badge warnbadge">${failedSteps.length} failed step${
            failedSteps.length === 1 ? '' : 's'
          }</span></div>
            <div class="card-body">
              ${failedSteps
                .map(
                  (s) => `<div style="margin-bottom:10px">
                    <div class="row"><span class="type-chip">${esc(s.type)}</span><strong style="font-size:12.5px">${esc(s.name)}</strong><span class="dim small">after ${
                    s.attempts
                  } attempt${s.attempts === 1 ? '' : 's'}</span></div>
                    <pre class="console-out section-gap err">${esc(s.error || 'No error message')}</pre>
                    ${(s.repairs || []).length ? `<div class="small dim" style="margin-top:4px">Live repair attempts: ${s.repairs.map((repair) => `${esc(repair.method)} — ${repair.ok ? 'succeeded' : `failed${repair.error ? `: ${esc(repair.error)}` : ''}`}`).join(' · ')}</div>` : ''}
                  </div>`
                )
                .join('')}
              ${evidenceHtml}
              ${logsHtml}
            </div>
          </div>`
        : ''
    }

    ${renderRecoveryPack(full.recoveryPack)}

    ${
      (full.verificationReview || []).length || full.stepStalled
        ? `<div class="card">
      <div class="card-head">
        <h3>Verification review</h3>
        <span class="dim small">${full.verificationStalled ? 'stalled — needs a decision' : `attempt ${Number(full.verificationAttempts) || 0}`} · read-only, the desktop is never touched</span>
      </div>
      <div class="card-body">
        ${full.stepStalled ? `<div class="hint-box small" style="border-color:rgba(251,191,36,.4)"><strong>Blocked step</strong><div class="small" style="margin-top:4px">${esc(full.stepStalled.suggestion || full.stepStalled.stepName || '')}</div></div>` : ''}
        <ul class="rule-list">
          ${(full.verificationReview || [])
            .slice(-8)
            .map(
              (entry) =>
                `<li><b>${esc(entry.kind || 'review')}</b>${entry.attempt ? ` · attempt ${Number(entry.attempt)}` : ''} · ${esc(fmtTime(entry.at))}${entry.drift === true ? ' · screen changed' : entry.drift === false ? ' · screen unchanged' : ''}${entry.remaining != null ? ` · ${Number(entry.remaining)} open` : ''}${entry.detail ? `<div class="small dim">${esc(entry.detail)}</div>` : ''}${(entry.suggestions || []).length ? `<div class="small">${entry.suggestions.map((line) => esc(line)).join('<br />')}</div>` : ''}</li>`
            )
            .join('')}
        </ul>
      </div>
    </div>`
        : ''
    }

    <div class="card">
      <div class="card-head">
        <h3>Step timeline</h3>
        <span class="dim small">policy: ${esc(full.policy?.onFailure || 'stop')} · ${full.dryRun ? 'no desktop input' : 'real desktop input'}</span>
      </div>
      <div class="card-body">
        <ul class="timeline">
          ${full.steps
            .map((s, i) => {
              const shown = stepDisplayStatus(full, s);
              const glyph = shown === 'passed' ? '✓' : shown === 'failed' ? '✕' : shown === 'verifying' ? '◔' : shown === 'running' ? '◌' : shown === 'skipped' ? '–' : '·';
              const stepEvidence = (full.evidence || []).filter((e) => e.stepId === s.id);
              return `<li class="tl-item ${esc(s.status)}">
                <span class="tl-marker">${glyph}</span>
                <div class="tl-body">
                  <div class="tl-top">
                    <span class="tl-name">${i + 1}. ${esc(s.name)}</span>
                    <span class="type-chip">${esc(s.type)}</span>
                    ${statusPill(shown, shown === 'verifying' ? 'checking' : undefined)}
                    ${s.optional ? '<span class="badge">optional</span>' : ''}
                    <span class="tl-meta">${s.attempts > 1 ? `${s.attempts} attempts · ` : ''}${fmtDur(s.ms)}</span>
                  </div>
                  ${s.error ? `<div class="tl-error">${esc(s.error)}</div>` : ''}
                  ${s.output ? `<div class="tl-output">${esc(String(s.output).slice(0, 800))}</div>` : ''}
                  ${renderStepThink(s)}
                  ${
                    stepEvidence.length
                      ? `<div class="row wrap" style="margin-top:7px">${stepEvidence
                          .map(
                            (e) =>
                              `<button class="btn btn-sm" data-act="open-capture" data-id="${esc(e.id)}" data-sim="${e.simulated ? '1' : '0'}" data-path="${esc(e.path)}" data-caption="${esc(e.caption || '')}">▣ ${esc(
                                e.caption || 'evidence'
                              )}</button>`
                          )
                          .join('')}</div>`
                      : ''
                  }
                </div>
              </li>`;
            })
            .join('')}
        </ul>
      </div>
    </div>

    ${
      analyzed
        ? `<div class="card analysis">
            <h3>✦ Diagnosis <span class="badge ai">${esc(analyzed.source || 'ai')}</span></h3>
            ${analyzed.summary ? `<p class="summary">${esc(analyzed.summary)}</p>` : ''}
            ${analyzed.rootCause ? `<p class="cause"><strong>Root cause:</strong> ${esc(analyzed.rootCause)}</p>` : ''}
            ${
              analyzed.nextActions?.length
                ? `<ul>${analyzed.nextActions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`
                : ''
            }
            ${
              analyzed.suggestedSteps?.length
                ? `<div class="row wrap" style="margin-top:10px">${analyzed.suggestedSteps
                    .map((s) => `<span class="badge">+ ${esc(s.name)}</span>`)
                    .join('')}<button class="btn btn-sm btn-primary" data-act="apply-suggestions" data-id="${full.id}">Apply steps</button></div>`
                : ''
            }
          </div>`
        : ''
    }

    <div class="card">
      <div class="card-head"><h3>Reviewer notes</h3>${full.review?.at ? `<span class="dim small">updated ${fmtTime(full.review.at)}</span>` : ''}</div>
      <div class="card-body">
        <label class="field"><span>Comment saved into the run note</span><textarea rows="3" data-scope="review" placeholder="Reproduced on a second monitor; the dialog appears after 2s.">${esc(
          full.review?.comment || ui.reviewComment
        )}</textarea></label>
        <div class="row">
          <button class="btn btn-sm btn-primary" data-act="save-review" data-id="${full.id}">Save review note</button>
          <span class="dim small">${full.review?.status === 'reviewed' ? 'Marked reviewed' : 'Awaiting review'}</span>
        </div>
      </div>
    </div>

    <details class="log">
      <summary>Run log · ${full.log.length} entries</summary>
      <div class="log-body">
        ${full.log
          .map(
            (l) => `<div class="log-line ${esc(l.level)}"><span class="t">${fmtTime(l.at)}</span><span class="m">${esc(l.message)}</span></div>`
          )
          .join('')}
      </div>
    </details>
  </div>`;
}

/* ------------------------------------------------------------------ captures */
function renderMemory() {
  const mem = ui.workflowMemory;
  if (!mem) {
    if (!ui.memoryLoading) loadWorkflowMemory().then(render);
    return '<div class="empty"><strong>Loading workflow memory…</strong>Recalling validated runs and their screenshot audits.</div>';
  }
  const workflows = ui.data.workflows || [];
  if (ui.memoryWorkflow && !workflows.some((wf) => wf.id === ui.memoryWorkflow)) ui.memoryWorkflow = '';
  const all = mem.episodes || [];
  const filtered = all.filter((episode) =>
    ui.memoryFilter === 'all' ||
    (ui.memoryFilter === 'live' ? episode.mode === 'live' : false) ||
    (ui.memoryFilter === 'simulated' ? episode.mode === 'simulated' : false) ||
    episode.status === ui.memoryFilter
  );
  const count = (predicate) => all.filter(predicate).length;
  const filters = [
    ['all', 'All', mem.count > all.length ? `${all.length}/${mem.count}` : all.length],
    ['passed', 'Passed', count((e) => e.status === 'passed')],
    ['failed', 'Failed', count((e) => e.status === 'failed')],
    ['live', 'Live', count((e) => e.mode === 'live')],
    ['simulated', 'Simulated', count((e) => e.mode === 'simulated')],
  ];
  const workflowOptions = workflows
    .map((wf) => `<option value="${esc(wf.id)}" ${ui.memoryWorkflow === wf.id ? 'selected' : ''}>${esc(wf.name)}</option>`)
    .join('');
  const cards = filtered
    .map((episode, index) => {
      const visualWarnings = (episode.visual || []).filter((item) => item.noVisibleChange);
      const steps = (episode.steps || [])
        .map((step, index) => `<li><span class="mono">${index + 1}. ${esc(step.type)}</span> ${esc(step.name)}${step.detail ? ` <span class="dim">“${esc(step.detail)}”</span>` : ''}${step.condition ? ` <span class="badge">${esc(step.condition)}</span>` : ''} <span class="dim">${esc(step.status || '')}</span></li>`)
        .join('');
      return `<article class="card memory-card">
        <div class="card-head">
          <div><h3>${esc(episode.workflowName || 'Workflow')}</h3><p class="dim small" style="margin-top:3px">${esc(fmtTime(episode.createdAt))} · ${esc(episode.runId || '')}</p></div>
          <div class="row wrap" style="gap:5px">${statusPill(episode.status)}${modeBadge(episode.mode !== 'live')}<span class="badge">${Math.round(Number(episode.quality || 0) * 100)}% quality</span></div>
        </div>
        <div class="card-body stack" style="gap:9px">
          <p class="goal-quote">${esc(episode.goal || 'No goal recorded')}</p>
          <div class="row wrap memory-meta">
            <span class="small">${Number(episode.passed || 0)}/${Number(episode.total || 0)} steps passed</span>
            <span class="small">${(episode.apps || []).map((app) => esc(app)).join(' · ') || 'app not recorded'}</span>
            ${visualWarnings.length ? `<span class="badge warnbadge">${visualWarnings.length} no-change audit${visualWarnings.length === 1 ? '' : 's'}</span>` : '<span class="badge okbadge">no visual warning</span>'}
          </div>
          ${episode.hindrances?.length ? `<div class="memory-alert"><strong>Hindrances</strong><ul class="rule-list">${episode.hindrances.slice(0, 6).map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}
          ${visualWarnings.length ? `<div class="memory-alert"><strong>Screen audits</strong><ul class="rule-list">${visualWarnings.slice(0, 5).map((item) => `<li>${esc(item.step)}: ${Number(item.changedPct || 0)}% changed</li>`).join('')}</ul></div>` : ''}
          <details class="log" ${episode.status === 'failed' && index === 0 ? 'open' : ''}>
            <summary>${episode.steps?.length || 0} remembered steps</summary>
            <ol class="memory-step-list">${steps}</ol>
          </details>
          <div class="row wrap" style="gap:6px">
            <button class="btn btn-sm btn-ghost" data-act="open-memory-run" data-id="${esc(episode.runId || '')}">Open source run</button>
            ${episode.workflowId && workflows.some((wf) => wf.id === episode.workflowId) ? `<button class="btn btn-sm btn-ghost" data-act="select-workflow" data-id="${esc(episode.workflowId)}">Open workflow</button>` : '<span class="dim small">source workflow deleted</span>'}
          </div>
        </div>
      </article>`;
    })
    .join('');
  return `
  <div class="page-head">
    <div>
      <h1>Workflow memory</h1>
      <p>Every finished run becomes a reusable episode. Plans recall these validated sequences, their typed text, screen-change audits and known hindrances before creating new steps.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn btn-ghost" data-act="memory-refresh">Refresh</button>
      <button class="btn btn-primary" data-act="memory-new-workflow">＋ New workflow</button>
    </div>
  </div>
  <div class="row wrap" style="gap:9px;margin-bottom:13px">
    <div class="chip-row">${filters.map(([key, label, total]) => `<button class="chip ${ui.memoryFilter === key ? 'active' : ''}" data-act="memory-filter" data-filter="${key}">${label} · ${total}</button>`).join('')}</div>
    <span class="spacer"></span>
    <select data-scope="memory" data-key="workflowId" aria-label="Filter by workflow" style="min-width:210px">
      <option value="">All workflows</option>${workflowOptions}
    </select>
  </div>
  ${mem.error ? `<div class="empty"><strong>Memory unavailable</strong>${esc(mem.error)}</div>` : filtered.length ? `<div class="stack">${cards}</div>` : emptyState('No matching episodes', 'Run a workflow in simulated or live mode; the result will appear here with its visual audits.', '<button class="btn btn-primary" data-nav="builder">Open Builder</button>')}`;
}

/* ------------------------------------------------------------------ captures */
function renderCaptures() {
  const all = ui.captures || [];
  const filtered =
    ui.captureFilter === 'all'
      ? all
      : ui.captureFilter === 'live'
      ? all.filter((c) => !c.simulated)
      : ui.captureFilter === 'simulated'
      ? all.filter((c) => c.simulated)
      : ui.captureFilter === 'run'
      ? all.filter((c) => c.runId)
      : all.filter((c) => !c.runId);
  return `
  <div class="page-head">
    <div>
      <h1>Screen captures</h1>
      <p>Every screenshot attached to a run, plus captures you take while building. Simulated captures are generated placeholders and are labelled so they are never mistaken for evidence.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn" data-act="capture-now">Capture screen</button>
      <button class="btn btn-primary" data-act="refresh">Refresh</button>
    </div>
  </div>
  <div class="chip-row" style="margin-bottom:14px">
    ${[
      ['all', 'All', all.length],
      ['live', 'Live pixels', all.filter((c) => !c.simulated).length],
      ['simulated', 'Simulated', all.filter((c) => c.simulated).length],
      ['run', 'From runs', all.filter((c) => c.runId).length],
      ['manual', 'Manual', all.filter((c) => !c.runId).length],
    ]
      .map(
        ([key, label, count]) =>
          `<button class="chip ${ui.captureFilter === key ? 'active' : ''}" data-act="capture-filter" data-filter="${key}">${label} · ${count}</button>`
      )
      .join('')}
  </div>
  ${
    filtered.length
      ? `<div class="captures-grid">${filtered
          .map(
            (c) => `<button class="capture-card" data-act="open-capture" data-id="${esc(c.id)}" data-sim="${c.simulated ? '1' : '0'}" data-path="${esc(c.path)}" data-caption="${esc(c.caption || '')}">
        <span class="capture-thumb">
          <img src="/api/files/raw?path=${encodeURIComponent(c.path)}" alt="${esc(c.caption || 'Capture')}" loading="lazy" />
          ${c.simulated ? '<span class="evidence-tag">SIMULATED</span>' : ''}
          ${(c.marks || []).map((mark) => `<span title="${esc(mark.label)}" style="position:absolute;left:${Number(mark.x) || 0}%;top:${Number(mark.y) || 0}%;transform:translate(-50%,-50%);background:#e5484d;color:#fff;border-radius:50%;font-size:9px;width:14px;height:14px;line-height:14px;text-align:center;font-weight:700">${esc(mark.number)}</span>`).join('')}
        </span>
        <span class="capture-info">
          <strong>${esc(c.caption || 'Screen capture')}</strong>
          <span class="meta">
            <span>${fmtTime(c.createdAt)}</span>
            ${c.runId ? '<span class="badge">run</span>' : '<span class="badge">manual</span>'}
            ${c.workflowName ? `<span>· ${esc(c.workflowName)}</span>` : ''}
            ${c.width ? `<span>· ${c.width}×${c.height}</span>` : ''}
          </span>
        </span>
      </button>`
          )
          .join('')}</div>`
      : emptyState('No captures yet', 'Run a workflow with a capture step, or take a screenshot with the button above.')
  }`;
}

async function loadCaptures() {
  const res = await api('/api/captures');
  ui.captures = res.ok ? res.captures : [];
}

/* ------------------------------------------------------------------ shortcuts */
function renderShortcuts() {
  const data = ui.shortcuts;
  if (!data) {
    return `
    <div class="page-head"><div><h1>Shortcut learning</h1><p>Review shortcuts proposed by passed live missions. Nothing reaches the planner until you approve it and a live replay passes.</p></div></div>
    <div class="empty"><strong>Loading shortcuts…</strong>Reading the review queue and approved habits.</div>`;
  }
  const candidates = data.candidates || [];
  const habits = data.habits || [];
  const blocked = data.blocked || [];
  const decisions = data.decisions || [];
  const candidateRows = candidates.length
    ? candidates.map((c) => `<tr>
        <td><strong>${esc(c.action)}</strong><div class="dim small">${esc(c.app)}${c.process ? ` · ${esc(c.process)}` : ''} · <span class="mono">${esc(c.keys)}</span></div>${c.windowTitle ? `<div class="dim small">window: ${esc(c.windowTitle)}${c.appVersion ? ` · v${esc(c.appVersion)}` : ''}</div>` : ''}</td>
        <td>${esc(c.workflowName || '—')}<div class="dim small">${esc(c.runId || '')}</div></td>
        <td>${Number(c.seen || 1)}×<div class="dim small">${fmtTime(c.lastSeenAt)}</div></td>
        <td>${c.evidencePath ? `<a class="small" href="/api/files/raw?path=${encodeURIComponent(c.evidencePath)}" target="_blank" rel="noreferrer">evidence</a>` : '—'}</td>
        <td><div class="row wrap" style="gap:5px">
          <button class="btn btn-sm btn-primary" data-act="shortcut-decide" data-id="${esc(c.id)}" data-decision="approve">Approve</button>
          <button class="btn btn-sm btn-ghost" data-act="shortcut-decide" data-id="${esc(c.id)}" data-decision="reject">Reject</button>
          <button class="btn btn-sm btn-ghost" data-act="shortcut-decide" data-id="${esc(c.id)}" data-decision="never">Never learn</button>
        </div></td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted small">No shortcuts waiting for review. Passed live missions propose new key steps here.</td></tr>';
  const habitRows = habits.length
    ? habits.map((h) => `<tr>
        <td><strong>${esc(h.action)}</strong><div class="dim small">${esc(h.app)}${h.process ? ` · ${esc(h.process)}` : ''} · <span class="mono">${esc(h.keys)}</span></div>${h.windowTitle ? `<div class="dim small">window: ${esc(h.windowTitle)}${h.appVersion ? ` · v${esc(h.appVersion)}` : ''}</div>` : ''}</td>
        <td><span class="badge ${Number(h.confidence) >= 60 ? 'okbadge' : 'warnbadge'}">${Number(h.confidence || 0)}%</span>${h.replayStatus !== 'passed' ? `<div><span class="badge warnbadge">replay ${esc(h.replayStatus || 'pending')}</span></div>` : ''}${h.reviewReason === 'app-update' ? '<div><span class="badge warnbadge">app updated</span></div>' : ''}</td>
        <td>${Number(h.successes || 0)} / ${Number(h.failures || 0)}<div class="dim small">replays ${Number(h.replayPasses || 0)} / ${Number(h.replayFailures || 0)}</div></td>
        <td>${fmtTime(h.lastAt)}${h.lastFailedAt ? `<div class="dim small">failed ${fmtTime(h.lastFailedAt)}</div>` : ''}</td>
        <td><div class="row wrap" style="gap:5px">${h.replayStatus !== 'passed' && h.reviewReason !== 'app-update' ? `<button class="btn btn-sm btn-primary" data-act="shortcut-replay" data-id="${esc(h.id)}">Replay</button>` : ''}<button class="btn btn-sm btn-ghost" data-act="shortcut-habit-state" data-id="${esc(h.id)}" data-enabled="${h.enabled === false ? 'true' : 'false'}">${h.enabled === false ? 'Enable' : 'Disable'}</button></div></td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted small">No approved shortcuts yet. Approve a candidate, then run its replay before it can reach the planner.</td></tr>';
  return `
  <div class="page-head">
    <div><h1>Shortcut learning</h1><p>A shortcut is proposed only after a passed live mission and final review. It reaches the planner only after approval and a passing live replay, stays scoped to the observed process/window, and returns to review when its app version changes. Repeated failures lower its confidence.</p></div>
    <button class="btn btn-sm" data-act="shortcuts-refresh">Refresh</button>
  </div>
  <div class="card">
    <div class="card-head"><h3>Waiting for review</h3><span class="badge">${candidates.length}</span></div>
    <div class="card-body"><table class="table"><thead><tr><th>Action</th><th>Workflow</th><th>Seen</th><th>Evidence</th><th></th></tr></thead><tbody>${candidateRows}</tbody></table></div>
  </div>
  <div class="card section-gap">
    <div class="card-head"><h3>Approved shortcuts</h3><span class="badge">${habits.length}</span></div>
    <div class="card-body"><table class="table"><thead><tr><th>Action</th><th>Confidence</th><th>Success / fail</th><th>Last used</th><th></th></tr></thead><tbody>${habitRows}</tbody></table></div>
  </div>
  ${blocked.length ? `<div class="card section-gap"><div class="card-head"><h3>Never learn</h3><span class="badge">${blocked.length}</span></div><div class="card-body"><table class="table"><thead><tr><th>Action</th><th></th></tr></thead><tbody>${blocked
    .map((b) => `<tr><td>${esc(b.app)} · <span class="mono">${esc(b.keys)}</span> · ${esc(b.action)}</td><td><button class="btn btn-sm btn-ghost" data-act="shortcut-unblock" data-id="${esc(b.id)}">Undo</button></td></tr>`)
    .join('')}</tbody></table></div></div>` : ''}
  <div class="card section-gap">
    <div class="card-head"><h3>Decision history</h3><span class="badge">${decisions.length}</span></div>
    <div class="card-body">${decisions.length ? `<table class="table"><thead><tr><th>When</th><th>Action</th><th>Shortcut</th><th>Reason</th><th>By</th></tr></thead><tbody>${decisions.map((d) => `<tr><td>${fmtTime(d.at)}</td><td><strong>${esc(d.action)}</strong></td><td>${esc(d.app || '—')} · <span class="mono">${esc(d.keys || '')}</span> · ${esc(d.shortcut || '')}</td><td class="small">${esc(d.reason || '')}</td><td class="small">${esc(d.by || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">No shortcut decisions recorded yet.</p>'}</div>
  </div>`;
}

/* ------------------------------------------------------------------ tools */
function renderTools() {
  const d = ui.data;
  const tools = d.tools;
  const usage = d.usage || [];
  return `
  <div class="page-head">
    <div>
      <h1>Tools &amp; commands</h1>
      <p>PowerShell helpers the AI can call from a <span class="mono">Run tool</span> step. AI-authored scripts arrive as drafts and cannot run until you approve them. Every execution is recorded below.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn" data-act="tool-generate">✦ Ask AI for a tool</button>
      <button class="btn btn-primary" data-act="tool-new">＋ New tool</button>
    </div>
  </div>
  <div class="tabs" style="max-width:320px;margin-bottom:14px">
    <button class="${ui.toolTab === 'tools' ? 'active' : ''}" data-act="tool-tab" data-tab="tools">Tools · ${tools.length}</button>
    <button class="${ui.toolTab === 'usage' ? 'active' : ''}" data-act="tool-tab" data-tab="usage">Usage history · ${usage.length}</button>
  </div>
  ${
    ui.toolTab === 'tools'
      ? tools.length
        ? `<div class="stack">${tools
            .map(
              (t) => `<div class="card tool-card">
          <div class="tool-head">
            <div style="flex:1">
              <div class="row wrap">
                <strong>${esc(t.name)}</strong>
                ${statusPill(t.status, t.status === 'approved' ? 'approved' : t.status)}
                ${t.createdBy === 'ai' ? '<span class="badge ai">AI authored</span>' : ''}
                ${t.risk ? `<span class="badge warnbadge">${esc(t.risk)} risk</span>` : ''}
              </div>
              <p class="tool-desc" style="margin-top:3px">${esc(t.description || 'No description')}</p>
            </div>
            <div class="row" style="gap:5px">
              ${
                t.status !== 'approved'
                  ? `<button class="btn btn-sm btn-primary" data-act="tool-status" data-id="${t.id}" data-status="approved">Approve</button>`
                  : `<button class="btn btn-sm btn-ghost" data-act="tool-status" data-id="${t.id}" data-status="disabled">Disable</button>`
              }
              <button class="btn btn-sm" data-act="tool-run" data-id="${t.id}" ${t.status !== 'approved' ? 'disabled title="Approve before running"' : ''}>Run</button>
              <button class="btn btn-sm btn-ghost" data-act="tool-edit" data-id="${t.id}">Edit</button>
              <button class="btn btn-sm btn-ghost" data-act="tool-delete" data-id="${t.id}">Delete</button>
            </div>
          </div>
          <details class="code-wrap">
            <summary>${esc(t.file || 'script')} · ${t.usage?.length || 0} run(s)</summary>
            <pre class="code">${esc(t.code)}</pre>
          </details>
          ${
            ui.toolOutput && ui.toolOutput.id === t.id
              ? `<pre class="console-out ${ui.toolOutput.ok ? '' : 'err'}">${esc(ui.toolOutput.output)}</pre>`
              : ''
          }
        </div>`
            )
            .join('')}</div>`
        : emptyState('No tools yet', 'Create a helper command, or ask the AI to write one.')
      : usage.length
      ? `<div class="card"><div class="card-body" style="padding:0">
          <table class="data-table">
            <thead><tr><th>When</th><th>Kind</th><th>Model / tool</th><th>Result</th><th>Time</th><th>Prompt</th></tr></thead>
            <tbody>${usage
              .slice(0, 80)
              .map(
                (u) => `<tr>
                  <td class="nowrap">${fmtTime(u.at)}</td>
                  <td><span class="badge">${esc(u.kind)}</span></td>
                  <td><strong>${esc(u.model || '—')}</strong></td>
                  <td>${u.ok ? '<span class="pill passed">ok</span>' : `<span class="pill failed">error</span> <span class="small">${esc((u.error || '').slice(0, 90))}</span>`}</td>
                  <td class="mono">${fmtDur(u.ms)}</td>
                  <td class="small">${esc((u.prompt || '').slice(0, 110))}</td>
                </tr>`
              )
              .join('')}</tbody>
          </table>
        </div></div>`
      : emptyState('No usage yet', 'AI calls and tool runs appear here with timing and outcome.')
  }`;
}

/* ------------------------------------------------------------------ files */
function renderFiles() {
  const d = ui.data;
  return `
  <div class="page-head">
    <div>
      <h1>Files &amp; notes</h1>
      <p>Everything the console writes lives under <span class="mono">data/</span>: run notes, tool sources, captures and the persisted AI conversation.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn" data-act="new-note">＋ New note</button>
      <button class="btn btn-ghost" data-act="refresh">Refresh</button>
    </div>
  </div>
  <div class="tabs" style="max-width:400px;margin-bottom:14px">
    <button class="${ui.fileTab === 'files' ? 'active' : ''}" data-act="file-tab" data-tab="files">Workspace files</button>
    <button class="${ui.fileTab === 'notes' ? 'active' : ''}" data-act="file-tab" data-tab="notes">Notes · ${d.notes.length}</button>
    <button class="${ui.fileTab === 'history' ? 'active' : ''}" data-act="file-tab" data-tab="history">AI history · ${d.aiHistoryLength}</button>
  </div>
  ${ui.fileTab === 'files' ? renderFileBrowser() : ui.fileTab === 'notes' ? renderNotes() : renderAiHistory()}`;
}

function renderFileBrowser() {
  const files = ui.files || [];
  const sel = ui.selectedFile;
  const isImage = sel && /\.(png|svg)$/i.test(sel);
  const read = ui.fileRead && ui.fileRead.path === sel ? ui.fileRead : null;
  const preview = (() => {
    if (!sel) return '<p class="muted small">Select a file to preview it.</p>';
    if (isImage) {
      return `<img class="preview-img" src="/api/files/raw?path=${encodeURIComponent(sel)}" alt="Preview" />`;
    }
    if (ui.fileError) return `<p class="small" style="color:var(--bad)">${esc(ui.fileError)}</p>`;
    return `<pre class="code" style="max-height:520px">${esc(ui.fileText || 'Loading…')}</pre>`;
  })();
  const percent = read && read.totalChars ? Math.min(100, Math.round((read.nextOffset / read.totalChars) * 100)) : 0;
  const longPanel = sel && !isImage
    ? `<div class="card" style="margin-top:12px">
        <div class="card-head">
          <div><h3 style="margin:0">Long read &amp; write</h3><p class="dim small" style="margin-top:3px">Token-aware chunks, rolling summary, and append-only writes.</p></div>
          <div class="row wrap" style="gap:6px">${read ? `<span class="badge">${read.chunkTokens} chunk tokens</span><span class="badge">${read.totalTokens} file tokens</span><span class="badge">${percent}%</span>` : '<span class="badge">not loaded</span>'}</div>
        </div>
        <div class="card-body stack" style="gap:9px">
          <div style="height:5px;background:var(--line);border-radius:3px;overflow:hidden"><div style="height:5px;width:${percent}%;background:var(--ok);border-radius:3px"></div></div>
          <div class="row wrap" style="gap:6px">
            <button class="btn btn-sm" data-act="file-read-more" ${!read || read.eof || ui.fileBusy === 'read' ? 'disabled' : ''}>${ui.fileBusy === 'read' ? 'Reading…' : '＋ Load next chunk'}</button>
            <button class="btn btn-sm btn-ghost" data-act="file-read-reset" ${ui.fileBusy === 'read' ? 'disabled' : ''}>Read from start</button>
            <button class="btn btn-sm" data-act="file-summarize" ${ui.fileBusy === 'summary' ? 'disabled' : ''}>${ui.fileBusy === 'summary' ? '<span class="spinner"></span> Summarizing all chunks…' : '✦ Summarize file'}</button>
            ${read ? `<span class="dim small">${read.offset.toLocaleString()}–${read.nextOffset.toLocaleString()} of ${read.totalChars.toLocaleString()} chars${read.eof ? ' · end of file' : ''}</span>` : ''}
          </div>
          ${ui.fileSummary ? `<details class="hint-box" open><summary><strong>Rolling file summary</strong> · ${ui.fileSummary.summaryTokens || 0} tokens · ${ui.fileSummary.chunks || 1} chunk(s)</summary><pre class="small" style="white-space:pre-wrap;margin:7px 0 0">${esc(ui.fileSummary.summary)}</pre></details>` : ''}
          <label class="field"><span>Append text to this file</span><textarea rows="4" data-scope="fileappend" placeholder="Paste the next section. It is appended exactly as written, with token and size counts returned.">${esc(ui.fileAppend || '')}</textarea></label>
          <div class="row wrap" style="gap:6px">
            <button class="btn btn-sm btn-primary" data-act="file-append" ${ui.fileBusy === 'write' ? 'disabled' : ''}>${ui.fileBusy === 'write' ? 'Appending…' : 'Append chunk'}</button>
            <button class="btn btn-sm btn-ghost" data-act="file-append-clear">Clear draft</button>
            <span class="dim small">Edits stay inside <span class="mono">data/</span>; database and conversation files are protected.</span>
          </div>
        </div>
      </div>`
    : '';
  return `
  <div class="files-layout">
    <div class="card"><div class="card-body" style="padding:8px">
      <div class="file-list">
        ${
          files.length
            ? files
                .map(
                  (f) => `<button class="file-row ${sel === f.path ? 'active' : ''}" data-act="select-file" data-path="${esc(f.path)}">
              <span class="file-ext">${esc((f.ext || '').replace('.', '') || 'file')}</span>
              <span class="file-name">${esc(f.path)}</span>
              <span class="file-size">${fmtBytes(f.size)}</span>
            </button>`
                )
                .join('')
            : '<p class="muted small" style="padding:10px">No files yet.</p>'
        }
      </div>
    </div></div>
    <div class="card"><div class="card-head">
      <h3>${esc(sel || 'Preview')}</h3>
      ${sel ? `<a class="btn btn-sm btn-ghost" href="/api/files/raw?path=${encodeURIComponent(sel)}" target="_blank" rel="noopener">Open raw ↗</a>` : ''}
    </div>
    <div class="card-body">${preview}</div></div>
  </div>${longPanel}`;
}

function renderNotes() {
  const notes = ui.data.notes;
  if (!notes.length) return emptyState('No notes yet', 'Run a workflow and an auto note is written, or create one manually.');
  return `<div class="notes-grid">${notes
    .map(
      (n) => `<div class="card note-card">
        <div class="row wrap">
          <strong>${esc(n.title)}</strong>
          <span class="badge ${n.source === 'ai' ? 'ai' : ''}">${esc(n.source)}</span>
        </div>
        <p>${esc(n.preview || '')}</p>
        <div class="row wrap meta">
          <span>${fmtTime(n.createdAt)}</span>
          ${n.runId ? `<span>· run ${esc(n.runId)}</span>` : ''}
          <span class="spacer"></span>
          <button class="btn btn-sm" data-act="edit-note" data-id="${n.id}">Open</button>
          <button class="btn btn-sm btn-ghost" data-act="delete-note" data-id="${n.id}">Delete</button>
        </div>
      </div>`
    )
    .join('')}</div>`;
}

function renderAiHistory() {
  const chat = ui.chat || [];
  const memory = ui.memory || {};
  const summaries = memory.recentSummaries || [];
  const documents = memory.recentDocuments || [];
  return `<div class="card">
    <div class="card-head">
      <div><h3 style="margin:0">Conversation history</h3><p class="dim small" style="margin-top:3px">Full transcript is retained. Older turns become rolling summaries and are retrieved by relevance.</p></div>
      <div class="row wrap" style="gap:6px">
        <button class="btn btn-sm btn-primary" data-act="memory-summarize" ${ui.memoryBusy ? 'disabled' : ''}>${ui.memoryBusy ? '<span class="spinner"></span> Summarizing…' : 'Summarize now'}</button>
        <button class="btn btn-sm btn-ghost" data-act="chat-refresh">Refresh</button>
        <button class="btn btn-sm btn-ghost" data-act="chat-clear">Clear history</button>
      </div>
    </div>
  <div class="card-body">
    <div class="chip-row" style="margin-bottom:9px">
      <span class="badge">${memory.historyMessages ?? chat.length} messages</span>
      <span class="badge">~${memory.historyTokens || 0} history tokens</span>
      <span class="badge">${memory.summaryCount || 0} summaries</span>
      <span class="badge">${memory.coveredMessages || 0} covered</span>
      <span class="badge">${memory.unsummarizedMessages || 0} pending</span>
      <span class="badge">${memory.documents || 0} file memories</span>
    </div>
    ${summaries.length ? `<details class="hint-box" style="margin-bottom:9px"><summary><strong>Rolling memory</strong> · ${summaries.length} recent summary segment(s)</summary><div class="stack" style="gap:5px;margin-top:7px">${summaries
      .map((item) => `<div class="cc-note"><span class="badge">${esc(item.count)} turns</span> <span class="small">${esc(item.text)}</span><div class="dim small">${fmtTime(item.at)} · ${item.tokens || 0} tokens</div></div>`)
      .join('')}</div></details>` : ''}
    ${documents.length ? `<details class="hint-box" style="margin-bottom:9px"><summary><strong>File memory</strong> · ${documents.length} summarized document(s)</summary><div class="stack" style="gap:5px;margin-top:7px">${documents
      .map((item) => `<div class="cc-note"><strong class="mono small">${esc(item.path)}</strong><span class="dim small"> · ${item.chunks || 1} chunk(s) · ${item.tokens || 0} tokens · ${fmtTime(item.at)}</span><p class="small" style="margin-top:4px">${esc(item.summary)}</p></div>`)
      .join('')}</div></details>` : ''}
    ${
      chat.length
        ? `<div class="chat-log" style="max-height:520px">${chat
            .map(
              (m) =>
                `<div class="chat-msg ${m.role === 'user' ? 'user' : 'assistant'}"><span class="who">${
                  m.role === 'user' ? 'you' : 'sightline'
                }</span>${esc(m.content)}</div>`
            )
            .join('')}</div>`
        : '<p class="muted small">No AI conversation stored yet. It is saved to <span class="mono">data/conversation_history.txt</span>.</p>'
    }
  </div></div>`;
}

/* ------------------------------------------------------------------ examples */
function exampleRecord(ex) {
  return {
    automation_workflow: {
      id: 'wf_example_import',
      name: ex.title,
      status: 'draft',
      tags: ex.tags,
      patternTags: ex.patternTags || ex.tags,
      description: `${ex.refined.summary}\n\nOriginal request: ${ex.goal}`,
      failurePolicy: ex.failurePolicy,
      sourceExampleId: ex.id,
      steps: ex.steps.map((s) => ({
        id: s.id,
        type: s.type,
        name: s.name,
        params: s.params,
        timeoutMs: s.timeoutMs,
        optional: s.optional,
        condition: s.condition || null,
      })),
    },
  };
}

function renderExamples() {
  if (!ui.examples) {
    loadExamples().then(render);
    return '<div class="empty">Loading example library…</div>';
  }
  const exs = ui.examples;
  if (!exs.length) return emptyState('No examples bundled', 'Add entries to server/examples.js.');
  const selected = exs.find((e) => e.id === ui.selectedExample) || exs[0];
  ui.selectedExample = selected.id;

  return `
  <div class="page-head">
    <div>
      <h1>Example workflows</h1>
      <p>${exs.length} workflows with the full refinement trail: the raw request, the refined interpretation, the exact Automation Steps, the tests and evidence, the conclusion and the follow-ups. Import any of them as a draft and calibrate it against your own screen.</p>
    </div>
    <div class="page-head-actions">
      <div class="chip-row">
        <button class="chip ${ui.exampleTab === 'examples' ? 'active' : ''}" data-act="example-tab" data-tab="examples">Workflows · ${exs.length}</button>
        <button class="chip ${ui.exampleTab === 'schema' ? 'active' : ''}" data-act="example-tab" data-tab="schema">Field keys &amp; records</button>
        <button class="chip ${ui.exampleTab === 'playbook' ? 'active' : ''}" data-act="example-tab" data-tab="playbook">Supervisor usage</button>
        <button class="chip ${ui.exampleTab === 'knack' ? 'active' : ''}" data-act="example-tab" data-tab="knack">Knack schema</button>
      </div>
    </div>
  </div>
  ${
    ui.exampleTab === 'schema'
      ? renderSchemaTab(selected)
      : ui.exampleTab === 'playbook'
      ? renderSupervisorPlaybook()
      : ui.exampleTab === 'knack'
      ? renderKnackTab()
      : `<div class="examples-layout">
          <aside class="example-list">
            ${exs
              .map(
                (e) => `<button class="example-item ${e.id === selected.id ? 'active' : ''}" data-act="example-select" data-id="${e.id}">
                  <span class="row wrap" style="gap:5px">
                    <span class="badge">${esc(e.category)}</span>
                    <span class="badge ${e.difficulty === 'Advanced' ? 'warnbadge' : ''}">${esc(e.difficulty)}</span>
                  </span>
                  <strong>${esc(e.title)}</strong>
                  <span class="dim small">${e.stepCount} steps · ${esc(e.estimated)}</span>
                </button>`
              )
              .join('')}
          </aside>
          ${renderExampleDetail(selected)}
        </div>`
  }`;
}

function renderExampleDetail(ex) {
  return `
  <section class="stack">
    <div class="card" style="padding:15px 17px">
      <div class="row wrap" style="gap:6px">
        <span class="badge">${esc(ex.category)}</span>
        <span class="badge ${ex.difficulty === 'Advanced' ? 'warnbadge' : ''}">${esc(ex.difficulty)}</span>
        <span class="badge">${esc(ex.estimated)}</span>
        <span class="badge ai">template</span>
        <span class="spacer"></span>
        <button class="btn btn-sm" data-act="example-import" data-id="${ex.id}" data-status="draft">Import as draft</button>
        <button class="btn btn-sm btn-primary" data-act="example-import" data-id="${ex.id}" data-status="ready">Import as ready</button>
      </div>
      <h2 style="margin-top:10px;font-size:18px">${esc(ex.title)}</h2>
      <p class="dim small" style="margin-top:5px">${esc(ex.tags.join(' · '))}</p>
      <p class="dim small" style="margin-top:5px">Agent chain: <span class="mono">${esc((ex.chainRoles || []).join(' → '))}</span> · Pattern tags: ${esc((ex.patternTags || []).join(', '))}</p>
    </div>

    <div class="card">
      <div class="card-head"><h3>1 · Raw request</h3><span class="dim small">exactly what the user typed</span></div>
      <div class="card-body"><blockquote class="goal-quote">${esc(ex.goal)}</blockquote></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>2 · Refined specification</h3><span class="dim small">assumptions made explicit</span></div>
      <div class="card-body">
        <p style="font-size:13px">${esc(ex.refined.summary)}</p>
        <div class="detail-cols">
          <div>
            <h4 class="mini-head">Assumptions</h4>
            <ul class="rule-list">${ex.refined.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
          </div>
          <div>
            <h4 class="mini-head">Prerequisites</h4>
            <ul class="rule-list">${ex.prerequisites.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
            <h4 class="mini-head" style="margin-top:9px">Inputs</h4>
            <ul class="rule-list">${ex.refined.inputs.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
          </div>
        </div>
        ${
          ex.warnings.length
            ? `<div class="hint-box" style="margin-top:11px;border-left-color:rgba(251,191,36,.6);background:rgba(251,191,36,.06)">${ex.warnings
                .map((w) => esc(w))
                .join(' · ')}</div>`
            : ''
        }
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>3 · Commands</h3><span class="dim small">${ex.steps.length} Automation Steps</span></div>
      <div class="card-body" style="overflow:auto">
        <table class="data-table">
          <thead><tr><th>#</th><th>Step</th><th>Type</th><th>Parameters</th><th>Timeout</th></tr></thead>
          <tbody>
            ${ex.steps
              .map(
                (s, i) => `<tr>
                  <td class="mono">${i + 1}</td>
                  <td><strong>${esc(s.name)}</strong>${s.optional ? ' <span class="badge">optional</span>' : ''}</td>
                  <td><span class="type-chip">${esc(s.type)}</span></td>
                  <td class="mono small">${esc(stepSummary(s))}</td>
                  <td class="mono small">${Math.round((s.timeoutMs || 15000) / 1000)}s</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>4 · Tests &amp; verification</h3><span class="dim small">policy: ${esc(
        ex.failurePolicy.onFailure
      )} · screenshots ${ex.failurePolicy.captureScreenshot ? 'on' : 'off'}</span></div>
      <div class="card-body detail-cols">
        <div>
          <h4 class="mini-head">Assertions</h4>
          <ul class="rule-list">${ex.verification.assertions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
        </div>
        <div>
          <h4 class="mini-head">Evidence captured</h4>
          <ul class="rule-list">${ex.verification.evidence.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>5 · Conclusion</h3><span class="dim small">what a pass means</span></div>
      <div class="card-body"><p style="font-size:13px">${esc(ex.conclusion)}</p></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>6 · Follow-ups</h3></div>
      <div class="card-body"><ul class="rule-list">${ex.followups.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>
    </div>

    <details class="log">
      <summary>Record shape — Automation Workflow + Automation Steps JSON</summary>
      <div class="card-body"><pre class="code" style="max-height:420px">${esc(JSON.stringify(exampleRecord(ex), null, 2))}</pre></div>
    </details>
  </section>`;
}

/* ------------------------------------------------------------------ command center */
const MISSION_ACTIVE = ['queued', 'planning', 'running', 'verifying', 'reviewing', 'replanning'];

function eventSeverity(evt) {
  if (evt.kind === 'error') return 'error';
  if (evt.kind === 'result' && /fail|cancel/i.test(evt.message || '')) return 'error';
  if (evt.kind === 'decision' || evt.kind === 'replan') return 'warn';
  return 'info';
}

function missionDraft() {
  const d = ui.data;
  if (!ui.missionDraft) {
    ui.missionDraft = {
      workflowId: d.workflows[0]?.id || '',
      goal: '',
      mode: d.settings.dryRun ? 'dry' : 'live',
      maxAttempts: 2,
      checkSeconds: Math.round((d.settings.missionCheckIntervalMs || 5000) / 1000),
      vision: Boolean(d.settings.visionEnabled),
      autoReplan: true,
      useLearnedPatterns: true,
      observeEnabled: true,
      autoApplyObserved: true,
      newChatMode: 'auto',
    };
  }
  if (!ui.missionDraft.workflowId && d.workflows[0]) ui.missionDraft.workflowId = d.workflows[0].id;
  if (!ui.missionDraft.newChatMode) ui.missionDraft.newChatMode = 'auto';
  return ui.missionDraft;
}

function missionShot(ref) {
  return `<figure class="cc-shot">
    <img src="/api/files/raw?path=${encodeURIComponent(ref.path)}" alt="${esc(ref.caption)}" loading="lazy" />
    <figcaption><span class="badge">${esc(ref.kind)}</span> ${esc(ref.caption)}${
      ref.simulated ? ' · simulated' : ''
    }<span class="dim small"> · ${fmtTime(ref.at)}</span></figcaption>
  </figure>`;
}

function missionPipeline(pipeline) {
  return `<div class="cc-pipeline">${pipeline
    .map(
      (agent) => `<div class="cc-agent ${esc(agent.status)}">
        <div class="row" style="gap:6px"><strong>${esc(agent.name)}</strong><span class="spacer"></span>${statusPill(agent.status)}</div>
        <p class="dim small" style="margin-top:3px">${esc(agent.task || '')}</p>
        ${agent.output ? `<p class="small cc-output">${esc(agent.output)}</p>` : ''}
        <div class="chip-row" style="margin-top:6px">${(agent.subAgents || [])
          .map((sub) => `<span class="badge">${esc(sub.name)} · ${esc(sub.status)}</span>`)
          .join('')}</div>
      </div>`
    )
    .join('')}</div>`;
}

function missionObserverPanels(detail) {
  const observer = detail.observer || {};
  const position = observer.position || detail.runPosition || {};
  const stepNumber = position.stepNumber ?? (position.index !== undefined ? position.index + 1 : null);
  const total = position.total || detail.stepLedger?.length || 0;
  const nextName = position.next?.name || observer.nextRealStep || 'No next step observed yet';
  const currentName = position.step?.name || position.current || observer.observed || 'Waiting for the first observation';
  const ledger = (detail.stepLedger || []).slice(-8).reverse();
  const refinements = (detail.refinements || []).slice(0, 4);
  const inputs = (detail.userInputs || []).slice(0, 3);
  return `<div class="cc-two">
    <div class="card">
      <div class="card-head"><h3>Step ledger &amp; real position</h3><span class="dim small">intent → observed state → next action</span></div>
      <div class="card-body">
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <span class="badge">step ${stepNumber ?? '—'} / ${total || '—'}</span>
          <span class="badge">${esc(observer.decision || 'continue')}</span>
          <span class="badge">${observer.confidence !== undefined ? Math.round(Number(observer.confidence || 0) * 100) + '% confidence' : 'unscored'}</span>
        </div>
        <p class="small" style="margin-top:8px"><strong>Now:</strong> ${esc(currentName)}</p>
        <p class="small"><strong>Next real step:</strong> ${esc(nextName)}</p>
        <p class="dim small">${esc(position.visible || observer.nextExpected || 'The observer compares the selected screenshots with the ledger; it does not assume a step happened just because a similar screen appeared earlier.')}</p>
        ${ledger.length
          ? `<table class="data-table" style="margin-top:9px"><thead><tr><th>#</th><th>Step</th><th>State</th><th>Next</th></tr></thead><tbody>${ledger
              .map(
                (entry) => `<tr><td class="mono">${entry.seq ?? '—'}</td><td><span class="badge">${esc(entry.type)}</span> ${esc(entry.name)}${entry.error ? `<div class="dim small">${esc(entry.error)}</div>` : ''}</td><td>${statusPill(entry.status || 'pending')}</td><td class="dim small">${esc(entry.next?.name || '—')}</td></tr>`
              )
              .join('')}</tbody></table>`
          : '<p class="muted small" style="margin-top:9px">The step ledger appears when a run starts.</p>'}
        ${refinements.length ? `<div style="border-top:1px solid var(--line);margin-top:9px;padding-top:8px"><h4 class="mini-head">Applied refinements</h4>${refinements.map((entry) => `<div class="cc-note"><span class="badge">${esc(entry.source)}</span> <span class="small">${esc(entry.reason || entry.action)}</span><span class="dim small"> · ${entry.steps?.length || 0} step(s) at ${Number(entry.index || 0) + 1} · ${fmtTime(entry.at)}</span></div>`).join('')}</div>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Observer / drifter</h3><span class="dim small">${esc(observer.source || 'always-on')} · ${observer.vision ? 'screenshots viewed' : 'ledger only'}</span></div>
      <div class="card-body">
        <div class="row" style="gap:7px">${statusPill(observer.status || 'idle')}<span class="badge">${observer.applied || 0} step block(s) applied</span><span class="spacer"></span><span class="dim small">${observer.lastAt ? fmtTime(observer.lastAt) : 'not run yet'}</span></div>
        <p class="small" style="margin-top:8px">${esc(observer.summary || 'The observer watches active missions and inserts steps when the evidence shows a missing in-between state.')}</p>
        ${observer.potential ? `<p class="dim small">Potential: ${esc(observer.potential)}</p>` : ''}
        ${observer.screenshot ? `<div class="cc-shots" style="margin-top:8px">${missionShot({ path: observer.screenshot, caption: 'Observer evidence frame', kind: 'observation', at: observer.lastAt })}</div>` : ''}
        <label class="field" style="margin-top:10px"><span>Operator finding → extracted workflow steps</span><textarea rows="3" data-scope="missioninput" placeholder="e.g. After the Store page opens, move the pointer to the Install button before clicking; it is two steps, and the button may not be visible yet.">${esc(ui.missionInput || '')}</textarea></label>
        <div class="row" style="gap:6px"><button class="btn btn-sm btn-primary" data-act="mission-input-extract" data-id="${detail.id}" ${ui.missionInputBusy ? 'disabled' : ''}>${ui.missionInputBusy ? 'Extracting…' : 'Extract &amp; add steps'}</button><span class="dim small">The extractor writes concrete steps, then the next test verifies them.</span></div>
        ${inputs.length ? `<div style="border-top:1px solid var(--line);margin-top:9px;padding-top:8px"><h4 class="mini-head">Extracted operator findings</h4>${inputs.map((entry) => `<div class="cc-note"><span class="badge">${esc(entry.source)}</span> <span class="small">${esc(entry.summary || entry.text)}</span><span class="dim small"> · ${entry.applied?.length || 0} block(s) · ${fmtTime(entry.at)}</span></div>`).join('')}</div>` : ''}
      </div>
    </div>
  </div>`;
}

async function missionDecision(action, extra = {}) {
  const id = ui.presentationMission || ui.selectedMission;
  if (!id) return toast('Pick a session first', 'error');
  const body = {
    action,
    instruction: ui.decisionDraft?.instruction || '',
    goal: ui.decisionDraft?.goal || '',
    workflowId: ui.decisionDraft?.workflowId || '',
    ...extra,
  };
  const res = await api(`/api/missions/${encodeURIComponent(id)}/decision`, { method: 'POST', body });
  if (!res.ok) return toast(res.error || 'Decision failed', 'error');
  ui.decisionForm = null;
  ui.decisionDraft = { instruction: '', goal: '', workflowId: '' };
  const nextId = res.mission?.id || id;
  ui.presentationMission = nextId;
  ui.selectedMission = nextId;
  await refresh();
  await loadPresentation(nextId);
  toast(`Decision recorded: ${action}`, 'ok');
}

async function loadPresentation(id, options = {}) {
  if (!id) {
    ui.presentation = null;
    ui.presentationMission = null;
    if (!options.silent) render();
    return;
  }
  ui.presentationMission = id;
  ui.presentationLoading = true;
  ui.presentationError = '';
  if (!options.silent) render();
  const res = await api(`/api/missions/${encodeURIComponent(id)}/presentation`);
  ui.presentationLoading = false;
  if (res.ok) ui.presentation = res.presentation;
  else ui.presentationError = res.error || 'Could not load the presentation';
  if (!options.silent) render();
}

const PRESENTATION_THEMES = {
  amber: ['#1d1608', '#e9a23b', '#fff3da'],
  blue: ['#081823', '#4db6dc', '#e7f8ff'],
  green: ['#0a1a12', '#62c98d', '#eafff1'],
  slate: ['#11151d', '#9db4d0', '#f1f5fb'],
};

function auditTone(verdict) {
  return verdict === 'ready' ? 'okbadge' : verdict === 'blocked' ? 'warnbadge' : '';
}

async function loadDeck(id, options = {}) {
  if (!id) return null;
  if (ui.presentationDeck?.id === id && !options.force) return ui.presentationDeck;
  if (ui.presentationDeckFailedId === id && !options.force) return null;
  if (ui.presentationDeckLoading) return null;
  ui.presentationDeckLoading = true;
  if (!options.silent) render();
  const res = await api(`/api/presentations/${encodeURIComponent(id)}`);
  ui.presentationDeckLoading = false;
  if (res.ok) {
    ui.presentationDeck = res.presentation;
    ui.presentationDeckFailedId = null;
  } else {
    ui.presentationDeckFailedId = id;
    if (!options.silent) toast(res.error || 'Could not load the full deck', 'error');
  }
  render();
  return res.ok ? res.presentation : null;
}

function renderMarksOverlay(shot) {
  const marks = (shot?.marks || []).slice(0, 8);
  if (!marks.length) return '';
  return `<div aria-hidden="true" style="position:absolute;inset:0;pointer-events:none">${marks
    .map(
      (mark) => `<span title="${esc(mark.label)}" style="position:absolute;left:${Number(mark.x) || 0}%;top:${Number(mark.y) || 0}%;transform:translate(-50%,-50%);min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#e9a23b;color:#1d1608;font-size:11px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px #0008">${esc(mark.number)}</span>`
    )
    .join('')}</div>`;
}

function renderAuditShot(shot) {
  if (!shot?.url) return '<div class="hint-box small">No current screenshot. Capture the app state before trusting the flow.</div>';
  return `<figure style="margin:0;display:grid;gap:5px">
    <div style="position:relative;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#05070a"><img src="${esc(shot.url)}" alt="${esc(shot.caption || 'Current screenshot')}" loading="lazy" style="display:block;width:100%;max-height:280px;object-fit:contain" />${renderMarksOverlay(shot)}</div>
    <figcaption class="dim small">${esc(shot.caption || 'Current screenshot')} · ${shot.simulated ? 'simulated' : 'live'}${shot.at ? ` · ${fmtTime(shot.at)}` : ''}</figcaption>
  </figure>`;
}

function renderQualityBadge(deck) {
  const quality = deck?.quality || deck?.profile?.quality;
  if (!quality) return '';
  return `<span class="badge ${quality.score >= 80 ? 'okbadge' : quality.score < 50 ? 'warnbadge' : ''}" title="${esc((quality.reasons || []).join(' · '))}">quality ${quality.score}/100 · ${esc(quality.grade)}</span>`;
}

function renderLineageSvg(graph) {
  const nodes = (graph?.nodes || []).slice(0, 24);
  if (!nodes.length) return '<div class="hint-box small">No lineage nodes yet.</div>';
  const edges = (graph?.edges || []).filter((edge) => nodes.some((node) => node.id === edge.from) && nodes.some((node) => node.id === edge.to));
  const levels = new Map(nodes.map((node) => [node.id, 0]));
  for (const root of graph?.roots || []) if (levels.has(root)) levels.set(root, 0);
  for (let pass = 0; pass < Math.min(10, nodes.length); pass++) {
    let changed = false;
    for (const edge of edges) {
      if (!levels.has(edge.from) || !levels.has(edge.to)) continue;
      const next = Math.min(8, (levels.get(edge.from) || 0) + 1);
      if (next > (levels.get(edge.to) || 0)) {
        levels.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const columns = new Map();
  for (const node of nodes) {
    const level = levels.get(node.id) || 0;
    if (!columns.has(level)) columns.set(level, []);
    columns.get(level).push(node);
  }
  const nodeWidth = 174;
  const nodeHeight = 58;
  const colGap = 48;
  const rowGap = 28;
  const pad = 22;
  const maxLevel = Math.max(0, ...columns.keys());
  const maxRows = Math.max(1, ...[...columns.values()].map((column) => column.length));
  const width = Math.max(520, pad * 2 + (maxLevel + 1) * nodeWidth + maxLevel * colGap);
  const height = Math.max(150, pad * 2 + maxRows * nodeHeight + (maxRows - 1) * rowGap);
  const position = new Map();
  for (const [level, column] of columns) {
    column.forEach((node, index) => {
      position.set(node.id, {
        x: pad + level * (nodeWidth + colGap),
        y: pad + index * (nodeHeight + rowGap),
      });
    });
  }
  const edgeColor = (type) => type === 'repair-proposal' ? '#e9a23b' : type === 'recheck-run' ? '#8bb8ff' : '#5bc0ae';
  const nodeColor = (node) => node.kind === 'proposal' ? '#e9a23b' : node.kind === 'run' ? '#8bb8ff' : node.verdict === 'blocked' ? '#ff7b7b' : node.verdict === 'ready' ? '#68d391' : '#5bc0ae';
  const lines = edges.map((edge) => {
    const from = position.get(edge.from);
    const to = position.get(edge.to);
    if (!from || !to) return '';
    const x1 = from.x + nodeWidth;
    const y1 = from.y + nodeHeight / 2;
    const x2 = to.x;
    const y2 = to.y + nodeHeight / 2;
    const bend = Math.max(30, Math.abs(x2 - x1) / 2);
    return `<path d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" fill="none" stroke="${edgeColor(edge.type)}" stroke-width="1.6" opacity="0.8" marker-end="url(#lineage-arrow)" />`;
  }).join('');
  const boxes = nodes.map((node) => {
    const pos = position.get(node.id);
    const label = String(node.label || node.id);
    const short = label.length > 24 ? `${label.slice(0, 21)}…` : label;
    const color = nodeColor(node);
    return `<g><title>${esc(`${label} · ${node.id}`)}</title><rect x="${pos.x}" y="${pos.y}" width="${nodeWidth}" height="${nodeHeight}" rx="10" fill="#141a23" stroke="${color}" stroke-width="1.4" />
      <text x="${pos.x + 12}" y="${pos.y + 18}" fill="${color}" font-size="9" font-weight="700" letter-spacing="1">${esc(String(node.kind || 'deck').toUpperCase())}</text>
      <text x="${pos.x + 12}" y="${pos.y + 35}" fill="#e8ecf3" font-size="12" font-weight="600">${esc(short)}</text>
      <text x="${pos.x + 12}" y="${pos.y + 49}" fill="#8794a8" font-size="9">${esc(node.verdict || 'no verdict')}${node.quality != null ? ` · Q${node.quality}` : ''} · ${esc(String(node.id || '').slice(-6))}</text></g>`;
  }).join('');
  return `<div style="overflow:auto;border:1px solid var(--line);border-radius:12px;background:#0b0e14"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Deck lineage graph" style="display:block">
    <defs><marker id="lineage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7c8ba1"/></marker></defs>
    ${lines}${boxes}
  </svg></div><div class="small dim" style="margin-top:4px">Edges: <span style="color:#5bc0ae">deck</span> · <span style="color:#e9a23b">proposal</span> · <span style="color:#8bb8ff">re-test run</span></div>`;
}

function renderLineage(deck) {
  const lineage = deck?.lineage;
  const graph = ui.presentationGraph;
  if (!lineage && !graph) return '';
  const events = (lineage?.events || []).slice(0, 6);
  return `<details class="hint-box" ${graph ? 'open' : ''}><summary><strong>Deck lineage</strong>${lineage ? ` · root ${esc(lineage.rootDeckId || deck.id)}${lineage.parentDeckId ? ` · parent ${esc(lineage.parentDeckId)}` : ''}${lineage.depth ? ` · depth ${lineage.depth}` : ''}` : ''}</summary>
    <div class="stack" style="gap:5px;margin-top:6px">
      ${events.map((event) => `<div class="small"><span class="badge">${esc(event.type)}</span> ${esc(event.summary || '')} <span class="dim">${esc(fmtTime(event.at))}</span></div>`).join('') || '<span class="dim small">No lineage events yet.</span>'}
      <div class="row wrap" style="gap:5px"><button class="btn btn-sm btn-ghost" data-act="presentation-graph" data-id="${esc(deck.id)}" ${ui.presentationGraphBusy ? 'disabled' : ''}>${ui.presentationGraphBusy ? 'Loading graph…' : 'Show lineage graph'}</button>${graph ? `<span class="badge">${graph.nodes?.length || 0} node(s)</span><span class="badge">${graph.edges?.length || 0} edge(s)</span>` : ''}</div>
      ${graph ? renderLineageSvg(graph) : ''}
    </div></details>`;
}

function renderImageDiff(deck) {
  const diff = ui.presentationImageDiff;
  if (!diff || diff.deckId !== deck?.id) return '';
  return `<div class="hint-box small"><strong>Visual diff · ${diff.pct}% pixels changed</strong> <span class="dim">(${diff.changed.toLocaleString()} of ${diff.total.toLocaleString()} sampled)</span><img src="${diff.url}" alt="Changed pixels between before and after captures" style="display:block;width:100%;max-height:260px;object-fit:contain;margin-top:6px;border-radius:8px;background:#000" /></div>`;
}

async function computeImageDiff(deck) {
  const recheck = deck?.rechecks?.[0];
  const before = recheck?.comparison?.screenshots?.before?.url;
  const after = recheck?.comparison?.screenshots?.after?.url;
  if (!before || !after) throw new Error('This re-test has no before/after screenshot pair');
  const load = (src) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${src}`));
    image.src = src;
  });
  const [left, right] = await Promise.all([load(before), load(after)]);
  const width = 640;
  const height = 360;
  const draw = (image) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  };
  const a = draw(left);
  const b = draw(right);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const outContext = out.getContext('2d');
  const data = outContext.createImageData(width, height);
  let changed = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    const delta = Math.abs(a.data[index] - b.data[index]) + Math.abs(a.data[index + 1] - b.data[index + 1]) + Math.abs(a.data[index + 2] - b.data[index + 2]);
    if (delta > 48) {
      changed += 1;
      data.data[index] = 255;
      data.data[index + 1] = 92;
      data.data[index + 2] = 92;
      data.data[index + 3] = 235;
    } else {
      const grey = Math.round((b.data[index] + b.data[index + 1] + b.data[index + 2]) / 3 * 0.35);
      data.data[index] = grey;
      data.data[index + 1] = grey;
      data.data[index + 2] = grey;
      data.data[index + 3] = 180;
    }
  }
  outContext.putImageData(data, 0, 0);
  return {
    deckId: deck.id,
    pct: Math.round((changed / (width * height)) * 1000) / 10,
    changed,
    total: width * height,
    url: out.toDataURL('image/png'),
  };
}

function renderFlowAudit(deck, wf) {
  const liveAudit = ui.presentationAudit;
  const audit = liveAudit && (!deck?.audit || String(liveAudit.generatedAt || '') > String(deck.audit.generatedAt || '')) ? liveAudit : deck?.audit || liveAudit;
  if (!audit && deck?.auditSummary) {
    const summary = deck.auditSummary;
    const recheck = deck?.rechecks?.[0] || null;
    const compactShots = recheck?.comparison?.screenshots || null;
    return `<div class="card"><div class="card-head"><div><h3 style="margin:0">Flow audit</h3><p class="dim small" style="margin-top:3px">Compacted history: summaries, lineage and rechecks stay available; full evidence is fetched on demand.</p></div><div class="row wrap" style="gap:5px"><span class="badge ${auditTone(summary.verdict)}">${esc(summary.verdict)}</span><span class="badge">${summary.confidence ?? '—'}%</span><span class="badge">${summary.blockerCount || 0} blocker(s)</span>${renderQualityBadge(deck)}</div></div><div class="card-body stack" style="gap:8px"><p class="small" style="margin:0">${esc(summary.summary || 'No audit summary saved.')}</p>${recheck?.comparison ? `<div class="hint-box small"><strong>Latest re-test · ${esc(recheck.comparison.summary)}</strong>${compactShots?.before?.url && compactShots?.after?.url ? `<div class="cc-layout" style="margin-top:8px"><figure style="margin:0"><img src="${esc(compactShots.before.url)}" alt="Before re-test" loading="lazy" style="width:100%;border-radius:8px;border:1px solid var(--line)" /><figcaption class="dim small">Before · ${compactShots.before.marks || 0} mark(s)</figcaption></figure><figure style="margin:0"><img src="${esc(compactShots.after.url)}" alt="After re-test" loading="lazy" style="width:100%;border-radius:8px;border:1px solid var(--line)" /><figcaption class="dim small">After · ${compactShots.after.marks || 0} mark(s)</figcaption></figure></div><button class="btn btn-sm btn-ghost" data-act="presentation-diff" data-id="${deck.id}" ${ui.presentationDiffBusy ? 'disabled' : ''}>${ui.presentationDiffBusy ? 'Computing diff…' : 'Compare captures (pixel diff)'}</button>` : ''}</div>` : deck?.lastRecheck?.summary ? `<div class="hint-box small"><strong>Latest re-test</strong> · ${esc(deck.lastRecheck.summary)}</div>` : ''}${renderImageDiff(deck)}${renderLineage(deck)}<div class="row wrap" style="gap:6px">${deck.id ? `<span class="badge">audit compacted</span><button class="btn btn-sm btn-primary" data-act="presentation-reapply" data-id="${deck.id}" ${ui.presentationReapplyBusy || deck.control?.paused ? 'disabled' : ''}>${ui.presentationReapplyBusy ? '<span class="spinner"></span> Re-testing…' : 'Fresh re-test capture'}</button>${deck.control?.paused ? `<button class="btn btn-sm" data-act="presentation-control" data-id="${deck.id}" data-control="resume" ${ui.presentationControlBusy ? 'disabled' : ''}>Resume retries</button>` : ''}<a class="btn btn-sm btn-ghost" href="/api/presentations/${encodeURIComponent(deck.id)}/export?format=md" download>Export Markdown</a><a class="btn btn-sm btn-ghost" href="/api/presentations/${encodeURIComponent(deck.id)}/export?format=html" download>Export HTML</a>` : ''}</div></div></div>`;
  }
  if (!audit) return '';
  const recheck = deck?.rechecks?.[0] || null;
  const control = deck?.control || {};
  const attempts = deck?.attempts || {};
  const watch = deck?.watch || null;
  const review = deck?.review || null;
  const elements = (audit.elements || []).slice(0, 10);
  const patterns = (audit.patterns || []).slice(0, 4);
  const agents = (audit.agents || []).slice(0, 5);
  const suggestions = (audit.suggestions || []).slice(0, 5);
  const blockers = audit.blockers || [];
  const warnings = audit.warnings || [];
  const shot = audit.current?.screenshot;
  const quality = deck?.quality || deck?.profile?.quality;
  const budget = deck?.retryBudget || null;
  const diffShots = recheck?.comparison?.screenshots || null;
  return `
  <div class="card">
    <div class="card-head">
      <div><h3 style="margin:0">Flow audit</h3><p class="dim small" style="margin-top:3px">Plan, screenshot evidence, next step, patterns, agents and re-tests cross-referenced for this deck.</p></div>
      <div class="row wrap" style="gap:5px"><span class="badge ${auditTone(audit.verdict)}">${esc(audit.verdict)}</span><span class="badge">${audit.confidence}% confidence</span>${renderQualityBadge(deck)}${review ? `<span class="badge ${review.status === 'reviewed' ? 'okbadge' : review.status === 'needs_review' ? 'warnbadge' : ''}">${esc(review.status.replace('_', ' '))}</span>` : ''}</div>
    </div>
    <div class="card-body stack" style="gap:10px">
      <div class="hint-box"><strong>${esc(audit.summary)}</strong>${audit.reasons?.length ? `<ul class="small" style="margin:6px 0 0;padding-left:18px">${audit.reasons.slice(0, 4).map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}${audit.visual?.available ? `<div class="small" style="margin-top:6px"><span class="badge okbadge">visual check</span> ${esc(audit.visual.summary || 'Screenshot inspected.')}</div>` : audit.visual?.note ? `<div class="small dim" style="margin-top:6px">Visual check: ${esc(audit.visual.note)}</div>` : ''}</div>
      <div class="row wrap" style="gap:6px"><span class="badge ${control.paused ? 'warnbadge' : 'okbadge'}">${control.paused ? 'retries paused' : 'retry control active'}</span><span class="badge">${attempts.consecutive || 0}/${attempts.maxFailedAttempts || 3} consecutive failure(s)</span><span class="badge">${attempts.total || 0} re-test(s)</span>${budget ? `<span class="badge ${budget.ok ? '' : 'warnbadge'}" title="${esc(budget.reason || 'Shared across scheduler, watchdog, retries and re-tests')}">shared budget ${budget.failures || 0}/${budget.maxFailures || 3}</span>` : ''}${deck?.autoProposalId ? `<span class="badge ai">auto proposal ${esc(deck.autoProposalId)}</span>` : ''}${watch ? `<span class="badge ai">agent watched ${esc(fmtTime(watch.lastAt))}</span>` : '<span class="badge">deck agent not run</span>'}</div>
      ${control.paused ? `<div class="hint-box small"><strong>Automatic retries paused.</strong> ${esc(control.reason || 'Review the findings before resuming.')}</div>` : ''}
      ${deck?.autoProposalError ? `<div class="hint-box small" style="color:var(--bad)">Auto-proposal could not be created: ${esc(deck.autoProposalError)}</div>` : ''}
      ${quality ? `<details class="hint-box"><summary><strong>Deck quality ${quality.score}/100 · grade ${esc(quality.grade)}</strong></summary><div class="row wrap" style="gap:5px;margin-top:6px">${Object.entries(quality.factors || {}).map(([key, value]) => `<span class="badge">${esc(key)} ${value}%</span>`).join('')}</div><div class="small dim" style="margin-top:4px">${esc((quality.reasons || []).join(' · '))}</div></details>` : ''}
      ${renderLineage(deck)}
      ${watch?.notes?.length || deck?.notes?.length ? `<details class="hint-box"><summary><strong>Deck agent notes</strong> · ${(deck?.notes || watch?.notes || []).length}</summary><div class="stack" style="gap:4px;margin-top:6px">${(deck?.notes || watch?.notes || []).slice(0, 5).map((note) => `<div class="small"><span class="badge">${esc(note.kind || 'watch')}</span> ${esc(note.text)} <span class="dim">${esc(fmtTime(note.at))}</span></div>`).join('')}</div></details>` : ''}
      ${recheck?.freshCapture ? `<div class="small dim">Fresh re-test capture: ${esc(recheck.freshCapture.caption)} · ${recheck.freshCapture.simulated ? 'simulated' : 'live'}${recheck.autoMarks ? ` · ${recheck.autoMarks} auto-drawn mark(s)` : ''}</div>` : ''}
      <div class="cc-layout">
        <div class="stack" style="gap:6px">${renderAuditShot(shot)}<div class="chip-row"><span class="badge">${esc(audit.current?.step ? `Step ${audit.current.step.index + 1}: ${audit.current.step.name}` : 'No runtime step')}</span>${audit.current?.next ? `<span class="badge">next · ${esc(audit.current.next.name)}</span>` : ''}<span class="badge">${audit.current?.screenshotCount || 0} capture(s)</span></div></div>
        <div class="stack" style="gap:6px">
          <div class="chip-row">${(audit.checks || []).map((check) => `<span class="badge ${check.ok ? 'okbadge' : 'warnbadge'}">${check.ok ? '✓' : '!'} ${esc(check.label)}</span>`).join('')}</div>
          <table class="data-table"><thead><tr><th>Expected element</th><th>Evidence</th><th></th></tr></thead><tbody>${elements
            .map((element) => `<tr><td><strong class="small">${esc(element.expected)}</strong><div class="dim small">${element.index + 1}. ${esc(element.stepName)}</div></td><td><span class="badge ${element.status === 'observed' || element.status === 'present' ? 'okbadge' : element.status === 'missing' ? 'warnbadge' : ''}">${esc(element.status)}</span><div class="dim small">${esc(element.detail)}</div></td><td class="mono small dim">${esc(element.type)}</td></tr>`)
            .join('') || '<tr><td colspan="3" class="dim small">No steps to check.</td></tr>'}</tbody></table>
        </div>
      </div>
      ${blockers.length ? `<details class="hint-box" open><summary><strong>Why it cannot run yet</strong> · ${blockers.length} blocker(s)</summary><div class="stack" style="gap:4px;margin-top:6px">${blockers.map((item) => `<div class="small"><span class="badge warnbadge">blocker</span> <strong>${esc(item.label)}</strong> — ${esc(item.detail)}</div>`).join('')}</div></details>` : ''}
      ${warnings.length ? `<details class="hint-box"><summary><strong>Review warnings</strong> · ${warnings.length}</summary><div class="stack" style="gap:4px;margin-top:6px">${warnings.map((item) => `<div class="small"><span class="badge">warning</span> <strong>${esc(item.label)}</strong> — ${esc(item.detail)}</div>`).join('')}</div></details>` : ''}
      <div class="cc-layout">
        <div class="stack" style="gap:4px"><strong class="small">Recalled patterns</strong>${patterns.length ? patterns.map((pattern) => `<div class="small"><span class="badge">${esc(pattern.status)}</span> ${esc(pattern.workflowName)} · ${pattern.passed}/${pattern.total} steps${pattern.hindrances?.[0] ? `<span class="dim"> · ${esc(pattern.hindrances[0])}</span>` : ''}</div>`).join('') : '<span class="dim small">No similar completed runs yet.</span>'}</div>
        <div class="stack" style="gap:4px"><strong class="small">Agent check</strong>${agents.length ? agents.map((agent) => `<div class="small"><span class="badge ${agent.enabled ? 'okbadge' : ''}">${agent.enabled ? 'on' : 'off'}</span> ${esc(agent.name)} · ${esc(agent.status)}${agent.issue ? `<span class="dim"> · ${esc(agent.issue)}</span>` : ''}</div>`).join('') : '<span class="dim small">No agents configured.</span>'}</div>
      </div>
      <div class="stack" style="gap:4px"><strong class="small">Suggestions for the planner</strong>${suggestions.map((item) => `<div class="small"><span class="badge">${esc(item.priority || 'idea')}</span> <strong>${esc(item.title)}</strong><span class="dim"> — ${esc(item.detail)}</span></div>`).join('')}</div>
      ${recheck ? `<div class="hint-box"><strong>Latest re-test · ${esc(recheck.comparison.summary)}</strong><div class="small" style="margin-top:4px">${recheck.comparison.changedElements?.length ? recheck.comparison.changedElements.map((change) => `${esc(change.step)}: ${esc(change.before)} → ${esc(change.after)}`).join(' · ') : 'No element status changes between audits.'}</div>${recheck.comparison.run?.failed?.length ? `<div class="small" style="color:var(--bad);margin-top:4px">${recheck.comparison.run.failed.map((step) => `${esc(step.name)}: ${esc(step.error)}`).join(' · ')}</div>` : ''}${diffShots?.before?.url && diffShots?.after?.url ? `<div class="cc-layout" style="margin-top:8px"><figure style="margin:0"><img src="${esc(diffShots.before.url)}" alt="Before re-test" loading="lazy" style="width:100%;border-radius:8px;border:1px solid var(--line)" /><figcaption class="dim small">Before · ${esc(diffShots.before.caption || 'capture')}${diffShots.before.marks ? ` · ${diffShots.before.marks} mark(s)` : ''}</figcaption></figure><figure style="margin:0"><img src="${esc(diffShots.after.url)}" alt="After re-test" loading="lazy" style="width:100%;border-radius:8px;border:1px solid var(--line)" /><figcaption class="dim small">After · ${esc(diffShots.after.caption || 'capture')}${diffShots.after.marks ? ` · ${diffShots.after.marks} mark(s)` : ''}</figcaption></figure></div><button class="btn btn-sm btn-ghost" data-act="presentation-diff" data-id="${deck.id}" ${ui.presentationDiffBusy ? 'disabled' : ''}>${ui.presentationDiffBusy ? 'Computing diff…' : 'Compare captures (pixel diff)'}</button>` : ''}</div>${renderImageDiff(deck)}` : ''}
      <div class="row wrap" style="gap:6px">
        ${deck ? `<button class="btn btn-sm btn-primary" data-act="presentation-reapply" data-id="${deck.id}" ${ui.presentationReapplyBusy || control.paused ? 'disabled' : ''}>${ui.presentationReapplyBusy ? '<span class="spinner"></span> Capturing &amp; re-testing…' : '↻ Fresh re-test capture'}</button><button class="btn btn-sm" data-act="presentation-propose" data-id="${deck.id}" ${ui.presentationProposalBusy ? 'disabled' : ''}>${ui.presentationProposalBusy ? '<span class="spinner"></span> Planning…' : deck.proposalId ? 'Update planner proposal' : 'Create planner proposal'}</button><button class="btn btn-sm btn-ghost" data-act="presentation-review" data-id="${deck.id}" data-status="${review?.status === 'reviewed' ? 'needs_review' : 'reviewed'}">${review?.status === 'reviewed' ? 'Reopen review' : 'Mark reviewed'}</button><button class="btn btn-sm" data-act="presentation-watch" data-id="${deck.id}" ${ui.presentationWatchBusy ? 'disabled' : ''}>${ui.presentationWatchBusy ? 'Reviewing…' : 'Ask deck agent'}</button><button class="btn btn-sm" data-act="presentation-control" data-id="${deck.id}" data-control="${control.paused ? 'resume' : 'pause'}" ${ui.presentationControlBusy ? 'disabled' : ''}>${control.paused ? 'Resume retries' : 'Pause retries'}</button><button class="btn btn-sm btn-ghost" data-act="presentation-control" data-id="${deck.id}" data-control="reset" ${ui.presentationControlBusy ? 'disabled' : ''}>Reset attempts</button>${deck.proposalId ? `<span class="badge okbadge">proposal ${esc(deck.proposalId)}</span>` : ''}<a class="btn btn-sm btn-ghost" href="/api/presentations/${encodeURIComponent(deck.id)}/export?format=md" download>Export Markdown</a><a class="btn btn-sm btn-ghost" href="/api/presentations/${encodeURIComponent(deck.id)}/export?format=html" download>Export HTML</a>` : ''}
        <button class="btn btn-sm btn-ghost" data-act="presentation-audit" data-id="${wf.id}" ${ui.presentationAuditBusy ? 'disabled' : ''}>${ui.presentationAuditBusy ? 'Auditing…' : 'Audit current state'}</button>
        <button class="btn btn-sm btn-ghost" data-act="presentation-budget-reset" data-id="${wf.id}" ${ui.presentationControlBusy ? 'disabled' : ''}>Reset shared retry budget</button>
      </div>
    </div>
  </div>`;
}

function renderDeckPanel(wf) {
  const all = (ui.data.presentations || []).filter((deck) => deck.workflowId === wf.id);
  if (ui.presentationDeckId && !all.some((deck) => deck.id === ui.presentationDeckId)) ui.presentationDeckId = null;
  const selectedSummary = all.find((item) => item.id === ui.presentationDeckId) || all[0] || null;
  if (selectedSummary) ui.presentationDeckId = selectedSummary.id;
  const fullDeck = ui.presentationDeck?.id === selectedSummary?.id ? ui.presentationDeck : null;
  const deck = fullDeck || selectedSummary;
  if (selectedSummary && !fullDeck && !ui.presentationDeckLoading && ui.presentationDeckFailedId !== selectedSummary.id) {
    queueMicrotask(() => loadDeck(selectedSummary.id, { silent: true }));
  }
  const searchSource = ui.presentationDeckResults || all;
  const filtered = searchSource.filter((item) =>
    ui.presentationDeckClass === 'all' ? true : (item.profile?.classification || []).includes(ui.presentationDeckClass)
  );
  const slideIndex = deck?.slides?.length ? Math.max(0, Math.min(deck.slides.length - 1, ui.presentationSlide || 0)) : 0;
  ui.presentationSlide = slideIndex;
  const slide = deck?.slides?.[slideIndex] || null;
  const theme = PRESENTATION_THEMES[deck?.theme] || PRESENTATION_THEMES.amber;
  const video = deck && ui.videoUrl && ui.videoDeckId === deck.id ? ui.videoUrl : null;
  const chips = filtered
    .slice(0, 12)
    .map(
      (item) => `<button class="chip ${item.id === deck?.id ? 'active' : ''}" data-act="presentation-deck" data-id="${item.id}" title="${esc(`${item.title} · ${(item.profile?.classification || []).join(', ')}${item.similarity != null ? ` · ${Math.round(item.similarity * 100)}% match` : ''}`)}">${esc(
        item.title.length > 30 ? `${item.title.slice(0, 27)}…` : item.title
      )}${item.auditSummary?.verdict || item.audit?.verdict ? ` · ${esc(item.auditSummary?.verdict || item.audit?.verdict)}` : ''}</button>`
    )
    .join('');
  return `
  <div class="card">
    <div class="card-head">
      <div><h3 style="margin:0">AI presentation studio</h3><p class="dim small" style="margin-top:3px">Indexed decks for repeatable review: search by vector similarity, classify by purpose and re-test with fresh evidence.</p></div>
      <div class="row wrap" style="gap:6px"><span class="badge ai">${esc(wf.steps.length)} steps</span><span class="badge">${all.length} deck(s)</span>${renderQualityBadge(deck)}${deck?.profile?.classification?.length ? `<span class="badge">${esc(deck.profile.classification.join(' · '))}</span>` : ''}</div>
    </div>
    <div class="card-body stack" style="gap:10px">
      <div class="row wrap" style="gap:6px">
        <select data-scope="presentation" data-key="focus" aria-label="Presentation focus" style="max-width:190px">
          ${[
            ['auto', 'Auto · best angle'],
            ['howto', 'How to run it'],
            ['problem', 'Explain the problem'],
            ['suggestions', 'Suggest improvements'],
          ]
            .map(([value, label]) => `<option value="${value}" ${ui.presentationFocus === value ? 'selected' : ''}>${label}</option>`)
            .join('')}
        </select>
        <button class="btn btn-sm btn-primary" data-act="presentation-generate" data-id="${wf.id}" ${ui.presentationBusy ? 'disabled' : ''}>${ui.presentationBusy ? '<span class="spinner"></span> Auditing &amp; writing…' : '✦ Generate verified deck'}</button>
        ${deck ? `<button class="btn btn-sm" data-act="presentation-video" data-id="${deck.id}" ${ui.videoBusy ? 'disabled' : ''}>${ui.videoBusy ? 'Rendering video…' : `▶ Make ${Math.round(deck.durationSeconds || deck.slides.length * 5)}s video`}</button>` : ''}
        ${video ? `<a class="btn btn-sm btn-ghost" href="${video}" download="${esc(deck.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase())}.webm">Download WebM</a>` : ''}
      </div>
      <div class="row wrap" style="gap:6px">
        <input data-scope="presentation" data-key="deckQuery" value="${esc(ui.presentationDeckQuery || '')}" placeholder="Search decks by goal, blocker, pattern…" aria-label="Search saved decks" style="min-width:220px;max-width:360px" />
        <select data-scope="presentation" data-key="deckClass" aria-label="Deck classification" style="max-width:190px">
          ${[
            ['all', 'All classes'],
            ['troubleshooting', 'Troubleshooting'],
            ['how-to', 'How-to'],
            ['strategy', 'Strategy'],
            ['pattern-recall', 'Pattern recall'],
            ['visual-verification', 'Visual verification'],
            ['blocked', 'Blocked'],
            ['ready', 'Ready'],
            ['retested', 'Re-tested'],
            ['high-quality', 'High quality'],
            ['low-quality', 'Low quality'],
            ['lineage', 'Lineage'],
            ['repair-proposed', 'Repair proposed'],
            ['compacted', 'Compacted'],
          ].map(([value, label]) => `<option value="${value}" ${ui.presentationDeckClass === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <span class="dim small">${filtered.length} matching deck(s)${ui.presentationDeckQuery ? ' · vector sorted' : ''}</span>
      </div>
      ${chips ? `<div class="chip-row">${chips}</div>` : ''}
      ${ui.presentationError ? `<div class="hint-box" style="color:var(--bad)">${esc(ui.presentationError)}</div>` : ''}
      ${ui.videoError ? `<div class="hint-box" style="color:var(--bad)">${esc(ui.videoError)}</div>` : ''}
      ${renderFlowAudit(deck, wf)}
      ${ui.videoBusy ? `<p class="dim small" id="deck-video-status">Preparing the canvas…</p>` : ''}
      ${video ? `<video controls src="${video}" style="width:100%;max-height:420px;border-radius:12px;background:#000"></video>` : ''}
      ${
        deck && slide
          ? `<div style="position:relative;overflow:hidden;border:1px solid ${theme[1]}44;border-radius:16px;padding:28px 30px 22px;min-height:280px;background:radial-gradient(circle at 88% 12%, ${theme[1]}33, transparent 34%), linear-gradient(135deg, ${theme[0]}, #05070a 78%);color:${theme[2]}">
              <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
                <span style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${theme[1]}">${esc(slide.kicker)}</span>
                <span style="font-size:11px;color:${theme[2]}88">${slideIndex + 1} / ${deck.slides.length}</span>
              </div>
              <h2 style="font-size:clamp(24px,3.4vw,44px);line-height:1.03;margin:16px 0 18px;max-width:900px;color:${theme[2]}">${esc(slide.title)}</h2>
              ${slide.image?.url ? `<figure style="margin:0 0 18px;display:grid;grid-template-columns:minmax(0,1.35fr) minmax(150px,.65fr);gap:14px;align-items:start"><div style="position:relative;border:1px solid ${theme[1]}55;border-radius:12px;overflow:hidden;background:#000"><img src="${esc(slide.image.url)}" alt="${esc(slide.image.caption || 'Screenshot evidence')}" loading="lazy" style="display:block;width:100%;max-height:250px;object-fit:contain" />${renderMarksOverlay(slide.image)}</div><figcaption style="font-size:12px;line-height:1.45;color:${theme[2]}bb"><strong style="color:${theme[1]}">Observed evidence</strong><br />${esc(slide.image.caption || 'Current capture')}${slide.image.marks?.length ? `<br />${slide.image.marks.map((mark) => `${mark.number}. ${esc(mark.label)}`).join('<br />')}` : '<br />No element marks on this capture.'}</figcaption></figure>` : ''}
              <ul style="margin:0;padding-left:20px;display:grid;gap:8px;max-width:900px;font-size:clamp(13px,1.3vw,17px);line-height:1.38">${slide.bullets
                .map((bullet) => `<li>${esc(bullet)}</li>`)
                .join('')}</ul>
              ${slide.note ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.4;color:${theme[2]}aa;max-width:820px">${esc(slide.note)}</p>` : ''}
              <div style="display:flex;align-items:center;gap:8px;margin-top:22px">
                <button class="btn btn-sm" data-act="presentation-slide" data-delta="-1" ${slideIndex === 0 ? 'disabled' : ''}>←</button>
                <button class="btn btn-sm" data-act="presentation-slide" data-delta="1" ${slideIndex >= deck.slides.length - 1 ? 'disabled' : ''}>→</button>
                <div style="display:flex;gap:5px;margin-left:8px">${deck.slides
                  .map((_, index) => `<button aria-label="Slide ${index + 1}" data-act="presentation-slide" data-index="${index}" style="width:${index === slideIndex ? 22 : 7}px;height:7px;border:0;border-radius:4px;background:${index === slideIndex ? theme[1] : `${theme[2]}44`};cursor:pointer"></button>`)
                  .join('')}</div>
              </div>
            </div>
            <div class="row wrap" style="justify-content:space-between;gap:6px"><span class="dim small">${esc(deck.title)} · AI generated ${fmtTime(deck.createdAt)}${deck.missionId ? ' from a failed session' : ''}</span><span class="dim small">${esc(deck.model || '')}</span></div>`
          : `<div class="hint-box"><strong>No deck yet.</strong><p class="small" style="margin-top:4px">Generate a walkthrough from the workflow steps, or a troubleshooting deck from the selected session's evidence. The deck can be exported as a short WebM video.</p></div>`
      }
    </div>
  </div>`;
}

function describeParams(params) {
  return Object.entries(params || {})
    .filter(([, value]) => value !== '' && value != null)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' · ');
}

function renderWorkflowPresentation(wf, sessions) {
  const runs = wf.runHistory || [];
  return `
  <div class="stack">
    ${renderDeckPanel(wf)}
    <div class="card">
      <div class="card-head"><div><h3 style="margin:0">${esc(wf.name)}</h3><p class="dim small" style="margin-top:3px">${esc(wf.description || 'No description yet.')}</p></div>${statusPill(wf.status)}</div>
      <div class="card-body">
        <div class="chip-row" style="margin-bottom:10px"><span class="badge">${wf.steps.length} steps</span><span class="badge">${runs.length} recent run(s)</span><span class="badge">${(wf.patternTags || []).length} pattern tag(s)</span></div>
        <table class="data-table"><thead><tr><th>#</th><th>Step</th><th>Type</th><th>Parameters</th></tr></thead><tbody>${wf.steps
          .map(
            (step, index) => `<tr><td class="mono">${index + 1}</td><td><strong>${esc(step.name)}</strong>${step.optional ? ' <span class="badge">optional</span>' : ''}</td><td><span class="type-chip">${esc(step.type)}</span></td><td class="mono small dim">${esc(describeParams(step.params || {}) || '—')}</td></tr>`
          )
          .join('')}</tbody></table>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Sessions for this workflow</h3><span class="dim small">${sessions.length}</span></div>
      <div class="card-body">${sessions.length
        ? `<div class="stack" style="gap:6px">${sessions
            .map(
              (mission) => `<button class="cc-note" style="text-align:left;border:1px solid var(--line);background:transparent;cursor:pointer" data-act="open-presentation" data-id="${mission.id}"><span class="badge">${esc(mission.status)}</span> <strong class="small">${esc(mission.goal)}</strong><span class="dim small"> · ${fmtTime(mission.createdAt)}</span></button>`
            )
            .join('')}</div>`
        : '<p class="muted small">No supervised sessions yet. The slideshow above still documents how to perform the operation. Launch a mission from the Command Center to add verification evidence and a troubleshooting deck.</p>'}</div>
    </div>
    <div class="row wrap" style="gap:6px"><button class="btn btn-sm" data-act="select-workflow" data-id="${wf.id}">Open in Builder</button><button class="btn btn-sm btn-primary" data-nav="command">Open Command Center</button></div>
  </div>`;
}

function wrapCanvasText(ctx, text, maxWidth, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else {
      line = next;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

const deckImageCache = new Map();

function drawDeckFrame(ctx, deck, index) {
  const width = 1280;
  const height = 720;
  const slide = deck.slides[index];
  const theme = PRESENTATION_THEMES[deck.theme] || PRESENTATION_THEMES.amber;
  const visual = slide.image?.url ? deckImageCache.get(slide.image.url) || null : null;
  const textWidth = visual ? 640 : 1100;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, theme[0]);
  gradient.addColorStop(1, '#04060a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(width * 0.86, height * 0.12, 10, width * 0.86, height * 0.12, 430);
  glow.addColorStop(0, `${theme[1]}55`);
  glow.addColorStop(1, `${theme[1]}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'top';
  ctx.fillStyle = theme[1];
  ctx.font = '600 18px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(String(slide.kicker || '').toUpperCase(), 80, 68);
  ctx.textAlign = 'right';
  ctx.fillStyle = `${theme[2]}99`;
  ctx.fillText(`${index + 1} / ${deck.slides.length}`, width - 80, 68);
  ctx.textAlign = 'left';
  ctx.fillStyle = theme[2];
  ctx.font = '700 58px "Segoe UI", system-ui, sans-serif';
  const titleLines = wrapCanvasText(ctx, slide.title, textWidth, 3);
  titleLines.forEach((line, lineIndex) => ctx.fillText(line, 80, 132 + lineIndex * 66));
  let y = 132 + titleLines.length * 66 + 24;
  ctx.font = '400 27px "Segoe UI", system-ui, sans-serif';
  for (const bullet of (slide.bullets || []).slice(0, 4)) {
    ctx.fillStyle = theme[1];
    ctx.fillRect(84, y + 11, 8, 8);
    ctx.fillStyle = theme[2];
    const lines = wrapCanvasText(ctx, bullet, visual ? 620 : 1060, 2);
    for (const line of lines) {
      ctx.fillText(line, 112, y);
      y += 34;
    }
    y += 10;
  }
  if (slide.note) {
    ctx.fillStyle = `${theme[2]}99`;
    ctx.font = '400 19px "Segoe UI", system-ui, sans-serif';
    const note = wrapCanvasText(ctx, slide.note, visual ? 620 : 1080, 2);
    note.forEach((line, noteIndex) => ctx.fillText(line, 80, height - 116 + noteIndex * 24));
  }
  if (visual) {
    const boxX = 770;
    const boxY = 158;
    const boxW = 430;
    const boxH = 320;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(boxX - 8, boxY - 8, boxW + 16, boxH + 16);
    const scale = Math.min(boxW / Math.max(1, visual.naturalWidth || visual.width), boxH / Math.max(1, visual.naturalHeight || visual.height));
    const drawW = Math.max(1, Math.round((visual.naturalWidth || visual.width) * scale));
    const drawH = Math.max(1, Math.round((visual.naturalHeight || visual.height) * scale));
    const drawX = boxX + Math.round((boxW - drawW) / 2);
    const drawY = boxY + Math.round((boxH - drawH) / 2);
    ctx.drawImage(visual, drawX, drawY, drawW, drawH);
    for (const mark of (slide.image.marks || []).slice(0, 8)) {
      const mx = drawX + (drawW * Math.max(0, Math.min(100, Number(mark.x) || 0))) / 100;
      const my = drawY + (drawH * Math.max(0, Math.min(100, Number(mark.y) || 0))) / 100;
      ctx.beginPath();
      ctx.fillStyle = theme[1];
      ctx.arc(mx, my, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = theme[0];
      ctx.font = '700 13px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(mark.number || ''), mx, my + 1);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }
    ctx.fillStyle = `${theme[2]}bb`;
    ctx.font = '400 15px "Segoe UI", system-ui, sans-serif';
    const caption = wrapCanvasText(ctx, slide.image.caption || 'Current evidence', 430, 2);
    caption.forEach((line, lineIndex) => ctx.fillText(line, boxX, boxY + boxH + 18 + lineIndex * 19));
  }
  ctx.fillStyle = `${theme[2]}22`;
  ctx.fillRect(80, height - 42, width - 160, 5);
  ctx.fillStyle = theme[1];
  ctx.fillRect(80, height - 42, ((width - 160) * (index + 1)) / deck.slides.length, 5);
}

async function renderDeckVideo(deck) {
  if (ui.videoBusy) return;
  if (typeof MediaRecorder === 'undefined') {
    ui.videoError = 'This browser cannot record video. Use Chrome or Edge.';
    render();
    return;
  }
  ui.videoBusy = true;
  ui.videoError = '';
  if (ui.videoUrl) URL.revokeObjectURL(ui.videoUrl);
  ui.videoUrl = null;
  ui.videoDeckId = null;
  render();
  try {
    const imageUrls = [...new Set((deck.slides || []).map((slide) => slide.image?.url).filter(Boolean))];
    await Promise.all(
      imageUrls.map(
        (url) =>
          new Promise((resolve) => {
            if (deckImageCache.has(url)) return resolve();
            const image = new Image();
            image.onload = () => {
              deckImageCache.set(url, image);
              resolve();
            };
            image.onerror = () => resolve();
            image.src = url;
          })
      )
    );
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(30);
    const track = stream.getVideoTracks()[0];
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2200000 } : undefined);
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    const finished = new Promise((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = (event) => reject(event.error || new Error('Video recording failed'));
    });
    const secondsPerSlide = Math.max(3.2, Math.min(8, (deck.durationSeconds || deck.slides.length * 5) / deck.slides.length));
    const totalMs = secondsPerSlide * deck.slides.length * 1000;
    let start = performance.now();
    drawDeckFrame(ctx, deck, 0);
    track?.requestFrame?.();
    recorder.start(120);
    await new Promise((resolve) => {
      const frame = () => {
        const elapsed = performance.now() - start;
        const index = Math.min(deck.slides.length - 1, Math.floor(elapsed / (secondsPerSlide * 1000)));
        drawDeckFrame(ctx, deck, index);
        track?.requestFrame?.();
        const status = document.getElementById('deck-video-status');
        if (status) status.textContent = `Rendering ${Math.min(100, Math.round((elapsed / totalMs) * 100))}% · slide ${index + 1} of ${deck.slides.length}`;
        if (elapsed >= totalMs) return resolve();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    recorder.stop();
    await finished;
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: mime || 'video/webm' });
    if (!blob.size) throw new Error('The browser returned an empty video');
    ui.videoUrl = URL.createObjectURL(blob);
    ui.videoDeckId = deck.id;
    toast('Presentation video ready', 'ok');
  } catch (err) {
    ui.videoError = err.message || 'Could not render the video';
    toast(ui.videoError, 'error');
  } finally {
    ui.videoBusy = false;
    render();
  }
}

function renderSimulationCard(sim) {
  if (!sim) return '';
  const summary = sim.summary || null;
  const verdict = summary?.verdict || '';
  const verdictBadge = verdict === 'agrees' ? 'okbadge' : verdict === 'disagrees' ? 'warnbadge' : '';
  const stepBadge = (value) =>
    value === 'confirmed' ? 'okbadge' : value === 'mismatch' || value === 'unreadable' || value === 'failed_with_change' ? 'warnbadge' : '';
  const rows = (sim.breakdown || []).slice(0, 8);
  const proposals = (ui.data.proposals || []).filter((proposal) => proposal.workflowId === sim.workflowId);
  const review = ui.observationReview?.simulationId === sim.id ? ui.observationReview.result : null;
  const profile = review?.profile;
  const staticReview = review?.proposalReview;
  const list = (items) => items.length ? `<ul class="rule-list">${items.map((item) => `<li>${esc(item.detail)}</li>`).join('')}</ul>` : '<span class="dim">None reported.</span>';
  return `<div class="hint-box small sim-card">
    <div class="row wrap" style="gap:6px">
      <b>Screenshot check</b>
      ${statusPill(sim.status)}
      ${verdict ? `<span class="badge ${verdictBadge}">${esc(verdict)}</span>` : ''}
      ${sim.coverage ? `<span class="badge">${Number(sim.coverage.withFrames) || 0}/${Number(sim.coverage.steps) || 0} steps covered</span>` : ''}
      ${summary ? `<span class="dim small">${Number(summary.confirmed) || 0} confirmed · ${Number(summary.mismatch) || 0} mismatch · ${Number(summary.missing) || 0} uncovered</span>` : ''}
    </div>
    ${sim.status === 'running' ? '<p class="dim small" style="margin:5px 0 0">Reading the captured frames in the background — no desktop input.</p>' : ''}
    ${sim.error ? `<p class="small" style="color:var(--bad);margin:5px 0 0">${esc(sim.error)}</p>` : ''}
    ${rows.length ? `<div class="stack" style="gap:3px;margin-top:6px">${rows
      .map((entry) => `<div class="cc-event"><span class="badge ${stepBadge(entry.verdict)}">${esc(entry.verdict)}</span><span class="small">${Number(entry.seq) || 0}. ${esc(entry.name || 'step')}${entry.changedPct != null ? ` · ${entry.changedPct}% changed` : ''}${entry.frames ? ` · ${entry.frames} frame(s)` : ''}</span></div>`)
      .join('')}</div>` : ''}
    ${(sim.suggestions || []).length ? `<div class="stack" style="gap:3px;margin-top:6px">${sim.suggestions
      .slice(0, 4)
      .map((item) => `<div class="dim small">• ${esc(item)}</div>`)
      .join('')}</div>` : ''}
    <div class="section-gap"><b>Evidence profile</b>
      <p class="dim small">Read-only, local review of stored records. Monitor events are global and may contain sensitive window titles and capture paths; they are not tied to this run. No model or desktop action is used.</p>
      <label class="field"><span>Optional recent workflow proposal</span><select id="observation-proposal" data-scope="observation-proposal" data-id="${esc(sim.id)}" ${ui.observationReviewBusy ? 'disabled' : ''}><option value="">No proposal</option>${proposals.map((proposal) => `<option value="${esc(proposal.id)}" ${ui.observationProposal.simulationId === sim.id && ui.observationProposal.proposalId === proposal.id ? 'selected' : ''}>${esc(proposal.id)} · ${esc(proposal.status)}</option>`).join('')}</select></label>
      <button class="btn btn-sm" data-act="observation-review" data-id="${esc(sim.id)}" ${ui.observationReviewBusy ? 'disabled' : ''}>${ui.observationReviewBusy ? 'Loading…' : 'Load evidence profile'}</button>
      ${profile ? `<div class="stack" style="gap:6px;margin-top:8px">
        <div><b>Provenance:</b> simulation ${esc(profile.provenance.simulation?.id || '—')} · run ${esc(profile.provenance.simulation?.runId || '—')} · ${esc(profile.provenance.simulation?.status || 'unknown')} · ${esc(profile.provenance.simulation?.mode || 'unknown mode')} · ${esc(profile.provenance.simulation?.method || 'unknown method')}<br>Monitor ${profile.provenance.monitor?.running ? 'running' : 'not running'} · ${profile.observations.monitor.length} event(s), ${profile.observations.steps.length} step(s) · omitted ${profile.truncation.monitorEventsOmitted} event(s), ${profile.truncation.simulationStepsOmitted} step(s).</div>
        <div><b>Missing evidence</b>${list(profile.missingEvidence)}</div>
        <div><b>Uncertainty and limitations</b>${list(profile.uncertainty)}</div>
        <div><b>Suggested next steps</b>${list(profile.proposedNextSteps)}</div>
        ${staticReview ? `<div><b>Bounded static proposal check: ${esc(staticReview.staticTest.status)}</b><ul class="rule-list">${staticReview.staticTest.checks.map((check) => `<li>${check.ok ? '✓' : '✕'} ${esc(check.label)}${check.warningOnly ? ' (warning only)' : ''}</li>`).join('')}</ul>${staticReview.staticTest.failures.map((failure) => `<div>${esc(failure.name || 'Step')}: ${esc(failure.reason)}</div>`).join('')}<p class="dim small">${esc(staticReview.limitations)} Omitted: ${staticReview.truncation.stepsOmitted} steps, ${staticReview.truncation.preflightOmitted} preflight checks, ${staticReview.truncation.lintIssuesOmitted} lint issues.</p><button class="btn btn-sm btn-ghost" data-act="observation-proposal-open" data-id="${esc(staticReview.proposalId)}" data-workflow="${esc(sim.workflowId)}">Open proposal in workflow for separate review / approval</button></div>` : ''}
      </div>` : ''}
    </div>
  </div>`;
}

function renderTestReviewCard(record) {
  if (!record) {
    return '<p class="muted small">No review yet. Build one to break the run into individual tests, compare it with the steps that worked before, and check whether it would survive another environment.</p>';
  }
  const verdictBadge = record.verdict === 'ready' ? 'okbadge' : record.verdict === 'blocked' ? 'warnbadge' : '';
  const counts = record.counts || {};
  const evidence = record.evidence || {};
  const cross = record.crossRef || {};
  const alt = record.altEnv || {};
  const apps = record.apps || { immediate: [], longTerm: [] };
  const riskBadge = (risk) => (risk >= 75 ? 'warnbadge' : risk >= 45 ? '' : 'okbadge');
  const rows = (record.tests || []).slice(0, 12);
  const appLine = (entry) => `<div class="cc-event"><span class="badge">${esc(entry.effort || 'app')}</span><span class="small"><b>${esc(entry.name)}</b> — ${esc(entry.why)}</span></div><div class="dim small" style="margin:2px 0 5px 6px">${esc(entry.next)}</div>`;
  return `<div class="hint-box small sim-card">
    <div class="row wrap" style="gap:6px">
      <b>Test review</b>
      <span class="badge ${verdictBadge}">${esc(record.verdict || 'unknown')}</span>
      <span class="badge">${Number(counts.tests) || 0} tests</span>
      <span class="badge okbadge">${Number(counts.passed) || 0} passed</span>
      ${counts.failed ? `<span class="badge warnbadge">${counts.failed} failed</span>` : ''}
      <span class="badge">${Number(counts.checks) || 0} checks</span>
      <span class="dim small">evidence ${Number(evidence.coveragePct) || 0}%</span>
    </div>
    ${(record.review?.summary || []).map((line) => `<div class="dim small" style="margin-top:4px">• ${esc(line)}</div>`).join('')}
    ${(record.phases || []).length ? `<div class="chip-row" style="margin-top:5px">${record.phases.map((phase) => `<span class="badge">${esc(phase.label)} · ${Number(phase.tests) || 0}${phase.highRisk ? ` · ${phase.highRisk} at risk` : ''}</span>`).join('')}</div>` : ''}
    <div style="margin-top:8px"><b>Now (reuse what is ready)</b>${apps.immediate.length ? apps.immediate.slice(0, 3).map(appLine).join('') : '<div class="dim small">Nothing is ready to reuse yet.</div>'}</div>
    <div style="margin-top:6px"><b>Long term (needs setup)</b>${apps.longTerm.length ? apps.longTerm.slice(0, 3).map(appLine).join('') : '<div class="dim small">No extra app is required.</div>'}</div>
    <div style="margin-top:8px"><b>Compared with previous steps · ${esc(cross.verdict || 'first_run')}</b>${(cross.summary || []).map((line) => `<div class="dim small" style="margin-top:2px">• ${esc(line)}</div>`).join('')}${(cross.newDetails || []).slice(0, 2).map((entry) => `<div class="small" style="margin-top:2px">new · ${esc(entry.detail)}</div>`).join('')}</div>
    <div style="margin-top:8px"><b>Alternate environment · ${esc(alt.summary?.verdict || 'not checked')}</b><div class="dim small" style="margin-top:2px">${Number(alt.summary?.holds) || 0} hold · ${Number(alt.summary?.reused) || 0} reused · ${Number(alt.summary?.diverged) || 0} diverge · ${Number(alt.summary?.blocked) || 0} blocked · ${Number(alt.summary?.portable) || 0}% portable</div></div>
    ${rows.length ? `<div class="stack" style="gap:3px;margin-top:8px">${rows.map((test) => `<div class="cc-event"><span class="badge ${riskBadge(test.risk)}">${esc(test.status)}</span><span class="badge">${esc(test.kind)}</span><span class="small">${Number(test.seq) || 0}. ${esc(test.name)} · ${esc(test.phase)} · risk ${Number(test.risk) || 0}${test.evidence?.verdict ? ` · ${esc(test.evidence.verdict)}` : ''}${(test.riskReasons || []).length ? ` · ${esc(test.riskReasons.join(', '))}` : ''}</span></div>`).join('')}</div>${(record.tests || []).length > rows.length ? `<div class="dim small" style="margin-top:3px">+${(record.tests || []).length - rows.length} more test(s) in this review.</div>` : ''}` : '<div class="dim small" style="margin-top:6px">This run has no steps to review.</div>'}
    ${(record.suggestions?.now || []).length ? `<div style="margin-top:8px"><b>Do now</b>${record.suggestions.now.map((line) => `<div class="dim small">• ${esc(line)}</div>`).join('')}</div>` : ''}
    ${(record.suggestions?.later || []).length ? `<div style="margin-top:5px"><b>Do later</b>${record.suggestions.later.map((line) => `<div class="dim small">• ${esc(line)}</div>`).join('')}</div>` : ''}
  </div>`;
}

function renderPresentation() {
  const d = ui.data;
  const workflows = d.workflows || [];
  const missions = d.missions || [];
  if (!workflows.length) {
    return emptyState('No workflows to present', 'Create a workflow, then generate a walkthrough or troubleshooting deck.', '<button class="btn btn-primary" data-act="new-workflow">＋ New workflow</button>');
  }
  if (!ui.presentationWorkflow || !workflows.some((workflow) => workflow.id === ui.presentationWorkflow)) {
    ui.presentationWorkflow = workflows.find((workflow) => workflow.id === ui.selectedWorkflow)?.id || workflows[0].id;
  }
  const wf = workflows.find((workflow) => workflow.id === ui.presentationWorkflow);
  const sessions = missions.filter((mission) => mission.workflowId === wf.id);
  const selectedId = sessions.some((mission) => mission.id === ui.presentationMission) ? ui.presentationMission : sessions[0]?.id || null;
  const p = selectedId && ui.presentation && ui.presentation.id === selectedId ? ui.presentation : null;
  // Live run telemetry: independent of whether a session/deck exists yet.
  const wfRuns = (d.runs || []).filter((run) => run.workflowId === wf.id);
  const liveRun = wfRuns.find((run) => ['running', 'queued'].includes(run.status)) || wfRuns[0] || null;
  const liveActive = Boolean(liveRun && ['running', 'queued'].includes(liveRun.status));
  const livePresenter = liveRun && d.presenter && d.presenter.runId === liveRun.id ? d.presenter : null;
  const liveTouched = liveRun ? Number(liveRun.passed || 0) + Number(liveRun.failed || 0) : 0;
  const livePct = liveRun && liveRun.total ? Math.round((liveTouched / liveRun.total) * 100) : 0;
  const liveStep = liveRun?.position?.step?.name || livePresenter?.current?.name || '';
  const liveNext = liveRun?.position?.next?.name || livePresenter?.next?.name || '';
  const liveFacts = (livePresenter?.observations || []).slice(0, 3);
  const liveFailed = (liveRun?.failedSteps || []).slice(0, 3);
  const sim = liveRun && ui.sim && ui.sim.runId === liveRun.id ? ui.sim.record : null;
  const liveCard = liveRun
    ? `<section class="card section-gap">
        <div class="card-head"><div><h3 style="margin:0">${liveActive ? 'Live run' : 'Latest run'}</h3><p class="dim small" style="margin-top:3px">updates with every poll · ${esc(liveRun.trigger || 'manual')} · ${liveRun.dryRun ? 'simulated' : 'live'}</p></div>
          <div class="row wrap" style="gap:6px">${statusPill(liveRun.status)}${liveRun.paused ? '<span class="badge warnbadge">paused</span>' : ''}<button class="btn btn-sm btn-ghost" data-act="select-run" data-id="${esc(liveRun.id)}">Open run</button></div></div>
        <div class="card-body stack" style="gap:9px">
          <div class="cc-meter" title="${liveTouched}/${liveRun.total || 0} steps settled"><i style="width:${livePct}%"></i></div>
          <div class="chip-row">
            <span class="badge">${liveTouched}/${liveRun.total || 0} steps</span>
            <span class="badge okbadge">${Number(liveRun.passed || 0)} passed</span>
            ${liveRun.failed ? `<span class="badge warnbadge">${liveRun.failed} failed</span>` : ''}
            <span class="badge">${Number(liveRun.evidenceCount || 0)} evidence</span>
            ${liveRun.repairCount ? `<span class="badge">${liveRun.repairCount} repair(s)</span>` : ''}
            <span class="mono small dim">${esc(liveRun.id)}</span>
          </div>
          <div class="hint-box small">
            <b>Now:</b> ${esc(liveStep || (liveActive ? 'waiting for the next step' : 'run finished'))}${liveNext ? `<br><b>Next:</b> ${esc(liveNext)}` : ''}
            ${liveRun.presence?.holding ? `<br><b style="color:var(--warn,#b58900)">Waiting for your desktop to go quiet</b> — ${esc(liveRun.presence.reason || 'waiting for the desktop')}${Number(liveRun.presence.deferredMs) > 0 ? ` · held ${Math.round(Number(liveRun.presence.deferredMs) / 1000)}s so far` : ''} — press <b>Run now anyway</b> to take focus immediately.` : ''}
            ${liveRun.position ? `<br><span class="dim">position ${Number(liveRun.position.stepNumber) || 0}/${Number(liveRun.position.total) || liveRun.total || 0} · ${esc(liveRun.position.phase || '')}</span>` : ''}
          </div>
          ${liveFacts.length ? `<div class="stack" style="gap:4px">${liveFacts.map((fact) => `<div class="cc-event"><span class="badge">${esc(fact.level || 'note')}</span><span class="small">${esc(fact.message || '')}</span></div>`).join('')}</div>` : ''}
          ${liveFailed.length ? `<div class="stack" style="gap:4px">${liveFailed.map((step) => `<div class="cc-note"><strong class="small">${esc(step.name || 'step')}</strong><p class="small" style="color:var(--bad);margin-top:3px">${esc(step.error || 'failed without an error message')}</p></div>`).join('')}</div>` : ''}
          ${liveRun.followup ? `<div class="hint-box small"><b>Independent check:</b> ${liveRun.followup.ok ? 'passed' : 'failed'} — ${esc(liveRun.followup.summary || '')}</div>` : ''}
          ${renderSimulationCard(sim)}
          <div class="row wrap" style="gap:6px">
            ${liveActive ? `<button class="btn btn-sm" data-act="run-control" data-id="${esc(liveRun.id)}" data-cmd="pause" ${liveRun.paused ? 'disabled' : ''}>Pause</button><button class="btn btn-sm" data-act="run-control" data-id="${esc(liveRun.id)}" data-cmd="skip">Skip step</button><button class="btn btn-sm" data-act="run-control" data-id="${esc(liveRun.id)}" data-cmd="continue" ${liveRun.paused ? '' : 'disabled'}>Resume</button>${liveRun.presence?.holding ? `<button class="btn btn-sm btn-primary" data-act="run-control" data-id="${esc(liveRun.id)}" data-cmd="bypass" title="Skip the presence wait and take focus right away">Run now anyway</button>` : ''}<button class="btn btn-sm btn-danger" data-act="cancel-run" data-id="${esc(liveRun.id)}">Cancel</button>` : `<button class="btn btn-sm" data-act="run-workflow" data-id="${esc(wf.id)}" data-mode="${liveRun.dryRun ? 'dry' : 'live'}">Run again</button>`}
            <button class="btn btn-sm btn-ghost" data-act="run-simulate" data-id="${esc(liveRun.id)}" ${ui.simBusy ? 'disabled' : ''}>Screenshot check</button>
            <button class="btn btn-sm btn-ghost" data-act="presentation-capture">Capture desktop now</button>
          </div>
        </div>
      </section>`
    : '<section class="card section-gap"><div class="card-head"><h3>No run yet</h3><span class="dim small">the deck will cite real runs</span></div><div class="card-body"><p class="muted small">Run this workflow once and the live view will track every step here, without needing a session.</p></div></section>';
  const workflowOptions = workflows
    .map((workflow) => `<option value="${workflow.id}" ${workflow.id === wf.id ? 'selected' : ''}>${esc(workflow.name)} · ${workflow.steps.length} steps</option>`)
    .join('');
  const missionOptions = sessions.length
    ? sessions
        .map((mission) => `<option value="${mission.id}" ${mission.id === selectedId ? 'selected' : ''}>${esc(mission.status)} · ${fmtTime(mission.createdAt)} · ${esc(mission.goal.slice(0, 70))}</option>`)
        .join('')
    : '<option value="">No sessions yet</option>';
  const head = `
  <div class="page-head">
    <div>
      <h1>Presentation</h1>
      <p>Every workflow has a review surface: choose a workflow for its steps, sessions, AI slideshow and short video; choose a session for visual evidence and the next decision.</p>
    </div>
    <div class="page-head-actions">
      <select data-scope="presentation" data-key="workflowId" aria-label="Workflow">${workflowOptions}</select>
      <select data-scope="presentation" data-key="missionId" aria-label="Session" ${sessions.length ? '' : 'disabled'}>${missionOptions}</select>
      <button class="btn btn-sm btn-ghost" data-act="presentation-to-command" data-id="${selectedId || ''}" ${selectedId ? '' : 'disabled'}>Command Center</button>
      <button class="btn btn-sm btn-ghost" data-nav="continuity">Continuity</button>
      <button class="btn btn-sm btn-ghost" data-act="presentation-refresh">Refresh</button>
    </div>
  </div>`;
  if (!p) {
    if (selectedId && ui.presentationLoading) {
      return head + '<div class="empty"><span class="spinner"></span> Loading the session evidence…</div>';
    }
    if (selectedId && selectedId === ui.presentationMission && ui.presentationError) {
      return head + `<div class="stack">${renderDeckPanel(wf)}<div class="hint-box" style="color:var(--bad)">${esc(ui.presentationError)}</div></div>`;
    }
    return head + liveCard + renderWorkflowPresentation(wf, sessions);
  }
  const active = MISSION_ACTIVE.includes(p.status);
  const verdict = p.verdict || 'pending';
  const confidence = p.confidence != null ? `${Math.round(p.confidence * 100)}%` : '—';
  const lastRunId = p.workpoints[p.workpoints.length - 1]?.runId || null;
  const wpFilter = ui.workpointFilter || 'all';
  const workpoints = p.workpoints
    .map((run) => ({
      ...run,
      steps: run.steps.filter((step) =>
        wpFilter === 'failed' ? step.status === 'failed' : wpFilter === 'evidence' ? step.evidenceCount > 0 : true
      ),
    }))
    .filter((run) => run.steps.length);
  const auto = p.autoAct || {};
  const formInput = (key, value, placeholder = '') =>
    `<input type="text" data-scope="presentation" data-key="${key}" value="${esc(value || '')}" placeholder="${esc(
      placeholder
    )}" style="flex:1" />`;
  const decisionForms = `
    ${ui.decisionForm === 'alt' ? `<div class="hint-box" style="margin-top:8px"><label class="field"><span>Alternative path instruction</span><textarea rows="2" data-scope="presentation" data-key="instruction" placeholder="Try the direct URL, wait for the token element, then capture before typing.">${esc(
      ui.decisionDraft?.instruction || ''
    )}</textarea></label><button class="btn btn-sm btn-primary" data-act="decision-retry-alt">Retry with this path</button></div>` : ''}
    ${ui.decisionForm === 'goal' ? `<div class="hint-box" style="margin-top:8px"><label class="field"><span>Alternative goal / subgoal</span>${formInput(
      'goal',
      ui.decisionDraft?.goal || p.goal
    )}</label><button class="btn btn-sm btn-primary" data-act="decision-alt-goal">Start with this goal</button></div>` : ''}
    ${ui.decisionForm === 'workflow' ? `<div class="hint-box" style="margin-top:8px"><label class="field"><span>Alternative workflow</span><select data-scope="presentation" data-key="workflowId">${d.workflows
      .map((w) => `<option value="${w.id}" ${w.id === (ui.decisionDraft?.workflowId || p.workflowId) ? 'selected' : ''}>${esc(w.name)} · ${w.steps.length} steps</option>`)
      .join('')}</select></label><label class="field"><span>Goal for the alternative workflow</span>${formInput(
      'goal',
      ui.decisionDraft?.goal || p.goal
    )}</label><button class="btn btn-sm btn-primary" data-act="decision-alt-workflow">Start alternative workflow</button></div>` : ''}`;
  const fileRows = p.files.length
    ? p.files
        .slice(0, 12)
        .map(
          (file) => `<tr><td><a class="mono small" href="${file.url}" target="_blank" rel="noopener">${esc(
            file.caption
          )}</a></td><td class="mono small dim">${esc(file.path)}</td><td>${
            file.simulated ? '<span class="badge warnbadge">simulated</span>' : '<span class="badge okbadge">live</span>'
          }</td><td class="dim small">${esc(file.stepName || '')}</td><td class="dim small">${fmtTime(file.at)}</td></tr>`
        )
        .join('')
    : '';
  return `
  ${head}
  <div class="stack">
    ${liveCard}
    ${renderDeckPanel(wf)}
    <div class="card">
      <div class="card-head">
        <div><h3 style="margin:0">${esc(p.workflowName)}</h3><p class="dim small" style="margin-top:3px">${esc(p.goal)}</p></div>
        <div class="row wrap" style="gap:6px">${statusPill(p.status)}${p.paused ? '<span class="badge warnbadge">paused</span>' : ''}${modeBadge(p.mode !== 'live')}<span class="badge ${
    verdict === 'on_target' ? 'okbadge' : verdict === 'off_target' ? 'warnbadge' : ''
  }">verdict · ${esc(verdict)}</span><span class="badge">${confidence}</span></div>
      </div>
      <div class="card-body">
        <div class="chip-row" style="margin-bottom:9px">
          <span class="badge">${p.attempts}/${p.maxAttempts} attempts</span>
          <span class="badge">${p.workpoints.length} run(s)</span>
          <span class="badge">${p.files.length} saved file(s)</span>
          <span class="badge">${p.conversation.length} events</span>
          <span class="badge">${p.questions.length} open question(s)</span>
        </div>
        ${p.context ? `<details class="hint-box" style="margin-bottom:9px"><summary><strong>Forwarded failure context</strong></summary><pre class="small" style="white-space:pre-wrap;margin:6px 0 0">${esc(p.context)}</pre></details>` : ''}
        <div class="hint-box">
          <strong>Next step · ${esc(p.proposal.label)}</strong>
          <p class="small" style="margin-top:4px">${esc(p.proposal.reason)}</p>
          <p class="dim small" style="margin-top:4px">Habit confidence ${auto.confidence ?? p.proposal.confidence}% · threshold ${auto.threshold}% · auto-act ${
    auto.enabled ? 'on' : 'off'
  }</p>
          <div class="row wrap" style="gap:6px;margin-top:8px">
            ${
              active
                ? `<button class="btn btn-sm btn-primary" data-act="decision-pause" ${p.paused ? 'disabled' : ''}>Pause</button><button class="btn btn-sm btn-ghost" data-act="decision-skip">Skip step</button><button class="btn btn-sm btn-ghost" data-act="decision-continue">${p.paused ? 'Resume' : 'Continue'}</button><button class="btn btn-sm btn-ghost" data-act="decision-check">Verify now</button>`
                : '<button class="btn btn-sm btn-primary" data-act="decision-retry">Retry</button><button class="btn btn-sm" data-act="decision-retry-alt">Retry with alternative path</button><button class="btn btn-sm btn-ghost" data-act="decision-form" data-form="alt">Describe alt path</button>'
            }
            <button class="btn btn-sm btn-ghost" data-act="decision-form" data-form="goal">Alternative goal</button>
            <button class="btn btn-sm btn-ghost" data-act="decision-form" data-form="workflow">Alternative workflow</button>
            <button class="btn btn-sm btn-ghost" data-act="decision-ask">Queue question</button>
            <button class="btn btn-sm btn-danger" data-act="decision-stop" title="Cancel the session; use only for an emergency stop.">Emergency stop</button>
            <button class="btn btn-sm ${auto.eligible ? 'btn-primary' : ''}" data-act="presentation-auto" ${auto.eligible ? '' : 'disabled'} title="${esc(auto.eligible ? 'Apply the habit proposal' : auto.reason || 'Auto-act is not eligible')}">Auto-act · ${auto.confidence}%</button>
          </div>
          ${decisionForms}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Notes to the active agent</h3><span class="dim small">steer the route while it runs</span></div>
      <div class="card-body">
        <textarea rows="3" data-scope="presentationnote" placeholder="Tell the supervisor what to change: use the direct URL, click play, wait for the player, skip the outage step…">${esc(ui.presentationNote || '')}</textarea>
        <div class="row wrap" style="gap:6px;margin-top:8px">
          <button class="btn btn-sm btn-primary" data-act="send-note" data-id="${p.id}" data-apply="1" ${active ? '' : 'disabled'}>Send &amp; reprogram route</button>
          <button class="btn btn-sm btn-ghost" data-act="send-note" data-id="${p.id}" data-apply="0">Send as note only</button>
          <span class="dim small">${active ? 'Applied before the next supervisor attempt; current step is not interrupted.' : 'Session ended — use Retry or Describe alt path to run a changed route.'}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Important elements</h3><span class="dim small">what the verification actually establishes</span></div>
      <div class="card-body stack" style="gap:6px">
        ${p.elements
          .map(
            (el) => `<div class="cc-event"><span class="badge">${esc(el.label)}</span><span class="small">${esc(el.value)}</span></div>`
          )
          .join('')}
        ${p.summary ? `<p class="small" style="margin-top:6px">${esc(p.summary)}</p>` : ''}
      </div>
    </div>

    <div class="cc-layout">
      <div class="stack">
        <div class="card">
          <div class="card-head"><h3>Visual evidence</h3><span class="dim small">click to open the saved image</span></div>
          <div class="card-body">
            ${p.files.length
              ? `<div class="cc-shots">${p.files
                  .slice(0, 6)
                  .map(
                    (file) => `<figure class="cc-shot"><a href="${file.url}" target="_blank" rel="noopener"><img src="${file.url}" alt="${esc(
                      file.caption
                    )}" loading="lazy" /></a><figcaption><span class="badge">${file.simulated ? 'simulated' : 'live'}</span> ${esc(
                      file.caption
                    )}<span class="dim small"> · ${fmtTime(file.at)}</span></figcaption></figure>`
                  )
                  .join('')}</div>`
              : '<p class="muted small">No saved captures yet. Take one below to verify the desktop visually.</p>'}
            <div class="row wrap" style="gap:6px;margin-top:9px">
              <button class="btn btn-sm" data-act="presentation-capture">Capture desktop now</button>
              <button class="btn btn-sm btn-ghost" data-act="decision-check">Verify now (capture + check)</button>
              <button class="btn btn-sm btn-ghost" data-act="presentation-open-captures">All captures</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Saved files</h3><span class="dim small">${p.files.length}</span></div>
          <div class="card-body" style="overflow:auto">
            ${p.files.length
              ? `<table class="data-table"><thead><tr><th>File</th><th>Path</th><th>Source</th><th>Step</th><th>At</th></tr></thead><tbody>${fileRows}</tbody></table>`
              : '<p class="muted small">No files recorded for this session.</p>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Workpoints</h3><span class="dim small">every step, role and artifact</span></div>
          <div class="card-body stack" style="gap:10px">
            <div class="chip-row" style="margin-bottom:4px">
              ${[
                ['all', 'All steps'],
                ['failed', 'Failed'],
                ['evidence', 'With evidence'],
              ]
                .map(
                  ([key, label]) => `<button class="chip ${wpFilter === key ? 'active' : ''}" data-act="workpoint-filter" data-filter="${key}">${label}</button>`
                )
                .join('')}
            </div>
            ${workpoints
              .map(
                (run) => `<div>
                  <div class="row wrap" style="gap:6px;margin-bottom:5px"><span class="badge">${esc(
                    run.agentRole
                  )}</span>${statusPill(run.status)}<span class="mono small">${esc(run.runId)}</span><span class="dim small">${run.retryCount} retries</span></div>
                  <table class="data-table"><thead><tr><th>Step</th><th>Type</th><th>Outcome</th><th>Evidence</th></tr></thead><tbody>${run.steps
                    .map(
                      (step) => `<tr><td><strong>${esc(step.name)}</strong>${step.optional ? ' <span class="badge">optional</span>' : ''}${
                        step.error ? `<div class="small" style="color:var(--bad)">${esc(step.error)}</div>` : ''
                      }</td><td><span class="type-chip">${esc(step.type)}</span></td><td>${statusPill(
                        step.status
                      )}</td><td class="mono">${step.evidenceCount}</td></tr>`
                    )
                    .join('')}</tbody></table>
                </div>`
              )
              .join('') || '<p class="muted small">No runs yet.</p>'}
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><h3>Habits &amp; exclusions</h3><span class="dim small">learning from past attempts</span></div>
          <div class="card-body stack" style="gap:7px">
            ${p.habits.length
              ? p.habits
                  .map(
                    (habit) => `<div class="cc-note"><div class="row" style="gap:6px"><span class="badge">${habit.confidence}%</span><strong class="small">${esc(
                      habit.label
                    )}</strong></div><p class="dim small" style="margin-top:3px">${esc(habit.detail)}</p><div style="height:4px;background:var(--line);border-radius:2px;margin-top:5px"><div style="height:4px;width:${habit.confidence}%;background:var(--ok);border-radius:2px"></div></div></div>`
                  )
                  .join('')
              : '<p class="muted small">No habits yet. Habits appear after repeated runs, failures or learned fixes.</p>'}
            ${p.exclusions.length
              ? `<h4 class="mini-head" style="margin-top:4px">Exclude / replace</h4>${p.exclusions
                  .map(
                    (item) => `<div class="cc-note"><span class="badge warnbadge">${item.failures}×</span> <span class="small">${esc(
                      item.label
                    )}</span><span class="dim small"> · ${esc(item.type)} · ${esc(item.error || '')}</span></div>`
                  )
                  .join('')}`
              : ''}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Questions &amp; queue</h3><span class="dim small">hindrances to resolve</span></div>
          <div class="card-body stack" style="gap:6px">
            ${p.questions.length
              ? p.questions
                  .map(
                    (q) => `<div class="cc-note"><strong class="small">${esc(q.prompt)}</strong><div class="row wrap" style="gap:5px;margin-top:6px">${(q.options || [])
                      .map((option) => `<button class="btn btn-sm btn-ghost" data-act="decision-queue-option" data-option="${esc(option)}">${esc(option)}</button>`)
                      .join('')}</div></div>`
                  )
                  .join('')
              : '<p class="muted small">No open questions. The supervisor can continue or present.</p>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Conversation</h3><span class="dim small">${p.conversation.length} events · newest last</span></div>
          <div class="card-body" style="max-height:340px;overflow:auto">
            ${p.conversation
              .slice(-40)
              .map(
                (evt) => `<div class="cc-event"><span class="badge">${esc(evt.agent)}</span><span class="badge">${esc(evt.kind)}</span><span class="small">${esc(
                  evt.message
                )}</span><span class="dim small t">${fmtTime(evt.at)}</span></div>`
              )
              .join('') || '<p class="muted small">No events yet.</p>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Fix with AI</h3><span class="dim small">analysis, step factoring, apply</span></div>
          <div class="card-body">
            ${p.analysis
              ? `<p class="small">${esc(p.analysis.summary || p.analysis.review || 'Analysis complete.')}</p>${(p.analysis.suggestedSteps || [])
                  .map(
                    (step) => `<div class="cc-note"><span class="badge">${esc(step.type)}</span> <span class="small">${esc(step.name)}</span></div>`
                  )
                  .join('')}<button class="btn btn-sm btn-primary" style="margin-top:8px" data-act="presentation-apply-ai" data-run="${esc(
                  lastRunId || ''
                )}">Apply AI steps</button>`
              : `<p class="small muted">Ask the model to diagnose the last run and propose a step fix or reroute.</p><button class="btn btn-sm" data-act="presentation-analyze" data-run="${esc(
                  lastRunId || ''
                )}" ${lastRunId ? '' : 'disabled'}>Analyze failure with AI</button>`}
            <div style="margin-top:9px"><button class="btn btn-sm btn-ghost" data-act="presentation-redesign">Ask AI to redesign the workflow</button></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Decision log</h3><span class="dim small">${p.decisions.length}</span></div>
          <div class="card-body stack" style="gap:5px">
            ${p.decisions.length
              ? p.decisions
                  .slice(0, 10)
                  .map(
                    (entry) => `<div class="cc-note"><span class="badge">${esc(entry.action)}</span> <span class="small">${esc(
                      entry.instruction || ''
                    )}</span><span class="dim small"> · ${esc(entry.by)} · ${fmtTime(entry.at)}</span></div>`
                  )
                  .join('')
              : '<p class="muted small">No operator decisions yet.</p>'}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function renderElementLinks() {
  const d = ui.data;
  const links = d.elementLinks || [];
  const form = ui.linkForm;
  const workflows = d.workflows.filter((workflow) => workflow.steps.length);
  const selectedWorkflow = form.workflowId || workflows[0]?.id || '';
  const controlTypes = ['', 'Button', 'Link', 'Text', 'Edit', 'Document', 'Slider', 'CheckBox', 'ComboBox', 'ListItem', 'TabItem', 'Group', 'Pane', 'Window', 'Image'];
  if (form.controlType && !controlTypes.includes(form.controlType)) controlTypes.push(form.controlType);
  const workflowOptions = workflows
    .map((workflow) => `<option value="${workflow.id}" ${workflow.id === selectedWorkflow ? 'selected' : ''}>${esc(workflow.name)} · ${workflow.steps.length} steps</option>`)
    .join('');
  const rows = links.map((link) => {
    const workflow = d.workflows.find((entry) => entry.id === link.workflowId);
    return `<tr>
      <td><label class="check"><input type="checkbox" data-act="link-toggle" data-id="${link.id}" data-enabled="${link.enabled !== false ? '0' : '1'}" ${link.enabled !== false ? 'checked' : ''} /> ${esc(link.label || link.name)}</label>
        <div class="dim small mono">${esc(link.window)} · “${esc(link.name)}”${link.controlType ? ` · ${esc(link.controlType)}` : ''}</div></td>
      <td>${link.present ? '<span class="badge okbadge">present</span>' : '<span class="badge">absent</span>'}<div class="dim small">${link.mode === 'auto' ? 'auto' : 'suggest'} · ${link.action === 'mission' ? 'agent mission' : 'workflow run'}</div></td>
      <td>${esc(workflow?.name || 'missing workflow')}<div class="dim small">${link.lastTriggeredAt ? `last ${fmtTime(link.lastTriggeredAt)} · ${link.triggerCount || 0}×` : 'not triggered yet'}</div></td>
      <td><div class="row wrap" style="gap:5px"><button class="btn btn-sm" data-act="link-scan" data-id="${link.id}">Scan</button><button class="btn btn-sm btn-primary" data-act="link-trigger" data-id="${link.id}">React now</button><button class="btn btn-sm btn-ghost" data-act="link-delete" data-id="${link.id}">Delete</button></div></td>
    </tr>`;
  });
  return `
  <div class="page-head">
    <div>
      <h2>Element links</h2>
      <p>Bind a visible UI element to a workflow or supervised mission. The watcher checks linked elements every 5 seconds and acts only when an element appears, so the same screen does not retrigger in a loop.</p>
    </div>
    <div class="page-head-actions"><span class="badge">${links.filter((link) => link.mode === 'auto' && link.enabled !== false).length} auto</span></div>
  </div>
  <div class="card">
    <div class="card-head"><h3>Link an element</h3><span class="dim small">Windows UI Automation · no screenshot guessing</span></div>
    <div class="card-body">
      <div class="field-row">
        <label class="field"><span>Name</span><input type="text" data-scope="linkform" data-key="label" value="${esc(form.label)}" placeholder="Reply to the open chat" /></label>
        <label class="field"><span>Window title contains</span><input type="text" data-scope="linkform" data-key="window" value="${esc(form.window)}" placeholder="Chrome" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Element name contains</span><input type="text" data-scope="linkform" data-key="name" value="${esc(form.name)}" placeholder="Send" /></label>
        <label class="field"><span>Control type</span><select data-scope="linkform" data-key="controlType">${controlTypes.map((type) => `<option value="${type}" ${form.controlType === type ? 'selected' : ''}>${type || 'Any'}</option>`).join('')}</select></label>
      </div>
      <div class="row wrap" style="gap:8px;margin:-2px 0 12px">
        <button class="btn btn-sm" data-act="link-pick" ${ui.linkPicking ? 'disabled' : ''}>⌖ ${ui.linkPicking ? 'Waiting for focus…' : 'Pick focused element'}</button>
        <span class="help">Click, then switch to the target app and focus the control. It watches for 12 seconds and fills the window, element name and type.</span>
      </div>
      <div class="field-row">
        <label class="field"><span>Workflow</span><select data-scope="linkform" data-key="workflowId">${workflowOptions}</select></label>
        <label class="field"><span>Action</span><select data-scope="linkform" data-key="action"><option value="mission" ${form.action === 'mission' ? 'selected' : ''}>Supervised mission — inspect, plan, act</option><option value="run" ${form.action === 'run' ? 'selected' : ''}>Workflow run</option></select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Mode</span><select data-scope="linkform" data-key="mode"><option value="auto" ${form.mode === 'auto' ? 'selected' : ''}>Auto — react on appearance</option><option value="suggest" ${form.mode === 'suggest' ? 'selected' : ''}>Suggest only — show presence</option></select></label>
        <label class="field"><span>Cooldown (seconds)</span><input type="number" min="5" data-scope="linkform" data-key="cooldownSeconds" value="${Number(form.cooldownSeconds || 60)}" /></label>
      </div>
      <label class="field"><span>Goal / instruction (optional)</span><textarea rows="2" data-scope="linkform" data-key="goal" placeholder="When Send appears, review the message and reply with the approved answer.">${esc(form.goal)}</textarea></label>
      <button class="btn btn-primary" data-act="link-add">Create link</button>
    </div>
  </div>
  <div class="card">
    <div class="card-head"><h3>Linked elements</h3><span class="dim small">appearance → think → plan → act</span></div>
    <div class="card-body">
      ${rulesNote()}
      ${rows.length ? `<table class="table"><thead><tr><th>Element</th><th>State</th><th>Action</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p class="muted small">No links yet. Add one above; live actions follow the header mode (simulated or live).</p>'}
    </div>
  </div>`;
}

function rulesNote() {
  return '<p class="dim small" style="margin-bottom:10px">The watcher runs only when no run is active, ignores an element that was already present, and respects the cooldown. A supervised mission receives the matched element, window and coordinates in its context, so the agent can verify the screen and choose another method when the expected step does not trigger.</p>';
}

function renderCommandCenter() {
  const d = ui.data;
  const draft = missionDraft();
  const missions = d.missions || [];
  if (ui.selectedMission && !missions.some((m) => m.id === ui.selectedMission)) {
    ui.selectedMission = null;
    ui.missionDetail = null;
  }
  if (!ui.selectedMission && missions.length && !ui.missionLoading) {
    ui.missionLoading = true;
    loadMission(missions[0].id).finally(() => {
      ui.missionLoading = false;
    });
  }
  const detail = ui.missionDetail && ui.selectedMission && ui.missionDetail.id === ui.selectedMission ? ui.missionDetail : null;
  const active = detail ? MISSION_ACTIVE.includes(detail.status) : false;
  const draftWorkflow = d.workflows.find((workflow) => workflow.id === draft.workflowId);
  const draftStats = draftWorkflow?.stats || null;
  const eventFilter = ui.missionEventFilter;
  const sessionFilter = ui.missionSessionFilter;
  const query = String(eventFilter.q || '').trim().toLowerCase();
  const matchesView = (evt, view) => {
    if (view === 'errors') return eventSeverity(evt) === 'error';
    if (view === 'replans') return evt.kind === 'replan' || /replan/i.test(evt.message || '');
    if (view === 'security')
      return /security|login|sign[- ]?in|credential|password|permission|denied|unauthor|auth/i.test(
        `${evt.message || ''} ${evt.agent || ''}`
      );
    return true;
  };
  const viewMatches = (evt) => matchesView(evt, eventFilter.view);
  const eventRows = detail
    ? detail.events
        .filter(
          (evt) =>
            viewMatches(evt) &&
            (eventFilter.agent === 'all' || evt.agent === eventFilter.agent) &&
            (eventFilter.kind === 'all' || evt.kind === eventFilter.kind) &&
            (eventFilter.severity === 'all' || eventSeverity(evt) === eventFilter.severity) &&
            (!query || String(evt.message).toLowerCase().includes(query))
        )
        .sort((a, b) =>
          eventFilter.sort === 'oldest' ? String(a.at).localeCompare(String(b.at)) : String(b.at).localeCompare(String(a.at))
        )
        .slice(0, 80)
    : [];
  const eventAgents = detail ? [...new Set(detail.events.map((evt) => evt.agent))] : [];
  const eventKinds = detail ? [...new Set(detail.events.map((evt) => evt.kind))] : [];
  const recordRuns = detail
    ? (detail.runs || []).map((entry) => {
        const runId = typeof entry === 'string' ? entry : entry.runId || entry.id;
        return d.runs.find((run) => run.id === runId) || { id: runId, status: 'unknown', retryCount: 0, createdAt: null };
      })
    : [];
  const sessionRows = detail
    ? (detail.runs || [])
        .map((entry) => {
          const runId = typeof entry === 'string' ? entry : entry.runId || entry.id;
          return d.runs.find((run) => run.id === runId) || { id: runId, status: 'unknown', retryCount: 0, createdAt: null };
        })
        .filter((run) => sessionFilter.status === 'all' || run.status === sessionFilter.status)
        .sort((a, b) =>
          sessionFilter.sort === 'retries'
            ? Number(b.retryCount || 0) - Number(a.retryCount || 0)
            : String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
        )
    : [];

  const workflowOptions = d.workflows
    .map((w) => `<option value="${w.id}" ${w.id === draft.workflowId ? 'selected' : ''}>${esc(w.name)} · ${w.steps.length} steps</option>`)
    .join('');

  const composer = `
  <div class="card">
    <div class="card-head"><h3>Launch a mission</h3><span class="dim small">supervisor → planner → executors → verifier → reviewer</span></div>
    <div class="card-body">
      <div class="field-row">
        <label class="field"><span>Workflow</span><select data-scope="mission" data-key="workflowId">${workflowOptions}</select></label>
        <label class="field"><span>Mode</span><select data-scope="mission" data-key="mode">
          <option value="dry" ${draft.mode === 'dry' ? 'selected' : ''}>Simulated — no desktop input</option>
          <option value="live" ${draft.mode === 'live' ? 'selected' : ''}>Live — control this desktop</option>
        </select></label>
      </div>
      ${draftStats ? `<p class="dim small" style="margin:-4px 0 10px">Complexity ${draftStats.avgComplexity}/100 · flakiness ${draftStats.flakinessScore}% · ${draftStats.totalFailures7d} failure(s) in 7 days ${draftStats.requiresAdvancedPlanning ? '· <span class="badge ai">needs advanced planning</span>' : ''}</p>` : ''}
      <label class="field"><span>Mission goal — what must be true at the end?</span><textarea rows="2" data-scope="mission" data-key="goal" placeholder="Open Notepad, type the note, and confirm the window still shows the typed text.">${esc(
        draft.goal
      )}</textarea></label>
      <div class="field-row">
        <label class="field"><span>Attempts</span><input type="number" min="1" max="4" value="${Number(
          draft.maxAttempts
        )}" data-scope="mission" data-key="maxAttempts" /></label>
        <label class="field"><span>Check every (seconds)</span><input type="number" min="1" max="60" value="${Number(
          draft.checkSeconds
        )}" data-scope="mission" data-key="checkSeconds" /></label>
      </div>
      <label class="field"><span>Chat session</span><select data-scope="mission" data-key="newChatMode">
        <option value="auto" ${draft.newChatMode === 'auto' ? 'selected' : ''}>Auto — new chat unless the visible chat already contains the same question</option>
        <option value="new" ${draft.newChatMode === 'new' ? 'selected' : ''}>Always start a new chat/session</option>
        <option value="reuse" ${draft.newChatMode === 'reuse' ? 'selected' : ''}>Always reuse the current chat/session</option>
      </select><span class="help">Auto starts fresh when the current chat is empty or on another topic, but reuses it when the planned question is already visible and skips asking it twice. Explicit “Always new” overrides this; explicit “Always reuse” keeps the current session. Applies to workflow steps marked “only when a new chat/session is requested”.</span></label>
      <div class="row wrap" style="gap:14px;margin-bottom:10px">
        <label class="check"><input type="checkbox" data-scope="mission" data-key="vision" ${
          draft.vision ? 'checked' : ''
        } /> Vision cross-reference</label>
        <label class="check"><input type="checkbox" data-scope="mission" data-key="autoReplan" ${
          draft.autoReplan ? 'checked' : ''
        } /> Auto-replan</label>
        <label class="check"><input type="checkbox" data-scope="mission" data-key="useLearnedPatterns" ${
          draft.useLearnedPatterns ? 'checked' : ''
        } /> Reuse learned fixes</label>
        <label class="check"><input type="checkbox" data-scope="mission" data-key="observeEnabled" ${
          draft.observeEnabled ? 'checked' : ''
        } /> Observer / drifter</label>
        <label class="check"><input type="checkbox" data-scope="mission" data-key="autoApplyObserved" ${
          draft.autoApplyObserved ? 'checked' : ''
        } /> Auto-apply observed steps</label>
      </div>
      <div class="row wrap" style="gap:7px">
        <button class="btn btn-primary" data-act="mission-create" ${ui.missionBusy ? 'disabled' : ''}>${
    ui.missionBusy ? esc(ui.missionBusy) : '▶ Launch mission'
  }</button>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-ghost" data-act="new-workflow">New workflow</button>
        <button class="btn btn-sm btn-ghost" data-act="tool-new">New tool</button>
        <button class="btn btn-sm btn-ghost" data-act="tool-generate">AI tool</button>
        <button class="btn btn-sm btn-ghost" data-nav="examples">Examples</button>
      </div>
      <p class="dim small" style="margin-top:8px">The mission runs in the background with the tab closed. Every attempt is a normal queued run, so its evidence and step log are also in Test runs.</p>
    </div>
  </div>`;

  const list = missions.length
    ? missions
        .map(
          (m) => `<button class="cc-mission ${m.id === ui.selectedMission ? 'active' : ''}" data-act="mission-select" data-id="${m.id}">
            <div class="row" style="gap:6px"><strong>${esc(m.workflowName)}</strong>${m.trigger === 'failure' ? '<span class="badge">auto</span>' : ''}<span class="spacer"></span>${statusPill(m.status)}</div>
            <p class="small" style="margin-top:3px">${esc(String(m.goal).slice(0, 120))}</p>
            <span class="dim small">${m.attempts}/${m.maxAttempts} attempts · ${m.eventCount} events · ${fmtTime(m.createdAt)}</span>
          </button>`
        )
        .join('')
    : '<p class="muted small" style="padding:10px">No missions yet. Launch the first one above.</p>';

  const detailHtml = detail
    ? `
    <div class="card">
      <div class="card-head">
        <div><h3 style="margin:0">${esc(detail.workflowName)}</h3><p class="dim small" style="margin-top:3px">${esc(detail.goal)}</p></div>
        <div class="row wrap" style="gap:6px">${statusPill(detail.status)}${detail.paused ? '<span class="badge warnbadge">paused</span>' : ''}${modeBadge(detail.mode !== 'live')}${statusPill(
        detail.stage
      )}</div>
      </div>
      <div class="card-body">
        <div class="row wrap" style="gap:6px">
          ${active ? `<button class="btn btn-sm" data-act="mission-action" data-id="${detail.id}" data-cmd="pause" ${detail.paused ? 'disabled' : ''}>Pause</button>` : ''}
          ${detail.paused && active ? `<button class="btn btn-sm btn-primary" data-act="mission-action" data-id="${detail.id}" data-cmd="resume">Resume</button>` : ''}
          ${active ? `<button class="btn btn-sm" data-act="mission-action" data-id="${detail.id}" data-cmd="skip">Skip step</button>` : ''}
          ${active ? `<button class="btn btn-sm btn-ghost" data-act="mission-action" data-id="${detail.id}" data-cmd="continue">Continue</button>` : ''}
          ${active ? `<button class="btn btn-sm btn-ghost" data-act="mission-action" data-id="${detail.id}" data-cmd="cancel">Cancel</button>` : ''}
          <button class="btn btn-sm" data-act="mission-action" data-id="${detail.id}" data-cmd="check" ${ui.missionBusy ? 'disabled' : ''}>Check now</button>
          <button class="btn btn-sm" data-act="mission-action" data-id="${detail.id}" data-cmd="replan" ${ui.missionBusy ? 'disabled' : ''}>Research &amp; replan</button>
          ${!active ? `<button class="btn btn-sm" data-act="mission-action" data-id="${detail.id}" data-cmd="retry">Rerun mission</button>` : ''}
          ${detail.lastRunId ? `<button class="btn btn-sm btn-ghost" data-act="mission-open-run" data-id="${detail.lastRunId}">Open last run</button>` : ''}
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" data-act="open-presentation" data-id="${detail.id}">Presentation</button>
          <button class="btn btn-sm btn-ghost" data-act="open-knack">Knack mapping</button>
          <span class="dim small">${detail.checks.length} loop checks · ${detail.references.length} references · ${detail.events.length} events</span>
        </div>
        ${ui.missionBusy ? `<p class="small muted" style="margin-top:8px"><span class="spinner"></span> ${esc(ui.missionBusy)}</p>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Operator command</h3><span class="dim small">admin only · recorded in the event log</span></div>
      <div class="card-body">
        <div class="cc-filters">
          <select data-scope="command" data-key="command">
            ${['FORCE_REPLAN', 'OVERRIDE_PAUSE', 'OVERRIDE_RESUME', 'CHECKPOINT', 'CANCEL', 'RERUN']
              .map(
                (value) => `<option value="${value}" ${ui.commandDraft?.command === value ? 'selected' : ''}>${value}</option>`
              )
              .join('')}
          </select>
          <input type="text" placeholder="Reason (recorded with the command)" value="${esc(
            ui.commandDraft?.reason || ''
          )}" data-scope="command" data-key="reason" style="flex:1" />
          <button class="btn btn-sm btn-primary" data-act="operator-command" data-id="${detail.id}">Issue command</button>
        </div>
        <p class="dim small">${ui.auth?.authenticated
          ? `Signed in as ${esc(ui.auth.username)} · this command applies to the selected session.`
          : 'Sign in as admin to unlock privileged commands. The form stays visible so operators know what exists.'}</p>
        ${(detail.commands || []).length
          ? `<div class="stack" style="gap:6px;margin-top:8px">${detail.commands
              .slice(0, 6)
              .map(
                (entry) => `<div class="cc-note"><span class="badge">${esc(entry.command)}</span> <span class="small">${esc(
                  entry.reason || 'no reason'
                )}</span><span class="dim small"> · ${esc(entry.by)} · ${fmtTime(entry.at)}</span></div>`
              )
              .join('')}</div>`
          : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Note to the active agent</h3><span class="dim small">recorded in the conversation · can reprogram the route</span></div>
      <div class="card-body">
        <textarea rows="2" data-scope="presentationnote" placeholder="Example: the player is paused — click the centre of the video before waiting. Use the direct watch URL.">${esc(ui.presentationNote || '')}</textarea>
        <div class="row wrap" style="gap:6px;margin-top:8px">
          <button class="btn btn-sm btn-primary" data-act="send-note" data-id="${detail.id}" data-apply="1" ${active ? '' : 'disabled'}>Send &amp; steer active agent</button>
          <button class="btn btn-sm btn-ghost" data-act="send-note" data-id="${detail.id}" data-apply="0">Send as note only</button>
          <span class="dim small">${active ? 'The note is queued and applied before the next supervisor attempt.' : 'This session has ended; a note-only entry is recorded.'}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Supervisor brief</h3><span class="dim small">frame · verification · review · plan signals</span></div>
      <div class="card-body detail-cols">
        <div>
          <h4 class="mini-head">Held frame</h4>
          <p class="small">${detail.references.length ? `${detail.references.length} reference capture(s); baseline ${
            detail.frame?.baselinePath ? 'recorded' : 'pending'
          }.` : 'No frame captured yet.'}</p>
          <p class="dim small">${esc(detail.frame?.goal || detail.goal)}</p>
        </div>
        <div>
          <h4 class="mini-head">Verification</h4>
          <p class="small">${detail.verification ? `${esc(detail.verification.verdict)} · ${Math.round(
              (detail.verification.confidence || 0) * 100
            )}% confidence` : 'Pending'}</p>
          <p class="dim small">${esc(detail.verification?.summary || 'The verifier compares evidence with the goal before anything continues.')}</p>
        </div>
        <div>
          <h4 class="mini-head">Review &amp; next action</h4>
          <p class="small">${esc(detail.review?.summary ? detail.review.summary.slice(0, 190) : 'Final review pending.')}</p>
          ${(detail.review?.nextActions || []).length ? `<p class="dim small">Next: ${esc(detail.review.nextActions[0])}</p>` : ''}
        </div>
        <div>
          <h4 class="mini-head">Plan signals</h4>
          <p class="small">${detail.replans.length} replan(s) · ${detail.checks.length} loop check(s)</p>
          ${(() => {
            const stats = d.workflows.find((workflow) => workflow.id === detail.workflowId)?.stats;
            return stats
              ? `<p class="dim small">complexity ${stats.avgComplexity}/100 · flakiness ${stats.flakinessScore}% · ${stats.totalFailures7d} failures/7d${
                  stats.requiresAdvancedPlanning ? ' · advanced planning' : ''
                }</p>`
              : '<p class="dim small">No workflow analytics yet.</p>';
          })()}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Agent pipeline</h3><span class="dim small">each stage owns a sub-agent</span></div>
      <div class="card-body">${missionPipeline(detail.pipeline)}</div>
    </div>

    ${missionObserverPanels(detail)}

    <div class="cc-two">
      <div class="card">
        <div class="card-head"><h3>Held frame &amp; references</h3><span class="dim small">cross-referenced against the goal</span></div>
        <div class="card-body">
          <p class="small muted" style="margin-bottom:9px">${esc(detail.frame?.goal || detail.goal)}</p>
          ${detail.references.length ? `<div class="cc-shots">${detail.references.slice(-6).map(missionShot).join('')}</div>` : '<p class="muted small">No reference frames captured yet.</p>'}
          <button class="btn btn-sm btn-ghost" style="margin-top:9px" data-act="mission-action" data-id="${detail.id}" data-cmd="check" ${ui.missionBusy ? 'disabled' : ''}>Capture checkpoint now</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Verification</h3><span class="dim small">${esc(detail.verification?.source || 'pending')}</span></div>
        <div class="card-body">
          ${
            detail.verification
              ? `<div class="row" style="gap:7px">${statusPill(
                  detail.verification.verdict === 'on_target' ? 'passed' : 'failed',
                  detail.verification.verdict
                )}<span class="badge">${Math.round((detail.verification.confidence || 0) * 100)}% confidence</span></div>
                 <div class="cc-meter"><i style="width:${Math.round((detail.verification.confidence || 0) * 100)}%"></i></div>
                 <p class="small" style="margin-top:8px">${esc(detail.verification.summary || '')}</p>
                 ${(detail.verification.findings || []).length ? `<ul class="rule-list small">${detail.verification.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
                 ${(detail.verification.nextActions || []).length ? `<p class="dim small" style="margin-top:7px">Suggestions: ${esc(detail.verification.nextActions.join(' · '))}</p>` : ''}`
              : '<p class="muted small">The verifier runs after the first attempt and re-checks on every retry.</p>'
          }
        </div>
      </div>
    </div>

    <div class="cc-two">
      <div class="card">
        <div class="card-head"><h3>Loop progression</h3><span class="dim small">adaptive 1–15 s cadence</span></div>
        <div class="card-body" style="max-height:300px;overflow:auto">
          ${
            detail.checks.length
              ? `<table class="data-table"><thead><tr><th>#</th><th>Step / state</th><th>Progress</th><th>Interval</th></tr></thead><tbody>${detail.checks
                  .slice(0, 14)
                  .map(
                    (check) => `<tr><td class="mono">${check.tick}</td><td>${esc(check.step)}</td><td class="dim small">${esc(
                      check.note
                    )}</td><td class="mono">${check.intervalMs} ms</td></tr>`
                  )
                  .join('')}</tbody></table>`
              : '<p class="muted small">Checks start when the first run begins.</p>'
          }
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Replans &amp; runs</h3><span class="dim small">${detail.replans.length} replans</span></div>
        <div class="card-body stack" style="gap:8px">
          ${detail.replans
            .map(
              (replan) => `<div class="cc-note"><span class="badge">${esc(replan.source)}</span> <span class="small">${esc(
                replan.summary
              )}</span><span class="dim small"> · ${replan.steps.length} step(s) · ${fmtTime(replan.at)}</span></div>`
            )
            .join('') || '<p class="muted small">No replans. The verifier will trigger one when an attempt is off target.</p>'}
          <div style="border-top:1px solid var(--line);padding-top:8px">
            <div class="cc-filters">
              <select data-scope="cc-sessions" data-key="status">
                ${['all', 'passed', 'failed', 'running', 'cancelled']
                  .map((value) => `<option value="${value}" ${sessionFilter.status === value ? 'selected' : ''}>${value === 'all' ? 'All sessions' : value}</option>`)
                  .join('')}
              </select>
              <select data-scope="cc-sessions" data-key="sort">
                <option value="newest" ${sessionFilter.sort === 'newest' ? 'selected' : ''}>Newest first</option>
                <option value="retries" ${sessionFilter.sort === 'retries' ? 'selected' : ''}>Most retries</option>
              </select>
              <span class="spacer"></span><span class="dim small">${sessionRows.length} runs</span>
            </div>
            ${sessionRows.length
              ? `<table class="data-table"><thead><tr><th>Run</th><th>Agent role</th><th>Status</th><th>Retries</th><th>Started</th><th></th></tr></thead><tbody>${sessionRows
                  .map(
                    (run) => `<tr><td class="mono small">${esc(run.id)}</td><td><span class="badge">${esc(
                      run.agentRole || 'operator'
                    )}</span></td><td>${statusPill(run.status || 'queued')}</td><td class="mono">${Number(
                      run.retryCount || 0
                    )}</td><td class="dim small">${fmtTime(run.startedAt || run.createdAt)}</td><td><button class="btn btn-sm btn-ghost" data-act="mission-open-run" data-id="${esc(
                      run.id
                    )}">Open</button></td></tr>`
                  )
                  .join('')}</tbody></table>`
              : '<p class="muted small">No runs match this session filter.</p>'}
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Session record pattern</h3><span class="dim small">one Knack record per mission</span></div>
      <div class="card-body">
        <p class="small">A desktop + browser chain writes one record: the legs live in <span class="mono">runs[]</span> with their agent role, the chain in <span class="mono">events[]</span>, and privileged interventions in <span class="mono">operatorCommands[]</span>. The shape below is filled from this session.</p>
        <pre class="code" style="max-height:320px;margin-top:9px">${esc(
          JSON.stringify(
            {
              sessionId: detail.id,
              goal: detail.goal,
              roles: [...new Set(recordRuns.map((run) => run.agentRole || 'operator'))],
              runs: recordRuns.map((run) => ({ runId: run.id, agentRole: run.agentRole || 'operator', status: run.status })),
              events: detail.events.slice(0, 3).map((evt) => ({ agent: evt.agent, kind: evt.kind, severity: eventSeverity(evt) })),
              operatorCommands: (detail.commands || []).map((entry) => ({
                command: entry.command,
                reason: entry.reason || '',
                by: entry.by || 'admin',
              })),
              verdict: detail.verdict || 'pending',
            },
            null,
            2
          )
        )}</pre>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Event stream</h3><span class="dim small">${eventRows.length} of ${detail.events.length} events</span></div>
      <div class="card-body">
        <div class="chip-row" style="margin-bottom:6px">
          ${[
            ['all', 'All'],
            ['errors', 'Errors'],
            ['replans', 'Replans'],
            ['security', 'Security'],
          ]
            .map(
              ([key, label]) => `<button class="chip ${eventFilter.view === key ? 'active' : ''}" data-act="cc-view" data-view="${key}">${label} · ${
                key === 'all' ? detail.events.length : detail.events.filter((evt) => matchesView(evt, key)).length
              }</button>`
            )
            .join('')}
        </div>
        <div class="chip-row" style="margin-bottom:8px">
          <button class="chip ${eventFilter.agent === 'all' ? 'active' : ''}" data-act="cc-agent-filter" data-agent="all">all agents · ${detail.events.length}</button>
          ${eventAgents
            .map(
              (agent) => `<button class="chip ${eventFilter.agent === agent ? 'active' : ''}" data-act="cc-agent-filter" data-agent="${esc(
                agent
              )}">${esc(agent)} · ${detail.events.filter((evt) => evt.agent === agent).length}</button>`
            )
            .join('')}
        </div>
        <div class="cc-filters">
          <select data-scope="cc-events" data-key="agent">
            <option value="all" ${eventFilter.agent === 'all' ? 'selected' : ''}>All agents</option>
            ${eventAgents.map((agent) => `<option value="${esc(agent)}" ${eventFilter.agent === agent ? 'selected' : ''}>${esc(agent)}</option>`).join('')}
          </select>
          <select data-scope="cc-events" data-key="kind">
            <option value="all" ${eventFilter.kind === 'all' ? 'selected' : ''}>All kinds</option>
            ${eventKinds.map((kind) => `<option value="${esc(kind)}" ${eventFilter.kind === kind ? 'selected' : ''}>${esc(kind)}</option>`).join('')}
          </select>
          <select data-scope="cc-events" data-key="severity">
            ${['all', 'info', 'warn', 'error']
              .map((value) => `<option value="${value}" ${eventFilter.severity === value ? 'selected' : ''}>${value === 'all' ? 'All severities' : value}</option>`)
              .join('')}
          </select>
          <input type="search" placeholder="Search message" value="${esc(eventFilter.q)}" data-scope="cc-events" data-key="q" aria-label="Search events" />
          <select data-scope="cc-events" data-key="sort">
            <option value="newest" ${eventFilter.sort === 'newest' ? 'selected' : ''}>Newest first</option>
            <option value="oldest" ${eventFilter.sort === 'oldest' ? 'selected' : ''}>Oldest first</option>
          </select>
        </div>
        <div style="max-height:360px;overflow:auto">
          ${eventRows
            .map(
              (evt) => `<div class="cc-event"><span class="badge">${esc(evt.agent)}</span><span class="badge">${esc(
                evt.kind
              )}</span><span class="small">${esc(evt.message)}</span><span class="dim small t">${fmtTime(evt.at)}</span></div>`
            )
            .join('') || '<p class="muted small">No events match these filters.</p>'}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Final review</h3><span class="dim small">${esc(detail.review?.source || 'pending')}</span></div>
      <div class="card-body">
        ${
          detail.review
            ? `<p class="small">${esc(detail.review.summary || '')}</p>
               ${(detail.review.updates || []).length ? `<h4 class="mini-head">Updates</h4><ul class="rule-list small">${detail.review.updates.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}
               ${(detail.review.nextActions || []).length ? `<h4 class="mini-head">Next actions</h4><ul class="rule-list small">${detail.review.nextActions.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}`
            : '<p class="muted small">The final reviewer writes the mission note, updates and next actions once the attempts are over.</p>'
        }
      </div>
    </div>`
    : `<div class="card"><div class="card-body">${
        missions.length ? '<p class="muted small">Loading mission…</p>' : emptyState('No missions yet', 'Launch one above and the supervisor will hold the first capture as the reference frame.')
      }</div></div>`;

  const continuity = d.continuity || {};
  const continuitySummary = continuity.summary || {};
  const continuityLatest = (continuity.verdicts || [])[0] || null;
  const continuityCard = `
  <div class="card">
    <div class="card-head">
      <h3>Continuity verifier</h3>
      <div class="row wrap" style="gap:6px"><span class="badge">${esc(continuitySummary.lastStatus || 'observing')}</span><span class="badge">${esc(continuitySummary.windowState || 'window unknown')}</span><span class="badge">${continuitySummary.openSuggestions || 0} draft(s)</span><span class="badge">${continuitySummary.readyContinuations || 0} ready</span></div>
    </div>
    <div class="card-body">
      <p class="small muted">${continuityLatest ? esc(continuityLatest.summary || '') : 'Captures frames while a run waits, checks the next frame, window lifecycle, links, coordinates and current wording, then drafts safe continuation steps.'}</p>
      <div class="row wrap" style="gap:7px">
        <button class="btn btn-sm btn-primary" data-nav="continuity">Open verifier</button>
        <button class="btn btn-sm" data-act="continuity-scan" ${ui.continuityBusy === 'scan' ? 'disabled' : ''}>${ui.continuityBusy === 'scan' ? 'Capturing…' : 'Capture / verify now'}</button>
        <span class="dim small">${continuity.scans || 0} checks · ${continuitySummary.lastScore != null ? `${continuitySummary.lastScore}% confidence` : 'no verdict yet'}</span>
      </div>
    </div>
  </div>`;

  const escalation = d.escalation || {};
  const escalationCard = `
  <div class="hint-box small">
    <div class="row wrap" style="gap:8px;align-items:center">
      <strong>Auto-escalation ${escalation.enabled ? 'on' : 'off'}</strong>
      <span class="dim">${escalation.enabled
        ? `${esc(String(escalation.minFailures ?? 2))} consecutive failures · ${esc(String(escalation.today ?? 0))}/${esc(
            String(escalation.dailyCap ?? 3)
          )} started today · auto-recovery runs first`
        : 'failures stay in Test runs until you forward one'}</span>
      <span class="spacer"></span>
      ${escalation.candidateCount
        ? `<button class="btn btn-sm btn-primary" data-act="escalate-backlog" data-limit="${Math.max(
            1,
            Math.min(3, Number(escalation.remaining) || 3)
          )}">Send ${escalation.candidateCount} failure(s) to the Command Center</button>`
        : '<span class="dim small">No unclaimed failures.</span>'}
    </div>
    ${escalation.candidates?.length
      ? `<div class="small" style="margin-top:6px">${escalation.candidates
          .slice(0, 4)
          .map(
            (candidate) =>
              `<span class="badge">${esc(candidate.workflowName)} · ${esc(String(candidate.streak || 1))}×${candidate.dryRun ? ' · simulated' : ''}</span>`
          )
          .join(' ')}</div>`
      : ''}
    <div class="dim small" style="margin-top:5px">A mission is only started once the automatic repair has had its try, one per workflow at a time, and never more than the daily cap. Change the threshold or cap in Settings.</div>
  </div>`;

  return `
  <div class="page-head">
    <div>
      <h1>Command Center</h1>
      <p>The attached supervisor holds the baseline frame, researches and replans, dispatches one or two executors, then hands off to a verifier and a final reviewer — each with its own sub-agent. Every loop check, event and reference is recorded here.</p>
    </div>
    <div class="page-head-actions">
      <span class="badge">${d.counts?.missionsActive || 0} active</span>
      <span class="badge">${missions.length} missions</span>
      <span class="badge">${d.patterns?.length || 0} learned fixes</span>
    </div>
  </div>
  ${composer}
  ${escalationCard}
  ${continuityCard}
  <div class="cc-layout">
    <aside class="cc-list">
      <div class="wf-rail-head"><h3>Missions</h3><span class="dim small">${missions.length}</span></div>
      ${list}
    </aside>
    <div class="stack">${detailHtml}</div>
  </div>`;
}

function renderSupervisorPlaybook() {
  const scenarios = [
    {
      title: 'Simulated Notepad drill',
      goal: 'Open Notepad, type the note, and confirm the window still shows it.',
      setup: 'wf_notepad_smoke · simulated · 2 attempts · auto-replan on',
      watch: 'Baseline capture, six-step progress checks, AI verification, reviewer note.',
      outcome: 'A passed mission with a baseline/checkpoint frame pair and a note you can attach to a review.',
    },
    {
      title: 'Prove a video is actually playing',
      goal: 'Start the video, hold ten seconds, and verify the player shows progress.',
      setup: 'ex_video_hold · vision cross-reference on · a vision-capable model in Settings',
      watch: 'Verifier compares the two captures; off-target triggers a replan with a longer wait.',
      outcome: 'A verdict that names the progress bar, not just a successful click.',
    },
    {
      title: 'Scheduled desktop health',
      goal: 'Check the desktop is alive and capture it every five minutes.',
      setup: 'ex_desktop_health · scheduler agent + mission · auto-ready on pass off',
      watch: 'Loop check cadence stretching while the desktop is idle, then snapping back on progress.',
      outcome: 'A capture trail plus a note per run; failures pause the scheduler.',
    },
    {
      title: 'Train a learned fix',
      goal: 'Run the failure drill and let the supervisor repair it.',
      setup: 'ex_failure_drill · 2 attempts · reuse learned fixes on',
      watch: 'First attempt fails, verifier says off target, a replan is inserted, attempt two runs on executor B.',
      outcome: 'A pattern keyed by the error signature, reused by later missions instead of asking the model again.',
    },
    {
      title: 'Two-executor handoff',
      goal: 'Compare a first-pass run with a repaired run on the same workflow.',
      setup: 'Any workflow · 2 attempts · auto-replan on',
      watch: 'Executor A dispatches attempt one, executor B dispatches the repair; both link back to normal runs.',
      outcome: 'A pipeline where each executor has its own retry/input sub-agent and the verifier owns evidence.',
    },
    {
      title: 'Error recovery with retry tags',
      goal: 'Open Notepad, type a line and prove the editor was ready before typing.',
      setup: 'ex_error_recovery · simulated · 2 retries, 2 s pause · pattern tags retry, timeout, error-handling',
      watch: 'Retry Count and Error Category on the run; Recovered badge when a retry passed.',
      outcome: 'A run tagged for retry analytics and a pattern that the Retry Watch view can group.',
    },
    {
      title: 'Security navigation without stored secrets',
      goal: 'Sign in to an internal page and confirm the workspace, without putting a password in a step.',
      setup: 'ex_security_navigation · live · demo placeholders, or swap in a credential tool · Operator role only',
      watch: 'Pre-typing capture is empty of secrets; the placeholder steps are visible in the plan; mission verdict checks the workspace capture.',
      outcome: 'An auditable sign-in flow whose workflow record and Knack export contain no real credentials.',
    },
    {
      title: 'Bounded loop with reasoning and replan',
      goal: 'Poll a status page, capture it and let the verifier decide whether it is really ready.',
      setup: 'ex_loop_until_ready · waitFor 10 × 1.5 s · auto-replan and vision on',
      watch: 'Loop checks stretching, verifier findings naming the spinner, replan inserted before attempt two.',
      outcome: 'A bounded loop with reasoning in the verifier and a repair on executor B, not an unbounded retry.',
    },
    {
      title: 'Desktop + browser handoff chain',
      goal: 'Sign in to the console in Chrome, hand the token to Notepad and prove both windows survive.',
      setup: 'ex_desktop_browser_chain · live · 2 attempts · tags multi-agent, browser, handoff',
      watch: 'Executor A runs the browser leg; an off-target verifier triggers FORCE_REPLAN; executor B runs the desktop leg; the reviewer writes both legs.',
      outcome: 'One session with two executor-role runs, saved Errors/Replans/Security views and a ready Knack record pattern.',
    },
    {
      title: 'Operate from the Command Center',
      goal: 'Pause, check, replan, retry or issue an operator command without editing the workflow.',
      setup: 'Any mission · Check now, Research & replan, Retry mission, Open last run · Admin sign-in for FORCE_REPLAN / OVERRIDE_PAUSE',
      watch: 'Each action appends an event and a reference; operator commands are recorded with the reason and admin name; saved views isolate Errors, Replans and Security.',
      outcome: 'A single screen for commands, saved views, tools, custom workflows, history and loop progression.',
    },
  ];
  return `
  <div class="stack">
    <div class="card">
      <div class="card-head"><h3>Supervisor &amp; sub-agent usage</h3><span class="dim small">${scenarios.length} ways to drive a mission</span></div>
      <div class="card-body">
        <p class="small muted">A mission is not a run. The run executes steps; the mission holds the goal, the frame and the chain of agents. Each stage can stop the chain, ask for a replan, or pass control to the next agent.</p>
      </div>
    </div>
    <div class="cc-playbook">
      ${scenarios
        .map(
          (s) => `<div class="card">
            <div class="card-head"><h3>${esc(s.title)}</h3></div>
            <div class="card-body stack" style="gap:8px">
              <div><h4 class="mini-head">Mission goal</h4><p class="small">${esc(s.goal)}</p></div>
              <div><h4 class="mini-head">Setup</h4><p class="small mono">${esc(s.setup)}</p></div>
              <div><h4 class="mini-head">Watch for</h4><p class="small">${esc(s.watch)}</p></div>
              <div><h4 class="mini-head">Expected outcome</h4><p class="small">${esc(s.outcome)}</p></div>
            </div>
          </div>`
        )
        .join('')}
    </div>
    <div class="card">
      <div class="card-body row wrap" style="gap:8px">
        <button class="btn btn-primary" data-nav="command">Open Command Center</button>
        <button class="btn btn-ghost" data-nav="agents">Agent settings</button>
        <button class="btn btn-ghost" data-nav="examples">Back to workflows</button>
      </div>
    </div>
  </div>`;
}

function renderKnackTab() {
  if (!ui.knack) {
    loadKnack().then(render);
    return '<div class="empty">Loading Knack mapping…</div>';
  }
  const k = ui.knack;
  return `
  <div class="stack">
    <div class="card">
      <div class="card-head"><h3>Command Center in Knack Builder</h3><span class="dim small">${k.counts.objects} objects · ${k.counts.fields} fields</span></div>
      <div class="card-body">
        <p class="small muted">Knack creates objects, fields and pages only in Builder. This is the handoff: the exact objects, labels, types, filter plan and checklist, plus CSV/JSON exports. The <span class="mono">field_###</span> API keys are placeholders until you copy the real ones from your app into <span class="mono">server/knack.js</span>.</p>
        <div class="row wrap" style="gap:7px;margin-top:10px">
          <a class="btn btn-sm btn-primary" href="/api/knack/download?format=md" download>Download checklist (.md)</a>
          <a class="btn btn-sm" href="/api/knack/download?format=csv" download>Field mapping (.csv)</a>
          <a class="btn btn-sm" href="/api/knack/download?format=json" download>Schema + records (.json)</a>
          <button class="btn btn-sm btn-ghost" data-nav="python">Python exporter</button>
          <button class="btn btn-sm btn-ghost" data-nav="command">Command Center</button>
        </div>
        <ul class="rule-list small" style="margin-top:11px">${k.limits.map((limit) => `<li>${esc(limit)}</li>`).join('')}</ul>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Proposed fields — already wired here</h3><span class="dim small">requested additions</span></div>
      <div class="card-body detail-cols">
        <div>
          <h4 class="mini-head">Retry Count · Test Runs</h4>
          <p class="small">Number of retries used across the run's steps. Populated on every run, shown in Test runs, exported to Knack and used by the Retry Watch filter. Recovered runs are exactly those with a pass and a count above zero.</p>
        </div>
        <div>
          <h4 class="mini-head">Pattern Tags · Automation Workflows</h4>
          <p class="small">Comma-separated slugs (retry, timeout, login, browser). Editable in the Builder header, copied onto each run, carried into missions, and used for tag-level pass/retry analytics.</p>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Multi-agent record pattern</h3><span class="dim small">desktop + browser chain</span></div>
      <div class="card-body">
        <p class="small">${esc(k.pattern?.scenario || '')}</p>
        <pre class="code" style="max-height:420px;margin-top:9px">${esc(JSON.stringify(k.pattern || {}, null, 2))}</pre>
      </div>
    </div>

    <div class="integration-grid">
      ${k.objects
        .map(
          (object) => `<div class="card"><div class="card-head"><h3>${esc(object.name)}</h3></div><div class="card-body"><p class="small">${esc(
            object.purpose
          )}</p><p class="dim small" style="margin-top:6px">Connections: ${esc(object.connections.join('; '))}</p></div></div>`
        )
        .join('')}
    </div>

    <div class="card">
      <div class="card-head"><h3>KNACK_FIELDS mapping</h3><span class="dim small">${k.fields.length} keys</span></div>
      <div class="card-body" style="overflow:auto;max-height:540px">
        <table class="data-table">
          <thead><tr><th>Object</th><th>Field label</th><th>Type</th><th>API key</th><th>Logical key</th></tr></thead>
          <tbody>${k.fields
            .map(
              (field) => `<tr><td class="mono small">${esc(field.object)}</td><td>${esc(field.label)}${
                field.required ? ' <span class="badge">required</span>' : ''
              }</td><td class="dim small">${esc(field.type)}</td><td class="mono small">${esc(field.knackField)}</td><td class="mono small">${esc(
                field.key
              )}</td></tr>`
            )
            .join('')}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Setup checklist</h3><span class="dim small">${k.checklist.length} sections</span></div>
      <div class="card-body stack" style="gap:6px">
        ${k.checklist
          .map(
            (section, index) => `<details class="log" ${index < 2 ? 'open' : ''}>
              <summary>${esc(section.title)} · ${section.steps.length} steps</summary>
              <ul class="rule-list small checklist">${section.steps
                .map((step) => `<li><label class="check"><input type="checkbox" /> <span>${esc(step)}</span></label></li>`)
                .join('')}</ul>
            </details>`
          )
          .join('')}
      </div>
    </div>
  </div>`;
}

const FIELD_KEYS = [
  ['Workflow name', 'workflow.name', 'string'],
  ['Draft / Ready', 'workflow.status', 'draft | ready | archived'],
  ['Failure action', 'workflow.failurePolicy.onFailure', 'stop | retry | continue'],
  ['Max retries', 'workflow.failurePolicy.maxRetries', '0–5'],
  ['Failure screenshot', 'workflow.failurePolicy.captureScreenshot', 'boolean'],
  ['Retry pause', 'workflow.failurePolicy.pauseBeforeRetryMs', 'milliseconds'],
  ['Step type', 'workflow.steps[i].type', 'launchApp … waitFor'],
  ['Step label', 'workflow.steps[i].name', 'string'],
  ['X / Y', 'workflow.steps[i].params.x  /  .y', 'integer pixels'],
  ['Text to type', 'workflow.steps[i].params.text', 'string'],
  ['Window title', 'workflow.steps[i].params.title', 'substring match'],
  ['Keys', 'workflow.steps[i].params.keys', 'SendKeys: ^s, {ENTER}, %{F4}'],
  ['Wait duration', 'workflow.steps[i].params.ms', 'milliseconds, max 600000'],
  ['Wait-for condition', 'workflow.steps[i].params.kind / .value / .mode', 'window|process|file · present|absent'],
  ['Assertion', 'workflow.steps[i].params.kind / .value', 'window|file|process'],
  ['Step timeout', 'workflow.steps[i].timeoutMs', 'milliseconds'],
  ['Optional step', 'workflow.steps[i].optional', 'boolean'],
  ['Run condition', 'workflow.steps[i].condition', 'newChat or null'],
  ['Run status', 'run.status', 'queued | running | passed | failed | needs_review | cancelled'],
  ['Step outcome', 'run.steps[i].status / .error', 'pending … skipped · error text'],
  ['Evidence', 'run.evidence[j].path / .simulated', 'data/captures/… · boolean'],
  ['Review', 'run.review.status / .comment', 'unreviewed | reviewed'],
  ['Supervision', 'run.supervised / .escalated', 'boolean'],
  ['Retry count', 'run.retryCount', 'integer · retries used across steps'],
  ['Error category', 'run.errorCategory', 'timeout | window_not_found | tool_missing …'],
  ['Failure signature', 'run.failureSignature', 'step type + normalised error'],
  ['Recovered', 'run.recovered', 'boolean · passed after a retry'],
  ['Last error code', 'run.lastErrorCode', 'TOOL_NOT_FOUND | TIMEOUT | WINDOW_NOT_FOUND …'],
  ['Last error category', 'run.lastErrorCategory', 'category of the most recent failure'],
  ['Run complexity', 'run.runComplexityScore', '0–100 estimate'],
  ['Advanced planning', 'run.requiresAdvancedPlanning', 'boolean · tools, branches, security tags'],
  ['Flakiness score', 'workflow.stats.flakinessScore', '0–100 · failures + retries'],
  ['Failures (7d)', 'workflow.stats.totalFailures7d', 'integer'],
  ['Pattern tags', 'workflow.patternTags[i]', 'slug string, max 8'],
  ['Session retries', 'missions[i].attempts − 1', 'integer'],
  ['Event severity', 'missions[i].events[j].severity', 'info | warn | error'],
  ['Agent role type', 'run.agentRole', 'operator | scheduler | executor-a/b | verifier | reviewer'],
  ['Operator command', 'missions[i].commands[j].command / .reason / .by', 'FORCE_REPLAN | OVERRIDE_PAUSE …'],
  ['Model API style', 'settings.apiStyle', 'ollama | openai'],
  ['Saved event view', 'Command Center Events', 'all | errors | replans | security'],
  ['Tool state', 'tools[i].status', 'draft | approved | disabled'],
  ['Agent state', 'agents[i].kind / .status', 'supervisor|scheduler|watchdog · idle|working|paused'],
  ['Mission goal', 'missions[i].goal / .workflowId', 'string · workflow id'],
  ['Mission state', 'missions[i].status / .stage', 'queued … done · intake … finalize'],
  ['Mission mode', 'missions[i].mode', 'dry | live'],
  ['Mission attempts', 'missions[i].attempts / .maxAttempts', '1–4'],
  ['Mission conditions', 'missions[i].conditions.*', 'vision, autoReplan, useLearnedPatterns, newChat, checkIntervalMs, stallMs'],
  ['Held frame', 'missions[i].references[j].kind / .path', 'baseline | checkpoint | verification'],
  ['Loop check', 'missions[i].checks[j].tick / .step / .intervalMs', 'adaptive 1–15 s'],
  ['Verifier verdict', 'missions[i].verification.verdict / .confidence', 'on_target | off_target · 0–1'],
  ['Replan', 'missions[i].replans[j].source / .steps', 'ai | pattern · Automation Step[]'],
  ['Learned pattern', 'patterns[i].signature / .wins / .fixSteps', 'error signature → repair steps'],
  ['Final review', 'missions[i].review.summary / .updates / .nextActions', 'string · string[]'],
  ['Pipeline agent', 'missions[i].pipeline[k].role / .status / .subAgents', 'supervisor … reviewer'],
];

function renderSchemaTab(selected) {
  return `
  <div class="stack">
    <div class="card">
      <div class="card-head"><h3>Field keys — exactly what the Builder writes</h3><span class="dim small">use these in scripts, imports and the API</span></div>
      <div class="card-body" style="overflow:auto">
        <table class="data-table">
          <thead><tr><th>Builder control</th><th>Record key</th><th>Type / values</th></tr></thead>
          <tbody>${FIELD_KEYS.map(
            ([label, key, type]) => `<tr><td>${esc(label)}</td><td class="mono">${esc(key)}</td><td class="dim small">${esc(type)}</td></tr>`
          ).join('')}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Concrete records — “${esc(selected.title)}”</h3><span class="dim small">generated from the selected example</span></div>
      <div class="card-body">
        <p class="muted small" style="margin-bottom:10px">Importing an example writes one Automation Workflow record and one Automation Step record per row below. Ids are regenerated on import; every other value is copied verbatim.</p>
        <pre class="code" style="max-height:520px">${esc(JSON.stringify(exampleRecord(selected), null, 2))}</pre>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Status vocabulary</h3></div>
      <div class="card-body detail-cols">
        <div>
          <h4 class="mini-head">Workflow</h4>
          <ul class="rule-list">
            <li><b>draft</b> — editable, manual runs only.</li>
            <li><b>ready</b> — schedulable by background agents.</li>
            <li><b>archived</b> — cannot run.</li>
          </ul>
          <h4 class="mini-head" style="margin-top:10px">Step</h4>
          <ul class="rule-list">
            <li><b>pending → running → passed | failed | skipped</b>, with <b>attempts</b> and <b>error</b>.</li>
          </ul>
        </div>
        <div>
          <h4 class="mini-head">Run</h4>
          <ul class="rule-list">
            <li><b>queued</b> — in the background queue.</li>
            <li><b>running</b> — a step is executing.</li>
            <li><b>passed</b> — every step succeeded.</li>
            <li><b>failed</b> — policy stopped the run.</li>
            <li><b>needs_review</b> — failures continued or only optional steps failed.</li>
            <li><b>cancelled</b> — stopped by an operator.</li>
          </ul>
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ python */
function renderPython() {
  if (!ui.python) {
    loadPython().then(render);
    return '<div class="empty">Loading Python files…</div>';
  }
  const s = ui.data.settings;
  const files = ui.python;
  return `
  <div class="page-head">
    <div>
      <h1>Python files</h1>
      <p>Ready-to-download scripts for the model and the console API. Files live in <span class="mono">data/python/</span>, appear in the Files browser and can be edited here.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn" data-act="python-refresh">Refresh</button>
      <button class="btn btn-primary" data-act="python-new">＋ New Python file</button>
    </div>
  </div>

  <div class="card" style="margin-bottom:14px">
    <div class="card-head"><h3>Integration points</h3><span class="badge">${esc(s.model)}</span></div>
    <div class="card-body integration-grid">
      <div>
        <h4 class="mini-head">Model server</h4>
        <p class="small muted"><span class="mono">${esc(s.baseUrl || '')}</span><br /><span class="mono">${esc(s.chatPath || '/api/chat')}</span></p>
        <p class="small dim" style="margin-top:4px">Embeddings and chat both use this base URL. Change it in Settings.</p>
      </div>
      <div>
        <h4 class="mini-head">Desktop executor</h4>
        <p class="small muted">Live input uses the available backend on this machine. Simulated runs validate without input; live runs move the real pointer.</p>
      </div>
      <div>
        <h4 class="mini-head">Local console API</h4>
        <p class="small muted mono">http://127.0.0.1:4317</p>
        <p class="small dim" style="margin-top:4px">Runs, captures, examples, settings.</p>
      </div>
    </div>
  </div>

  <div class="card" style="margin-bottom:14px">
    <div class="card-body" style="padding:0;overflow:auto">
      <table class="data-table">
        <thead><tr><th>File</th><th>Purpose</th><th>Lines</th><th>Size</th><th>Updated</th><th></th></tr></thead>
        <tbody>
          ${
            files.length
              ? files
                  .map(
                    (f) => `<tr>
                      <td><strong class="mono">${esc(f.name)}</strong></td>
                      <td class="small">${esc(f.purpose || 'No docstring')}</td>
                      <td class="mono">${f.lines}</td>
                      <td class="mono">${fmtBytes(f.size)}</td>
                      <td class="nowrap">${fmtTime(f.mtime)}</td>
                      <td class="nowrap">
                        <button class="btn btn-sm btn-ghost" data-act="python-view" data-id="${esc(f.name)}">View</button>
                        <a class="btn btn-sm" href="/api/python/${encodeURIComponent(f.name)}/download" download>Download</a>
                        <button class="btn btn-sm btn-ghost" data-act="python-delete" data-id="${esc(f.name)}">Delete</button>
                      </td>
                    </tr>`
                  )
                  .join('')
              : '<tr><td colspan="6" class="muted">No Python files yet.</td></tr>'
          }
        </tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>API surface used by the scripts</h3></div>
    <div class="card-body" style="overflow:auto">
      <table class="data-table">
        <thead><tr><th>Call</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td class="mono">GET /api/state</td><td>Workflows, runs, agents and counts.</td></tr>
          <tr><td class="mono">POST /api/workflows/:id/runs</td><td>Queue a run: <span class="mono">{ "mode": "dry" | "live" }</span>.</td></tr>
          <tr><td class="mono">GET /api/runs/:id</td><td>Step statuses, errors, evidence and diagnosis.</td></tr>
          <tr><td class="mono">GET /api/models</td><td>List models from the configured server.</td></tr>
          <tr><td class="mono">GET /api/examples</td><td>Refined workflow templates.</td></tr>
          <tr><td class="mono">GET /api/files/raw?path=…</td><td>Download a capture or note.</td></tr>
        </tbody>
      </table>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ settings fields */
/**
 * GitHub sync and the shareable test link, shown at the end of Settings.
 * Sync interval and pull policy are saved with the settings form.
 */
function sharingPanel() {
  const sync = ui.data?.gitSync || {};
  const share = ui.data?.share || {};
  const enabled = sync.enabled !== false;
  const link = share.link || ui.shareLink || '';
  const labels = {
    idle: 'idle',
    clean: 'up to date',
    waiting: 'waiting for the save to settle',
    pushed: 'pushed',
    behind: 'remote moved — merge needed',
    conflict: 'conflict — merge needed',
    'push-failed': 'push failed',
    'backup-failed': 'recovery snapshot failed; remote update held',
    held: 'remote update held after testing',
    verifying: 'testing remote update',
    error: 'failed',
    'not-a-repo': 'this folder is not a git repository',
    disabled: 'paused',
  };
  const statusText = enabled ? labels[sync.status] || sync.status || 'idle' : 'paused';
  const intervalMs = Number(ui.settingsDraft?.autoSyncIntervalMs || ui.data?.settings?.autoSyncIntervalMs || 10000);
  const autoPull = (ui.settingsDraft?.autoPull ?? ui.data?.settings?.autoPull) === true;
  return `
  <hr style="border:none;border-top:1px solid var(--line);margin:16px 0 12px" />
  <h3 style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)">GitHub sync</h3>
  <p class="small muted" style="margin:0 0 8px">Syncs tracked changes on this console's current branch after tests pass. Tests run project code with this server's permissions in a separate worktree, not a security sandbox; only enable this for trusted repositories. Incoming fast-forwards are tested and backed up first. Other branches need separate review.</p>
  <div class="row wrap" style="gap:8px;align-items:center">
    <span class="pill ${enabled ? 'passed' : ''}">${enabled ? 'auto-sync on' : 'auto-sync off'}</span>
    <span class="small dim">${esc(String(statusText))}${Number(sync.pending) ? ` · ${Number(sync.pending)} file(s) pending` : ''}${sync.lastSyncAt ? ` · last ${esc(fmtTime(sync.lastSyncAt))}` : ''}</span>
    <span class="spacer"></span>
    <button class="btn btn-sm btn-ghost" data-act="toggle-autosync">${enabled ? 'Pause' : 'Turn on'}</button>
    <button class="btn btn-sm" data-act="git-sync-now">Sync now</button>
  </div>
  <div class="field-row" style="margin-top:8px">
    <label class="field"><span>Check interval</span><select data-scope="settings" data-key="autoSyncIntervalMs">
      ${[[10000, '10 seconds'], [20000, '20 seconds'], [60000, '60 seconds']].map(([value, label]) => `<option value="${value}" ${intervalMs === value ? 'selected' : ''}>${label}</option>`).join('')}
    </select><span class="help">Polling is bounded to at least 5 seconds.</span></label>
    <label class="check"><input type="checkbox" data-scope="settings" data-key="autoPull" ${autoPull ? 'checked' : ''} /> Pull remote updates after isolated tests pass</label>
  </div>
  ${sync.lastError ? `<p class="small" style="color:var(--bad);margin:6px 0 0">${esc(sync.lastError)}</p>` : ''}
  <h3 style="margin:18px 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)">Share link for testing</h3>
  <p class="small muted" style="margin:0 0 8px">A token-gated copy of this console for someone else to open. They can read everything and run simulated runs; live desktop control, tool execution and settings stay refused.</p>
  ${
    share.active
      ? `<div class="row wrap" style="gap:8px;align-items:center">
          <input type="text" readonly value="${esc(link)}" style="flex:1;min-width:220px;font-family:var(--mono);font-size:11px" />
          <button class="btn btn-sm" data-act="copy-share-link">Copy</button>
          <button class="btn btn-sm btn-ghost" data-act="share-stop">Stop sharing</button>
        </div>
        <p class="small dim" style="margin:6px 0 0">${share.publicUrl ? 'public tunnel link' : 'local network only'} · port ${Number(share.port) || 4318} · ${Number(share.requests) || 0} request(s) · ${Number(share.visitors) || 0} visitor(s)</p>`
      : `<div class="row wrap" style="gap:8px;align-items:center">
          <button class="btn btn-sm" data-act="share-start">Create test link</button>
          <span class="small dim">${esc(share.lastError || 'Starts a token-gated proxy on port 4318. Public URL only when cloudflared is installed.')}</span>
        </div>`
  }`;
}

/**
 * The local backup engine: download a GGUF, install llama.cpp or Ollama, start
 * or stop the server. Everything here is opt-in by click; nothing is fetched
 * or installed because the page loaded.
 */
function renderLocalModelCard() {
  const lm = ui.data?.localModel;
  if (!lm) return '';
  const busy = ui.localModelBusy || '';
  const size = (bytes) => `${(Number(bytes || 0) / 1e9).toFixed(2)} GB`;
  const models = (lm.models || [])
    .map((m) => `<li class="small mono">${esc(m.file)} · ${size(m.bytes)}</li>`)
    .join('');
  const catalog = (lm.catalog || [])
    .map((m) => `<li class="small">${esc(m.label)} · ${size(m.bytes)} · ${esc(m.license)} <span class="dim">— ${esc(m.note)}</span></li>`)
    .join('');
  const dl = lm.download || {};
  const pct = dl.total ? Math.min(100, Math.round((dl.received / dl.total) * 100)) : 0;
  const provider = lm.provider === 'ollama' ? 'Ollama' : 'llama.cpp';
  const serving = lm.server?.running ? `, serving ${esc(lm.server.file)} on port ${lm.server.port}` : '';
  return `<div class="hint-box" style="margin:4px 0 12px">
    <strong>Local backup model</strong>
    <div class="small" style="margin-top:4px">${lm.ready ? `Ready — ${provider}${serving}` : 'Not ready — download a model and a runtime; the console falls back to it when the endpoint above cannot answer.'}</div>
    <div class="small dim" style="margin-top:3px">llama.cpp: ${lm.llama.found ? 'installed' : 'not installed'} · Ollama: ${lm.ollama.found ? 'installed' : 'not installed'} · GGUF models: ${(lm.models || []).length}</div>
    ${(lm.models || []).length ? `<ul style="margin:6px 0 0 16px">${models}</ul>` : ''}
    ${dl.id && !dl.doneAt && !dl.error ? `<div class="small" style="margin-top:6px">Downloading ${esc(dl.file)} — ${pct}% (${size(dl.received)} of ${size(dl.total)})</div>` : ''}
    ${dl.error ? `<div class="small" style="color:var(--bad);margin-top:6px">${esc(dl.error)}</div>` : ''}
    <div class="row wrap" style="margin-top:8px;gap:6px">
      <button class="btn btn-sm" data-act="local-model-install" data-runtime="llamacpp" ${busy ? 'disabled' : ''}>${busy === 'llamacpp' ? 'Installing…' : 'Install llama.cpp'}</button>
      <button class="btn btn-sm btn-ghost" data-act="local-model-install" data-runtime="ollama" ${busy ? 'disabled' : ''}>${busy === 'ollama' ? 'Installing Ollama…' : 'Install Ollama'}</button>
      <button class="btn btn-sm btn-primary" data-act="local-model-download" data-id="qwen2.5-0.5b-instruct-q4_k_m" ${busy ? 'disabled' : ''}>${busy === 'download' ? 'Downloading…' : 'Download backup (0.5B)'}</button>
      <button class="btn btn-sm" data-act="local-model-start" ${busy || !(lm.llama.found && lm.file) ? 'disabled' : ''}>Start local server</button>
      <button class="btn btn-sm btn-ghost" data-act="local-model-stop" ${lm.server?.running ? '' : 'disabled'}>Stop</button>
    </div>
    ${(lm.models || []).length > 1 ? `<label class="field" style="margin-top:6px"><span>Model file</span><select data-scope="settings" data-key="localModelFile">${(lm.models || []).map((m) => `<option value="${esc(m.file)}" ${m.file === lm.file ? 'selected' : ''}>${esc(m.file)}</option>`).join('')}</select><span class="help">Any .gguf copied into data/models is listed here; the first one is used when nothing is chosen.</span></label>` : ''}
    <label class="field" style="margin-top:6px"><span>Local runtime</span><select data-scope="settings" data-key="localModelProvider"><option value="llamacpp" ${lm.provider !== 'ollama' ? 'selected' : ''}>llama.cpp — GGUF file, no Ollama</option><option value="ollama" ${lm.provider === 'ollama' ? 'selected' : ''}>Ollama — local daemon</option></select><span class="help">Used only when the endpoint above cannot answer. Screen checks need the remote model: a plain GGUF has no vision.</span></label>
    <details style="margin-top:6px"><summary class="small dim">Other models</summary><ul style="margin:6px 0 0 16px">${catalog}</ul></details>
  </div>`;
}

function settingsFields(s) {
  const models = ui.models || [];
  const names = [...new Set([s.model, ...models.map((m) => m.name)].filter(Boolean))];
  const selectedModel = models.find((m) => m.name === s.model);
  const endpointPreview = `${String(s.baseUrl || '').replace(/\/+$/, '')}${s.chatPath || '/api/chat'}`;
  // Step-thinking fields live inside one object; a flat draft key wins while
  // the operator is editing, then the whole object is saved together.
  const thinkDraft = s.stepThink && typeof s.stepThink === 'object' ? s.stepThink : {};
  const thinkValue = (key, fallback) => {
    const flat = `stepThink${key[0].toUpperCase()}${key.slice(1)}`;
    return s[flat] !== undefined ? s[flat] : thinkDraft[key] !== undefined ? thinkDraft[key] : fallback;
  };
  const recheckDraft = s.recheck && typeof s.recheck === 'object' ? s.recheck : {};
  const recheckValue = (key, fallback) => {
    const flat = `recheck${key[0].toUpperCase()}${key.slice(1)}`;
    return s[flat] !== undefined ? s[flat] : recheckDraft[key] !== undefined ? recheckDraft[key] : fallback;
  };
  return `
    ${renderLocalModelCard()}
    <label class="field"><span>Model API style</span><select data-scope="settings" data-key="apiStyle">
      <option value="ollama" ${s.apiStyle !== 'openai' ? 'selected' : ''}>Ollama / Qwen — /api/chat</option>
      <option value="openai" ${s.apiStyle === 'openai' ? 'selected' : ''}>OpenAI-compatible — /v1/chat/completions</option>
    </select><span class="help">Use OpenAI-compatible for llama.cpp GGUF servers, LM Studio, vLLM or a gateway.</span></label>
    <div class="chip-row" style="margin:-4px 0 10px">
      <button class="btn btn-sm btn-ghost" data-act="model-preset" data-preset="ollama">Ollama preset</button>
      <button class="btn btn-sm btn-ghost" data-act="model-preset" data-preset="llamacpp">llama.cpp / GGUF</button>
      <button class="btn btn-sm btn-ghost" data-act="model-preset" data-preset="lmstudio">LM Studio</button>
    </div>
    <label class="field"><span>Server base URL</span><input type="text" value="${esc(s.baseUrl || '')}" data-scope="settings" data-key="baseUrl" placeholder="https://quantumclaw.net/ollama" />
      <span class="help">Model server root; the console derives /api/tags and the chat route from it.</span></label>
    <label class="field"><span>Chat route</span><input type="text" value="${esc(s.chatPath || '/api/chat')}" data-scope="settings" data-key="chatPath" placeholder="/api/chat" /></label>
    <div class="row" style="margin:-4px 0 11px;gap:8px">
      <span class="dim small mono">${esc(endpointPreview)}</span>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-ghost" data-act="models-refresh">${ui.modelsBusy ? 'Loading…' : 'Load models'}</button>
    </div>
    ${ui.modelsError ? `<p class="small" style="color:var(--bad);margin:-4px 0 10px">${esc(ui.modelsError)}</p>` : ''}
    <label class="field"><span>Model</span>
      ${
        names.length
          ? `<select data-scope="settings" data-key="model">${names
              .map((name) => `<option value="${esc(name)}" ${name === s.model ? 'selected' : ''}>${esc(name)}</option>`)
              .join('')}</select>`
          : `<input type="text" value="${esc(s.model || '')}" data-scope="settings" data-key="model" placeholder="qwen3.5:2b" />`
      }
      ${
        selectedModel
          ? `<span class="help">${esc([selectedModel.family, selectedModel.parameterSize].filter(Boolean).join(' · '))}${
              selectedModel.contextLength ? ` · ${selectedModel.contextLength} ctx` : ''
            }</span>`
          : '<span class="help">Load models to choose from the server list.</span>'
      }
    </label>
    <div class="field-row">
      <label class="field"><span>Default mode</span><select data-scope="settings" data-key="dryRun">
        <option value="true" ${s.dryRun === true || s.dryRun === 'true' ? 'selected' : ''}>Simulated — no desktop input</option>
        <option value="false" ${s.dryRun === false || s.dryRun === 'false' ? 'selected' : ''}>Live — real mouse &amp; keyboard</option>
      </select></label>
      <label class="field"><span>Agent tick (seconds)</span><input type="number" min="3" value="${Math.round(
        (s.agentTickMs || 5000) / 1000
      )}" data-scope="settings" data-key="agentTickMsSeconds" /></label>
    </div>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="autoNotes" ${
      s.autoNotes !== false ? 'checked' : ''
    } /> Auto-note every run</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="aiSuggestions" ${
      s.aiSuggestions !== false ? 'checked' : ''
    } /> Generate AI suggestions on failure</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="requireToolApproval" ${
      s.requireToolApproval !== false ? 'checked' : ''
    } /> Require approval before any tool runs</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="linkAutoApprove" ${
      s.linkAutoApprove ? 'checked' : ''
    } /> Run saved workflows from a local runner link without asking (shell steps still ask)</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="visionEnabled" ${
      s.visionEnabled ? 'checked' : ''
    } /> Send mission captures to a vision model</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="autoForwardFailures" ${
      s.autoForwardFailures ? 'checked' : ''
    } /> Send repeated failures to the Command Center automatically (after the auto-recovery stage has had its try)</label>
    <div class="field-row">
      <label class="field"><span>Escalate after (consecutive failures)</span><input type="number" min="1" max="10" value="${Number(
        s.autoEscalateMinFailures ?? 2
      )}" data-scope="settings" data-key="autoEscalateMinFailures" /></label>
      <label class="field"><span>Auto-start cap per day</span><input type="number" min="0" max="25" value="${Number(
        s.autoEscalateDailyCap ?? 3
      )}" data-scope="settings" data-key="autoEscalateDailyCap" /><span class="help">Only the missions this policy starts count toward the cap.</span></label>
    </div>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="autoProposeFailures" ${
      s.autoProposeFailures === true ? 'checked' : ''
    } /> Auto-propose a repair after a failed or needs-review run</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="autoRecoverFailures" ${
      s.autoRecoverFailures !== false ? 'checked' : ''
    } /> Auto-recover failures with a five-stage pack (intent, replan, agent advice, tested candidates, verification)</label>
    <label class="field" style="max-width:240px"><span>Recovery loops</span><input type="number" min="1" max="4" value="${Number(
      s.recoveryMaxAttempts ?? 2
    )}" data-scope="settings" data-key="recoveryMaxAttempts" /><span class="help">Maximum recovery retries after the original run fails.</span></label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="replanMedia" ${
      s.replanMedia !== false ? 'checked' : ''
    } /> Let the AI revision plan video and playback steps</label>
    <div class="field-row">
      <label class="field"><span>Presenter settle window (ms)</span><input type="number" min="0" max="10000" value="${Number(
        s.presenterSettleMs ?? 2000
      )}" data-scope="settings" data-key="presenterSettleMs" /><span class="help">Every live step waits this long, then re-reads the foreground app before it is declared done.</span></label>
      <label class="field"><span>When input is needed</span><select data-scope="settings" data-key="presenterInputPolicy">
        <option value="auto" ${s.presenterInputPolicy !== 'wait' && s.presenterInputPolicy !== 'stop' ? 'selected' : ''}>Auto-continue on a timer</option>
        <option value="wait" ${s.presenterInputPolicy === 'wait' ? 'selected' : ''}>Wait for the user</option>
        <option value="stop" ${s.presenterInputPolicy === 'stop' ? 'selected' : ''}>Stop the run</option>
      </select></label>
      <label class="field"><span>Auto-continue after (seconds)</span><input type="number" min="1" max="120" value="${Math.round(
        (s.presenterAutoContinueMs || 15000) / 1000
      )}" data-scope="settings" data-key="presenterAutoContinueSeconds" /></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Wait for the user (seconds)</span><input type="number" min="1" max="60" value="${Math.round(
        (s.presenceHoldMs ?? 10000) / 1000
      )}" data-scope="settings" data-key="presenceHoldSeconds" /><span class="help">A step that would take focus waits until the desktop has been quiet this long after the user stops moving.</span></label>
      <label class="field"><span>Longest wait (seconds)</span><input type="number" min="1" max="300" value="${Math.round(
        (s.presenceMaxDeferMs ?? 60000) / 1000
      )}" data-scope="settings" data-key="presenceMaxDeferSeconds" /><span class="help">After this, the run continues and finishes what it can silently.</span></label>
    </div>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="presenceEnabled" ${
      s.presenceEnabled !== false ? 'checked' : ''
    } /> Wait for the user instead of taking focus mid-typing</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="autoActEnabled" ${
      s.autoActEnabled ? 'checked' : ''
    } /> Allow habit auto-act (bounded: at most 2 automatic retries per chain)</label>
    <div class="section-gap"><h3 class="settings-subhead">Live step thinking</h3></div>
    <p class="dim small" style="margin:-2px 0 8px">Cheap by default: one combined desktop read per step and no model call. Thinking drafts at least five candidate continuations, pre-tests each against what it just saw, narrates what it is considering and why, and keeps the rejected options for review. Nothing is clicked or typed from the loop; the best prepared correction is tried first when the step fails, and stops being offered as the rejects add up.</p>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="stepThinkEnabled" ${thinkValue('enabled', true) ? 'checked' : ''} /> Think while each live step runs</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="stepThinkLiveLink" ${thinkValue('liveLink', true) ? 'checked' : ''} /> Live-link the thoughts into the run log</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="stepThinkModelAssist" ${thinkValue('modelAssist', false) ? 'checked' : ''} /> Let the model review the sampled choices while the step runs</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="stepThinkAutoApply" ${thinkValue('autoApply', true) ? 'checked' : ''} /> Auto-apply the prepared correction when a step fails (reject-rate limited)</label>
    <div class="field-row">
      <label class="field"><span>Choices per step</span><input type="number" min="3" max="12" value="${Number(thinkValue('maxChoices', 7))}" data-scope="settings" data-key="stepThinkMaxChoices" /></label>
      <label class="field"><span>Sample width (pixels)</span><input type="number" min="0" max="100" value="${Number(thinkValue('pixels', 48))}" data-scope="settings" data-key="stepThinkPixels" /><span class="help">0 turns the sampled frame off.</span></label>
      <label class="field"><span>Elements read</span><input type="number" min="0" max="200" value="${Number(thinkValue('elements', 25))}" data-scope="settings" data-key="stepThinkElements" /><span class="help">Focused control plus nearby elements; independent of pixels.</span></label>
    </div>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="stepThinkReadOnce" ${thinkValue('readOnce', true) ? 'checked' : ''} /> Read the desktop once per step (one combined observation)</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="stepThinkHigherThinking" ${thinkValue('higherThinking', false) ? 'checked' : ''} /> Higher thinking — live re-reads, model review and an overseer verdict</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="stepThinkOverseer" ${thinkValue('overseer', false) ? 'checked' : ''} /> Add the overseer verdict to each step (recommendation, why, original step preserved)</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="stepThinkKeepRunning" ${thinkValue('keepRunning', false) ? 'checked' : ''} /> Keep the workflow running after a failed step (unguarded input steps are skipped)</label>
    <div class="field-row">
      <label class="field"><span>Live re-read every (ms)</span><input type="number" min="500" max="30000" value="${Number(thinkValue('monitorIntervalMs', 3000))}" data-scope="settings" data-key="stepThinkMonitorMs" /><span class="help">Used only when live monitoring or higher thinking is on.</span></label>
      <label class="field"><span>Keep running after (failed steps)</span><input type="number" min="1" max="20" value="${Number(thinkValue('maxStepFailures', 3))}" data-scope="settings" data-key="stepThinkMaxStepFailures" /></label>
      <label class="field"><span>Replans per run</span><input type="number" min="0" max="10" value="${Number(thinkValue('maxReplans', 2))}" data-scope="settings" data-key="stepThinkMaxReplans" /><span class="help">Lets the engine reorganise the remaining steps after repeated failures.</span></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Preview rate (ms)</span><input type="number" min="500" max="15000" value="${Number(thinkValue('previewIntervalMs', 2000))}" data-scope="settings" data-key="stepThinkPreviewMs" /></label>
      <label class="field"><span>AI mirror rate (ms)</span><input type="number" min="500" max="30000" value="${Number(thinkValue('mirrorIntervalMs', 4000))}" data-scope="settings" data-key="stepThinkMirrorMs" /></label>
    </div>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="stepThinkSideBySide" ${thinkValue('sideBySide', false) ? 'checked' : ''} /> Show the operator preview and the AI mirror side by side</label>
    <div class="section-gap"><h3 class="settings-subhead">Pending recheck</h3></div>
    <p class="dim small" style="margin:-2px 0 8px">A restart, retry or replan keeps the steps that already passed instead of opening a second Notepad. Steps that failed or sat pending past the allowance get a bounded re-read with a fresh screenshot, and anything still open becomes a task for the operator.</p>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="recheckEnabled" ${recheckValue('enabled', true) ? 'checked' : ''} /> Recheck failed and stalled steps before giving up</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="recheckContinueAfter" ${recheckValue('continueAfter', false) ? 'checked' : ''} /> Continue the run after the recheck — completed steps are passed through, not repeated</label>
    <div class="field-row">
      <label class="field"><span>Prep allowance (ms)</span><input type="number" min="0" max="60000" value="${Number(recheckValue('prepMs', 4000))}" data-scope="settings" data-key="recheckPrepMs" /><span class="help">Quiet time before the first re-read.</span></label>
      <label class="field"><span>Attempts</span><input type="number" min="1" max="10" value="${Number(recheckValue('maxAttempts', 3))}" data-scope="settings" data-key="recheckMaxAttempts" /><span class="help">Screenshot reads per open step.</span></label>
      <label class="field"><span>Retry timing (ms)</span><input type="number" min="250" max="60000" value="${Number(recheckValue('intervalMs', 3000))}" data-scope="settings" data-key="recheckIntervalMs" /><span class="help">Grows linearly between attempts.</span></label>
    </div>
    <label class="field"><span>Pending allowance (ms)</span><input type="number" min="1000" max="600000" value="${Number(recheckValue('maxPendingMs', 45000))}" data-scope="settings" data-key="recheckMaxPendingMs" /><span class="help">A step pending longer than this counts as stalled.</span></label>
    <div class="section-gap"><h3 class="settings-subhead">Companion</h3></div>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="companionEnabled" ${
      s.companionEnabled !== false ? 'checked' : ''
    } /> Enable the companion and its learned quick help</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="companionLearning" ${
      s.companionLearning !== false ? 'checked' : ''
    } /> Learn apps, files, questions and typed inputs from completed runs</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="companionNotifications" ${
      s.companionNotifications !== false ? 'checked' : ''
    } /> Allow companion notifications and popups</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="companionSystemScan" ${
      s.companionSystemScan !== false ? 'checked' : ''
    } /> Let the companion read disk, RAM, browser-memory and Recycle Bin levels (read-only)</label>
    <div class="field-row">
      <label class="field"><span>Companion popups</span><select data-scope="settings" data-key="companionPopupPolicy">
        <option value="off" ${s.companionPopupPolicy === 'off' ? 'selected' : ''}>Off</option>
        <option value="important" ${!s.companionPopupPolicy || s.companionPopupPolicy === 'important' ? 'selected' : ''}>Important only</option>
        <option value="all" ${s.companionPopupPolicy === 'all' ? 'selected' : ''}>Everything</option>
      </select></label>
    </div>
    <div class="section-gap"><h3 class="settings-subhead">Continuity verifier</h3></div>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="continuityEnabled" ${
      s.continuityEnabled !== false ? 'checked' : ''
    } /> Enable the separate continuity verifier and its background checks</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="continuityFrameWatch" ${
      s.continuityFrameWatch !== false ? 'checked' : ''
    } /> Capture frames while a run waits and compare them with the previous frame</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="continuityAutoContinue" ${
      s.continuityAutoContinue !== false ? 'checked' : ''
    } /> Allow auto-continuation when checks agree and a tested recovery candidate exists</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="continuityAiReview" ${
      s.continuityAiReview === true ? 'checked' : ''
    } /> Let the verifier ask the model to inspect the latest frame automatically</label>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="continuityVisionReadiness" ${
      s.continuityVisionReadiness === true ? 'checked' : ''
    } /> Let the vision model judge unobservable waits (cached 30 s, never blocks a tick)</label>
    <div class="field-row">
      <label class="field"><span>Frame interval (ms)</span><input type="number" min="1000" max="60000" value="${Number(
        s.continuityFrameMs ?? 5000
      )}" data-scope="settings" data-key="continuityFrameMs" /></label>
      <label class="field"><span>AI frame review</span><span class="help">The “Ask AI on latest frame” button always works; automatic calls are off by default to avoid spending model time on every tick.</span></label>
    </div>
    <label class="field"><span>Habit auto-act threshold (%)</span><input type="number" min="1" max="100" value="${Number(
      s.autoActThreshold ?? 80
    )}" data-scope="settings" data-key="autoActThreshold" /><span class="help">The Presentation tab uses this to decide whether a learned habit is strong enough to act automatically.</span></label>
    <div class="field-row">
      <label class="field"><span>Mission check every (seconds)</span><input type="number" min="1" max="60" value="${Math.round(
        (s.missionCheckIntervalMs || 5000) / 1000
      )}" data-scope="settings" data-key="missionCheckIntervalSeconds" /></label>
      <label class="field"><span>Replan model</span><input type="text" value="${esc(
        s.replanModel || ''
      )}" data-scope="settings" data-key="replanModel" placeholder="blank = main model" /><span class="help">Optional second model for research and replanning.</span></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Visual tester URL</span><input type="text" value="${esc(
        s.visualTesterUrl || ''
      )}" data-scope="settings" data-key="visualTesterUrl" placeholder="http://127.0.0.1:8790/visual-test" /><span class="help">External program that receives a screenshot plus workflow context. The bearer token, if needed, stays in SIGHTLINE_VISUAL_TESTER_TOKEN.</span></label>
      <label class="field"><span>Visual tester timeout (ms)</span><input type="number" min="1000" max="120000" value="${Number(
        s.visualTesterTimeoutMs || 25000
      )}" data-scope="settings" data-key="visualTesterTimeoutMs" /></label>
    </div>
    <label class="check" style="margin-bottom:6px"><input type="checkbox" data-scope="settings" data-key="visualTesterEnabled" ${
      s.visualTesterEnabled !== false ? 'checked' : ''
    } /> Send screenshots to the external visual tester when requested</label>`;
}

/* ------------------------------------------------------------------ continuity */
function renderContinuity() {
  const c = ui.continuity || ui.data?.continuity;
  if (!c) {
    return `<div class="page-head"><div><h1>Continuity verifier</h1><p>The separate verification engine is loading.</p></div><div class="page-head-actions"><button class="btn" data-act="continuity-scan">Scan now</button></div></div>`;
  }
  const summary = c.summary || {};
  const latest = (c.verdicts || [])[0] || null;
  const active = c.active || null;
  const windowState = active?.window || c.window || latest?.window || null;
  const frame = active?.frame || c.frame || latest?.frame || null;
  const checks = active?.checks?.length ? active.checks : latest?.checks || [];
  const triggers = active?.triggers?.length ? active.triggers : latest?.triggers || [];
  const suggestions = (c.suggestions || []).filter((entry) => entry.status === 'open');
  const continuations = (c.continuations || []).filter((entry) => ['ready', 'blocked', 'retrying'].includes(entry.status));
  const runId = latest?.runId || active?.runId || null;
  const statusTone = latest?.status === 'ready' ? 'ok' : latest?.status ? 'paused' : '';
  return `
  <div class="page-head">
    <div>
      <h1>Continuity verifier <span class="pill ${statusTone}">${esc(c.enabled ? latest?.status || 'observing' : 'paused')}</span></h1>
      <p>A separate engine watches frames, triggers, links, coordinates and the current wording while a workflow waits. It does not replace the main loop: it proves what changed, explains minimized/background/closed windows, and only drafts or continues when the evidence and safety checks agree.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn btn-sm btn-ghost" data-act="open-settings">Preferences</button>
      <button class="btn btn-sm" data-act="continuity-ai" ${!runId || ui.continuityBusy ? 'disabled' : ''}>${ui.continuityBusy === 'ai' ? 'Asking…' : 'Ask AI on latest frame'}</button>
      <button class="btn btn-sm btn-primary" data-act="continuity-scan" ${ui.continuityBusy === 'scan' ? 'disabled' : ''}>${ui.continuityBusy === 'scan' ? 'Capturing…' : 'Capture / scan now'}</button>
    </div>
  </div>

  <div class="companion-hero">
    <div><span class="dim small">Verdict score</span><strong>${summary.lastScore != null ? `${summary.lastScore}%` : '—'}</strong></div>
    <div><span class="dim small">Window</span><strong>${esc(summary.windowState || 'unknown')}</strong></div>
    <div><span class="dim small">Open suggestions</span><strong>${summary.openSuggestions || 0}</strong></div>
    <div><span class="dim small">Ready continuations</span><strong>${summary.readyContinuations || 0}</strong></div>
    <div><span class="dim small">Frame checks</span><strong>${c.scans || 0}</strong></div>
    <div><span class="dim small">Last scan</span><strong>${fmtTime(c.lastTickAt)}</strong></div>
  </div>

  <div class="companion-grid">
    <section class="card">
      <div class="card-head"><h3>Latest verdict</h3><span class="dim small">${active ? `watching ${esc(active.workflowName || active.runId)}` : latest ? `run ${esc(latest.runId || '')}` : 'no run yet'}</span></div>
      <div class="card-body stack">
        ${latest ? `<div class="row wrap"><span class="badge ${latest.status === 'ready' ? 'okbadge' : 'warnbadge'}">${esc(latest.status)}</span><span class="badge">${latest.score}%</span>${latest.ai ? `<span class="badge">AI: ${esc(latest.ai.decision)} · ${Math.round((latest.ai.confidence || 0) * 100)}%</span>` : ''}</div><p class="small muted">${esc(latest.summary || '')}</p>` : '<p class="muted small">No verdict yet. A scan captures a frame and checks the active or latest run.</p>'}
        ${latest?.ai ? `<div class="hint-box"><b>AI common sense · ${esc(latest.ai.decision)}</b><p>${esc(latest.ai.summary || '')}</p>${latest.ai.trigger ? `<div class="small">Trigger: ${esc(latest.ai.trigger)}</div>` : ''}${latest.ai.updatedText ? `<div class="small">Updated text: “${esc(latest.ai.updatedText)}”</div>` : ''}${latest.ai.fallback ? `<div class="small">Fallback: ${esc(latest.ai.fallback)}</div>` : ''}</div>` : ''}
        <div class="stack">
          ${checks.length ? checks.map((item) => `<div class="companion-help"><div><strong>${esc(item.label)}</strong><span class="dim small">${esc(item.detail)}</span></div><span class="badge ${item.status === 'pass' ? 'okbadge' : 'warnbadge'}">${esc(item.key)} · ${esc(item.status)}</span></div>`).join('') : '<p class="muted small">Checks appear after the first review.</p>'}
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Window &amp; frame</h3><span class="dim small">${active?.decision ? `decision: ${esc(active.decision)}` : 'foreground / background / minimized / closed'}</span></div>
      <div class="card-body stack">
        ${active ? `<div class="hint-box"><div class="row wrap"><strong>Active ${esc(active.waiting ? 'wait' : 'step')}</strong><span class="badge ${active.decision === 'advance' ? 'okbadge' : active.decision === 'hold' || active.decision === 'inspect' ? 'warnbadge' : ''}">${esc(active.decision || 'observe')}</span><span class="dim small">${esc(active.stepName || 'step pending')} · ${esc(active.runId)}</span></div><div class="row wrap" style="gap:5px;margin-top:6px"><button class="btn btn-sm" data-act="run-control" data-id="${esc(active.runId)}" data-cmd="pause">Pause</button><button class="btn btn-sm" data-act="run-control" data-id="${esc(active.runId)}" data-cmd="skip">Skip step</button><button class="btn btn-sm btn-danger" data-act="cancel-run" data-id="${esc(active.runId)}">Cancel</button><button class="btn btn-sm" data-act="select-run" data-id="${esc(active.runId)}">Open run</button></div></div>` : ''}
        <div class="companion-system">
          <div><span class="dim small">Target state</span><strong>${esc(windowState?.state || 'unknown')}</strong></div>
          <div><span class="dim small">Process running</span><strong>${windowState?.processRunning == null ? '—' : windowState.processRunning ? 'yes' : 'no'}</strong></div>
          <div><span class="dim small">Foreground</span><strong>${esc(windowState?.foreground?.process || '—')}</strong></div>
          <div><span class="dim small">Frame change</span><strong>${frame?.changedPct != null ? `${Math.round(frame.changedPct * 100)}%` : '—'}</strong></div>
        </div>
        ${windowState?.foreground?.title ? `<p class="small muted">Focused window: ${esc(windowState.foreground.title)}</p>` : ''}
        ${(windowState?.matches || []).length ? `<div class="chip-row">${windowState.matches.map((match) => `<span class="badge">${esc(match.state)} · ${esc(match.process)}${match.title ? ` — ${esc(match.title)}` : ''}</span>`).join('')}</div>` : ''}
        ${frame?.path ? `<img src="/api/files/raw?path=${encodeURIComponent(frame.path)}" alt="Continuity frame" style="width:100%;border:1px solid var(--line);border-radius:6px" />` : `<div class="hint-box">${esc(frame?.note || 'No frame yet. A scan captures the screen when live; dry runs only use simulated evidence.')}</div>`}
        ${latest?.summary ? `<p class="small muted">${esc(latest.summary)}</p>` : ''}
      </div>
    </section>
  </div>

  <div class="companion-grid section-gap">
    <section class="card">
      <div class="card-head"><h3>Suggested workflow updates</h3><span class="dim small">${suggestions.length} open</span></div>
      <div class="card-body stack">
        ${suggestions.length ? suggestions.map((item) => `<div class="companion-proposal"><div class="row wrap"><strong>${esc(item.title)}</strong><span class="badge">draft</span></div><p>${esc(item.detail)}</p>${(item.changes || []).length ? `<div class="hint-box">${item.changes.map((change) => `<div class="small"><b>${esc(change.title || change.kind)}</b>${change.proposedText ? ` → “${esc(change.proposedText)}”` : ''}</div>`).join('')}</div>` : ''}<div class="row"><button class="btn btn-sm btn-primary" data-act="continuity-prepare" data-id="${esc(item.id)}" ${ui.continuityBusy === item.id ? 'disabled' : ''}>${item.preparedWorkflowId ? 'Open draft' : 'Prepare draft'}</button><button class="btn btn-sm btn-ghost" data-act="continuity-dismiss" data-id="${esc(item.id)}">Dismiss</button></div></div>`).join('') : '<p class="muted small">No draft is needed. The verifier only creates one when the current wording, links, coordinates, focus or trigger sequence needs a change.</p>'}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Triggers &amp; continuations</h3><span class="dim small">evidence first</span></div>
      <div class="card-body stack">
        ${triggers.length ? triggers.map((trigger) => `<div class="companion-help"><div><strong>${esc(trigger.stepName || trigger.stepId)}</strong><span class="dim small">waiting for ${esc(trigger.kind)} “${esc(trigger.value || '')}” · ${trigger.ready == null ? 'not observed' : trigger.ready ? 'ready' : 'not ready'}${c.active && c.active.stepId === trigger.stepId ? ` · ${esc(c.active.readiness || 'unknown')}${c.active.waitedMs != null ? ` · ${Math.round(c.active.waitedMs / 1000)}s` : ''} · ${esc(c.active.decision || '')}` : ''}</span>${c.active && c.active.stepId === trigger.stepId && c.active.readinessNote ? `<div class="dim small">model: ${esc(c.active.readinessNote)}</div>` : ''}</div></div><span class="badge ${trigger.ready ? 'okbadge' : 'warnbadge'}">${esc(trigger.mode || 'present')}</span></div>`).join('') : '<p class="muted small">No explicit trigger is selected. Pick a waitFor/expect step or run a scan while the workflow waits.</p>'}
        <div><span class="dim small">Continuation queue</span>${continuations.length ? continuations.map((item) => `<div class="companion-continuation"><div><strong>${esc(item.runId)}</strong><span class="dim small">${esc(item.status)} · ${esc(item.reason || '')}${item.blockedReason ? ` · ${esc(item.blockedReason)}` : ''}</span></div><button class="btn btn-sm" data-act="continuity-continue" data-id="${esc(item.runId)}" data-retry="${item.status === 'retrying' && item.retryRunId ? esc(item.retryRunId) : ''}">${item.status === 'retrying' ? 'View retry' : item.ready ? 'Review & approve' : 'Review'}</button></div>`).join('') : '<p class="muted small">No continuation is waiting. Auto-continuation stays off unless the setting is enabled and a tested recovery candidate exists.</p>'}${ui.continuityReview ? `<div class="hint-box"><div class="row wrap"><strong>Recovery review · ${esc(ui.continuityReview.runId)}</strong><span class="badge">${esc(ui.continuityReview.packStatus || 'planning')}</span></div>${(ui.continuityReview.candidates || []).length ? ui.continuityReview.candidates.map((candidate) => `<div class="companion-proposal"><div class="row wrap"><strong>${esc(candidate.label || candidate.id)}</strong><span class="badge ${candidate.test?.ok ? 'okbadge' : 'warnbadge'}">${esc(candidate.test?.ok ? 'tested' : candidate.test?.status || 'untested')}</span><span class="dim small">${candidate.score != null ? `${Math.round(Number(candidate.score))}%` : ''}</span></div><p class="dim small">${esc(candidate.reason || '')}</p>${(candidate.steps || []).length ? `<details><summary class="small">${candidate.steps.length} step(s)</summary><ol class="small">${candidate.steps.map((step) => `<li>${esc(step.name || step.type)} <span class="mono dim">${esc(step.type)}</span></li>`).join('')}</ol></details>` : ''}<button class="btn btn-sm btn-primary" data-act="continuity-approve" data-id="${esc(ui.continuityReview.runId)}" data-candidate="${esc(candidate.id)}" ${candidate.test?.ok ? '' : 'disabled'}>Approve this retry</button></div>`).join('') : '<p class="muted small">No tested candidate is ready. Review the recovery pack or retry planning before approving anything.</p>'}<div class="row"><button class="btn btn-sm btn-ghost" data-act="continuity-review-clear">Cancel review</button>${(ui.continuityReview.candidates || []).some((candidate) => candidate.test?.ok) ? '' : `<button class="btn btn-sm" data-act="continuity-replan" data-id="${esc(ui.continuityReview.packId)}" ${ui.continuityBusy === ui.continuityReview.packId ? 'disabled' : ''}>${ui.continuityBusy === ui.continuityReview.packId ? 'Planning…' : 'Retry planning'}</button>`}</div></div>` : ''}</div>
        <div><span class="dim small">Recent continuity events</span><div class="stack">${(c.events || []).slice(0, 6).map((item) => `<div class="dim small"><span class="mono">${fmtTime(item.at)}</span> · ${esc(item.message)}</div>`).join('') || '<span class="dim small">none yet</span>'}</div></div>
      </div>
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ companion */
function renderCompanion() {
  const c = ui.companion || ui.data?.companion;
  if (!c) {
    return `<div class="page-head"><div><h1>Companion</h1><p>The companion is loading its learned habits and proposals.</p></div><div class="page-head-actions"><button class="btn" data-act="companion-scan">Scan now</button></div></div>`;
  }
  const h = c.habits || {};
  const apps = (h.apps || []).slice(0, 6);
  const files = (h.files || []).slice(0, 6);
  const timings = (h.timings || []).slice(0, 5);
  const transitions = (h.transitions || []).slice(0, 4);
  const questions = (h.inputs || []).filter((item) => item.kind === 'question').slice(0, 4);
  const inputs = (h.inputs || []).filter((item) => item.kind === 'text').slice(0, 4);
  const routines = (h.routines || []).slice(0, 4);
  const patterns = c.patterns || [];
  const proposals = c.proposals || [];
  const quick = c.quickHelp || [];
  const notifications = c.notifications || [];
  const continuations = (c.continuations || []).filter((item) => ['needs_attention', 'retrying'].includes(item.status)).slice(0, 5);
  const summary = c.summary || {};
  const system = c.system || {};
  const status = c.enabled ? 'learning' : 'paused';
  return `
  <div class="page-head">
    <div>
      <h1>Companion <span class="pill ${c.enabled ? 'ok' : 'paused'}">${esc(status)}</span></h1>
      <p>A persistent helper that watches completed runs, remembers apps, files, questions, inputs and timing, then proposes the next safe move. It learns from evidence, not assumptions; you can pause or correct it at any time.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn btn-sm btn-ghost" data-act="open-settings">Preferences</button>
      <button class="btn btn-sm" data-act="companion-notify-permission">Enable desktop alerts</button>
      <button class="btn btn-sm btn-primary" data-act="companion-scan" ${ui.companionBusy === 'scan' ? 'disabled' : ''}>${ui.companionBusy === 'scan' ? 'Scanning…' : 'Scan now'}</button>
    </div>
  </div>

  <div class="companion-hero">
    <div><span class="dim small">Learned apps</span><strong>${summary.apps || 0}</strong></div>
    <div><span class="dim small">Files / topics</span><strong>${summary.files || 0}</strong></div>
    <div><span class="dim small">Questions remembered</span><strong>${summary.questions || 0}</strong></div>
    <div><span class="dim small">Patterns</span><strong>${summary.patterns || 0}</strong></div>
    <div><span class="dim small">Pending proposals</span><strong>${summary.proposals || 0}</strong></div>
    <div><span class="dim small">Unread alerts</span><strong>${summary.unread || 0}</strong></div>
  </div>

  <div class="companion-grid">
    <section class="card">
      <div class="card-head"><h3>Quick help</h3><span class="dim small">learned, one click</span></div>
      <div class="card-body stack">
        ${
          quick.length
            ? quick.map((item) => `<div class="companion-help"><div><strong>${esc(item.label)}</strong><span class="dim small">${esc(item.detail || '')}</span></div><div class="row"><span class="badge">${esc(item.confidence || 0)}%</span><button class="btn btn-sm btn-ghost" data-act="companion-quick" data-id="${esc(item.id)}" ${ui.companionBusy === item.id ? 'disabled' : ''}>${ui.companionBusy === item.id ? 'Working…' : 'Use'}</button><button class="btn-icon" data-act="companion-quick-dismiss" data-id="${esc(item.id)}" title="Hide this suggestion">✕</button></div></div>`).join('')
            : '<p class="muted small">No quick help yet. Complete a run or scan again after using apps, files or questions.</p>'
        }
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Proposals for you</h3><span class="dim small">approve or dismiss</span></div>
      <div class="card-body stack">
        ${
          proposals.length
            ? proposals.map((p) => `<div class="companion-proposal ${p.tone === 'important' ? 'important' : ''}"><div class="row wrap"><strong>${esc(p.title)}</strong><span class="badge">${esc(p.kind)}</span></div><p>${esc(p.detail)}</p><div class="hint-box"><b>Expected outcome:</b> ${esc(p.expected || 'No outcome recorded yet.')}</div>${p.suggestedName ? `<div class="dim small">Suggested filename <span class="mono">${esc(p.suggestedName)}</span></div>` : ''}<div class="dim small">${(p.evidence || []).map(esc).join(' · ')}</div><div class="row"><button class="btn btn-sm btn-primary" data-act="companion-proposal" data-id="${esc(p.id)}" data-action="accept">Use this plan</button><button class="btn btn-sm btn-ghost" data-act="companion-proposal" data-id="${esc(p.id)}" data-action="dismiss">Not now</button></div></div>`).join('')
            : '<p class="muted small">No pending proposals. The companion will suggest a new file, research, cleanup or continuation when the evidence supports it.</p>'
        }
      </div>
    </section>
  </div>

  <div class="companion-grid section-gap">
    <section class="card">
      <div class="card-head"><h3>What I learned</h3><span class="dim small">${patterns.length} patterns</span></div>
      <div class="card-body stack">
        ${patterns.slice(0, 8).map((p) => `<div class="companion-pattern"><div class="row wrap"><strong>${esc(p.label)}</strong><span class="badge">${esc(p.kind)}</span><span class="dim small">${esc(p.confidence)}%</span></div><p class="small muted">${esc(p.detail)}</p></div>`).join('') || '<p class="muted small">No patterns yet.</p>'}
        <div class="section-gap"><span class="dim small">Apps</span><div class="chip-row">${apps.map((a) => `<span class="badge">${esc(a.name || a.key)} · ${a.count}</span>`).join('') || '<span class="dim small">none yet</span>'}</div></div>
        <div><span class="dim small">Files / topics</span><div class="chip-row">${files.map((f) => `<span class="badge">${esc(f.name || fileNameLabel(f.path))} · ${f.count}</span>`).join('') || '<span class="dim small">none yet</span>'}</div></div>
        <div><span class="dim small">Routines</span><div class="chip-row">${routines.map((r) => `<span class="badge">${esc(r.label)} · ${r.count}</span>`).join('') || '<span class="dim small">none yet</span>'}</div></div>
        <div><span class="dim small">Questions</span><div class="stack">${questions.map((q) => `<span class="small muted">“${esc(q.value)}”</span>`).join('') || '<span class="dim small">none yet</span>'}</div></div>
        <div><span class="dim small">Remembered inputs</span><div class="stack">${inputs.map((q) => `<span class="small muted">${esc(q.label)}: “${esc(q.value)}”</span>`).join('') || '<span class="dim small">No form inputs recorded; passwords and secrets are skipped.</span>'}</div></div>
        <div><span class="dim small">Timing profile</span><div class="chip-row">${timings.map((t) => `<span class="badge">${esc(t.action || t.key)} · ${Math.round(Number(t.avgMs) || 0)}ms</span>`).join('') || '<span class="dim small">none yet</span>'}</div></div>
        <div><span class="dim small">App transitions</span><div class="chip-row">${transitions.map((t) => `<span class="badge">${esc(t.from)} → ${esc(t.to)} · ${t.count}</span>`).join('') || '<span class="dim small">none yet</span>'}</div></div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>System awareness</h3><span class="dim small">${c.settings?.systemScan === false ? 'paused' : 'safe scan'}</span></div>
      <div class="card-body stack">
        <div class="companion-system">
          <div><span class="dim small">Disk free</span><strong>${system.diskFreeGb != null ? `${system.diskFreeGb} GB` : '—'}</strong></div>
          <div><span class="dim small">RAM used</span><strong>${system.ramUsedPct != null ? `${system.ramUsedPct}%` : '—'}</strong></div>
          <div><span class="dim small">Browser memory</span><strong>${system.browserMb != null ? `${system.browserMb} MB` : '—'}</strong></div>
          <div><span class="dim small">Recycle items</span><strong>${system.recycleItems != null ? system.recycleItems : '—'}</strong></div>
          <div><span class="dim small">Duplicate outputs</span><strong>${system.duplicates != null ? system.duplicates : '—'}</strong></div>
        </div>
        <p class="dim small">Scan time ${fmtTime(system.at)}. Cleanup, backups and browser switches are proposals only until you approve them here or in a workflow.</p>
        <div><span class="dim small">Consistency check · ${summary.checksOk || 0}/${summary.checksTotal || 0}</span><div class="stack">${(c.checks || []).map((check) => `<div class="companion-help"><span class="small ${check.ok ? '' : 'muted'}">${check.ok ? '✓' : '!'} ${esc(check.detail)}</span><span class="badge ${check.ok ? 'okbadge' : 'warnbadge'}">${esc(check.key)}</span></div>`).join('')}</div></div>
        <div><span class="dim small">Screen memory</span><div class="chip-row">${(ui.data?.positionMemory || []).slice(0, 4).map((p) => `<span class="badge">${esc(p.action || 'point')} @ ${p.x},${p.y} · ${p.similarity || 0}%</span>`).join('') || '<span class="dim small">Learned from coordinate steps only.</span>'}</div></div>
  <div><span class="dim small">Continuation queue</span>${continuations.length ? continuations.map((item) => `<div class="companion-continuation"><div><strong>${esc(item.workflowName || item.workflowId)}</strong><span class="dim small">${esc(item.status)} · ${esc(item.reason || '')}</span></div><button class="btn btn-sm" data-act="companion-continue" data-id="${esc(item.runId)}" data-retry="${item.status === 'retrying' && item.retryRunId ? esc(item.retryRunId) : ''}">${item.status === 'retrying' ? 'View retry' : 'Retry / continue'}</button></div>`).join('') : '<p class="muted small">No failed run is waiting.</p>'}</div>
      </div>
    </section>
  </div>

  <div class="companion-grid section-gap">
    <section class="card">
      <div class="card-head"><h3>Notifications</h3><div class="row"><button class="btn btn-sm btn-ghost" data-act="companion-read-all">Mark all read</button></div></div>
      <div class="card-body stack">${notifications.length ? notifications.map((n) => `<div class="companion-notification ${n.read ? '' : 'unread'} ${n.important ? 'important' : ''}"><div class="row wrap"><strong>${esc(n.title)}</strong><span class="badge">${esc(n.kind || 'note')}</span><span class="dim small">${fmtTime(n.at)}</span></div><p>${esc(n.body || '')}</p>${n.read ? '' : `<button class="btn btn-sm btn-ghost" data-act="companion-read" data-id="${esc(n.id)}">Mark read</button>`}</div>`).join('') : '<p class="muted small">No notifications yet. I will tell you when a proposal or recovery needs a decision.</p>'}</div>
    </section>
    <section class="card">
      <div class="card-head"><h3>Notes &amp; preferences</h3><span class="dim small">your corrections win</span></div>
      <div class="card-body stack">
        <p class="small muted">Learning: <b>${c.settings?.learning ? 'on' : 'paused'}</b> · popups: <b>${esc(c.settings?.popupPolicy || 'important')}</b>. Change these in <button class="linklike" data-act="open-settings">Settings</button>.</p>
        <div class="field"><span>Tell the companion what matters</span><textarea rows="3" data-scope="companion" data-key="note" placeholder="Example: when a topic exists, create a new file named … instead of overwriting">${esc(ui.companionNote || '')}</textarea></div>
        <button class="btn btn-sm" data-act="companion-note-save">Save note</button>
        ${(c.notes || []).length ? `<div class="stack">${c.notes.slice(0, 5).map((note) => `<div class="dim small">“${esc(note.text)}” <span class="mono">${fmtTime(note.at)}</span></div>`).join('')}</div>` : ''}
      </div>
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ ambient */
function domValue(selector) {
  return String(document.querySelector(selector)?.value ?? '');
}

function announceAmbient(ambient) {
  if (!ambient?.notifications) return;
  const policy = ambient.settings?.popups || 'important';
  const fresh = ambient.notifications.filter((entry) => !entry.read && !ui.ambientSeen.has(entry.id));
  for (const entry of ambient.notifications) ui.ambientSeen.add(entry.id);
  if (!ui.ambientSeenReady) {
    ui.ambientSeenReady = true;
    return;
  }
  if (policy === 'off') return;
  for (const entry of fresh.slice(0, 2)) {
    if (policy === 'important' && !entry.important) continue;
    toast(`Ambient · ${entry.title}`, entry.kind === 'control' ? 'ok' : '');
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(entry.title, { body: entry.body || '', tag: entry.id });
      }
    } catch {}
  }
}

function renderAmbient() {
  const a = ui.data?.ambient;
  if (!a) return '<div class="empty"><strong>Ambient</strong>Loading the frame clock and preferences.</div>';
  const clock = a.clock || {};
  const s = a.settings || {};
  const summary = a.summary || {};
  const win = a.window || {};
  const rules = a.rules || [];
  const schedules = a.schedules || [];
  const proposals = a.proposals || [];
  const actions = a.actions || [];
  const notifications = a.notifications || [];
  const apps = a.habits?.apps || [];
  const transitions = a.habits?.transitions || [];
  const notes = a.notes || [];
  const period = clock.hz ? 1000 / clock.hz : 16.7;
  const load = Math.min(100, Math.round(((Number(clock.workMs) || 0) / period) * 100));
  const live = !ui.data?.settings?.dryRun;
  const lastAction = actions[0];
  const busy = ui.ambientBusy;
  const matched = rules.filter((rule) => rule.enabled && (rule.match?.process || rule.match?.title));
  return `
  <div class="page-head">
    <div>
      <h1>Ambient <span class="pill ${a.enabled ? 'ok' : 'paused'}">${a.enabled ? 'watching' : 'paused'}</span></h1>
      <p>A frame clock that ticks at your monitor refresh rate and a preference model that reacts to the app in front. It resizes windows for comfort, runs your shortcuts, keeps schedules, learns routines and tells you before it touches anything.</p>
    </div>
    <div class="page-head-actions">
      <span class="badge ${live ? 'warnbadge' : ''}">${live ? 'live desktop' : 'simulated'}</span>
      <button class="btn btn-sm btn-ghost" data-act="ambient-refresh-rate" ${busy === 'rate' ? 'disabled' : ''}>${busy === 'rate' ? 'Reading GPU…' : 'Read refresh rate'}</button>
      <button class="btn btn-sm" data-act="ambient-sample" ${busy === 'sample' ? 'disabled' : ''}>${busy === 'sample' ? 'Sampling…' : 'Sample now'}</button>
      <button class="btn btn-sm btn-primary" data-act="ambient-learn" ${busy === 'learn' ? 'disabled' : ''}>${busy === 'learn' ? 'Learning…' : 'Learn routines'}</button>
    </div>
  </div>

  <div class="companion-hero">
    <div><span class="dim small">Refresh clock</span><strong>${esc(clock.hz || 60)} Hz</strong></div>
    <div><span class="dim small">Effective rate</span><strong>${esc(clock.effectiveHz || 0)} Hz</strong></div>
    <div><span class="dim small">Frames</span><strong>${clock.frames || 0}</strong></div>
    <div><span class="dim small">Desktop samples</span><strong>${clock.samples || 0}</strong></div>
    <div><span class="dim small">Rules armed</span><strong>${summary.rulesEnabled || 0}/${summary.rules || 0}</strong></div>
    <div><span class="dim small">Unread alerts</span><strong>${summary.unread || 0}</strong></div>
  </div>

  <div class="companion-grid">
    <section class="card">
      <div class="card-head"><h3>Frame clock</h3><span class="dim small">${clock.running ? 'running' : 'stopped'} · ${esc(clock.hzSource || 'default')}</span></div>
      <div class="card-body stack">
        <div class="ambient-meter" title="Frame work time against one refresh period"><i style="width:${load}%"></i></div>
        <div class="ambient-stats">
          <div><span class="dim small">Period</span><strong>${period.toFixed(1)} ms</strong></div>
          <div><span class="dim small">Frame load</span><strong>${load}%</strong></div>
          <div><span class="dim small">Dropped frames</span><strong>${clock.droppedFrames || 0}</strong></div>
          <div><span class="dim small">Desktop sample every</span><strong>${esc(s.sampleMs || 750)} ms</strong></div>
        </div>
        <p class="small muted">The clock advances one frame every ${period.toFixed(1)} ms like the display and counts frames that elapsed between wakeups, so a slow Windows timer does not make it drift. Reading the foreground window spawns PowerShell, so the desktop is sampled every ${esc(s.sampleMs || 750)} ms instead of once per frame; rule actions fire only when the app actually changes.</p>
        <div class="row wrap">
          <label class="field" style="max-width:150px"><span>Sample interval (ms)</span><input type="number" id="amb-sample-ms" min="250" max="10000" step="50" value="${esc(s.sampleMs || 750)}" /></label>
          <label class="field" style="max-width:170px"><span>Popups</span><select id="amb-popups">${['all', 'important', 'off'].map((value) => `<option value="${value}" ${s.popups === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
          <label class="field" style="max-width:150px"><span>Frame clock</span><label class="check"><input type="checkbox" id="amb-frame-clock" ${s.frameClock !== false ? 'checked' : ''} /> Tick at refresh rate</label></label>
        </div>
        <div class="row">
          <button class="btn btn-sm btn-primary" data-act="ambient-settings-save">Save clock settings</button>
          <button class="switch ${a.enabled ? 'on' : ''}" data-act="ambient-toggle" data-enabled="${!a.enabled}" title="${a.enabled ? 'Pause the ambient agent' : 'Resume the ambient agent'}"></button>
          <span class="dim small">${a.enabled ? 'ambient agent active' : 'ambient agent paused'}</span>
        </div>
        ${clock.lastError ? `<div class="hint-box small">Last note: ${esc(clock.lastError)}</div>` : ''}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>In front right now</h3><span class="dim small">${clock.lastSampleAt ? `sampled ${fmtTime(clock.lastSampleAt)}` : 'no sample yet'}</span></div>
      <div class="card-body stack">
        <div class="ambient-window">
          <div><span class="dim small">App</span><strong>${esc(win.process || 'not sampled')}</strong></div>
          <div><span class="dim small">Window</span><span>${esc(win.title || '—')}</span></div>
        </div>
        <div><span class="dim small">Matching armed rules</span><div class="chip-row">${matched.length ? matched.slice(0, 6).map((rule) => `<span class="badge">${esc(rule.name)}</span>`).join('') : '<span class="dim small">none</span>'}</div></div>
        ${lastAction ? `<div class="hint-box small"><b>Last action:</b> ${esc(lastAction.ruleName || lastAction.name || lastAction.kind)} · ${esc(lastAction.detail || '')} <span class="mono">${fmtTime(lastAction.at)}</span></div>` : '<p class="muted small">No action has fired yet. Rules only act when a matching app comes to the front.</p>'}
        <div><span class="dim small">Comfort presets</span><div class="row wrap" style="gap:6px;margin-top:5px">
          <button class="btn btn-sm btn-ghost" data-act="ambient-preset" data-name="movie">Movie night</button>
          <button class="btn btn-sm btn-ghost" data-act="ambient-preset" data-name="reader">Reading width</button>
          <button class="btn btn-sm btn-ghost" data-act="ambient-preset" data-name="meeting">Meeting split</button>
        </div><span class="dim small">Presets add enabled rules; every one can be paused or deleted below.</span></div>
      </div>
    </section>
  </div>

  <section class="card section-gap">
    <div class="card-head"><h3>Comfort &amp; shortcut rules</h3><span class="dim small">foreground app → action</span></div>
    <div class="card-body stack">
      ${rules.length ? rules.map((rule) => `<div class="ambient-rule ${rule.enabled ? '' : 'off'}">
        <div class="row wrap"><strong>${esc(rule.name)}</strong><span class="badge">${esc(rule.kind)}</span>${rule.layout && rule.layout !== 'none' ? `<span class="badge">${esc(rule.layout)}</span>` : ''}${rule.keys ? `<span class="badge mono">${esc(rule.keys)}</span>` : ''}<span class="spacer"></span><button class="switch ${rule.enabled ? 'on' : ''}" data-act="ambient-rule-toggle" data-id="${esc(rule.id)}" data-enabled="${!rule.enabled}" title="${rule.enabled ? 'Pause rule' : 'Arm rule'}"></button></div>
        <div class="dim small">matches ${esc(rule.matchLabel || 'nothing')} · ${esc(rule.mode === 'always' ? 'every sample' : 'on app change')} · cooldown ${Math.round((rule.cooldownMs || 0) / 1000)}s${rule.lastFiredAt ? ` · last fired ${fmtTime(rule.lastFiredAt)}` : ''}${rule.fireCount ? ` · ${rule.fireCount}×` : ''}</div>
        ${rule.note ? `<div class="small muted">${esc(rule.note)}</div>` : ''}
        <div class="row"><button class="btn btn-sm btn-ghost" data-act="ambient-rule-run" data-id="${esc(rule.id)}" ${busy === rule.id ? 'disabled' : ''}>${busy === rule.id ? 'Testing…' : 'Test on current app'}</button><button class="btn btn-sm btn-ghost" data-act="ambient-rule-delete" data-id="${esc(rule.id)}">Delete</button></div>
      </div>`).join('') : '<p class="muted small">No rules yet. Add one below or start from a preset.</p>'}

      <div class="ambient-form">
        <div class="row wrap">
          <label class="field" style="flex:1;min-width:180px"><span>Rule name</span><input id="amb-rule-name" placeholder="Movie night comfort" /></label>
          <label class="field" style="flex:1;min-width:150px"><span>Process pattern</span><input id="amb-rule-process" placeholder="vlc|mpv|potplayer" /></label>
          <label class="field" style="flex:1;min-width:150px"><span>Window title pattern</span><input id="amb-rule-title" placeholder="episode|movie (optional)" /></label>
        </div>
        <div class="row wrap">
          <label class="field" style="max-width:150px"><span>Kind</span><select id="amb-rule-kind"><option value="comfort">comfort</option><option value="shortcut">shortcut</option><option value="focus">focus</option><option value="notify">notify</option></select></label>
          <label class="field" style="max-width:160px"><span>Layout</span><select id="amb-rule-layout">${['cinema', 'maximize', 'center', 'snapLeft', 'snapRight', 'restore', 'none'].map((value) => `<option value="${value}">${value}</option>`).join('')}</select></label>
          <label class="field" style="flex:1;min-width:150px"><span>Follow-up keys</span><input id="amb-rule-keys" placeholder="f or {F11} (optional)" /></label>
          <label class="field" style="max-width:150px"><span>When</span><select id="amb-rule-mode"><option value="enter">on app change</option><option value="always">every cooldown</option></select></label>
          <label class="field" style="max-width:130px"><span>Cooldown (s)</span><input type="number" id="amb-rule-cooldown" min="5" value="120" /></label>
        </div>
        <div class="row"><button class="btn btn-sm btn-primary" data-act="ambient-rule-add">Add rule</button><span class="dim small">Patterns are regular expressions, matched against the process name and window title.</span></div>
      </div>
    </div>
  </section>

  <div class="companion-grid section-gap">
    <section class="card">
      <div class="card-head"><h3>Scheduled actions</h3><span class="dim small">${schedules.filter((entry) => entry.enabled).length} active</span></div>
      <div class="card-body stack">
        ${schedules.length ? schedules.map((entry) => `<div class="ambient-rule ${entry.enabled ? '' : 'off'}">
          <div class="row wrap"><strong>${esc(entry.name)}</strong><span class="badge">${esc(entry.at)}</span><span class="badge">${esc(entry.action?.kind || 'launch')}</span><span class="badge mono">${esc(entry.action?.target || entry.action?.text || '')}</span><span class="spacer"></span><button class="switch ${entry.enabled ? 'on' : ''}" data-act="ambient-schedule-toggle" data-id="${esc(entry.id)}" data-enabled="${!entry.enabled}"></button></div>
          <div class="dim small">${entry.days?.length ? `days ${entry.days.map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(' ')}` : 'every day'} · ${entry.lastFiredAt ? `last ran ${fmtTime(entry.lastFiredAt)}` : 'not run yet'}${entry.fireCount ? ` · ${entry.fireCount}×` : ''}</div>
          <div class="row"><button class="btn btn-sm btn-ghost" data-act="ambient-schedule-delete" data-id="${esc(entry.id)}">Delete</button></div>
        </div>`).join('') : '<p class="muted small">No schedules yet. Schedules fire once per day at the minute you set.</p>'}
        <div class="ambient-form">
          <div class="row wrap">
            <label class="field" style="flex:1;min-width:150px"><span>Name</span><input id="amb-sch-name" placeholder="Open notes" /></label>
            <label class="field" style="max-width:130px"><span>Time</span><input type="time" id="amb-sch-at" value="09:00" /></label>
            <label class="field" style="max-width:150px"><span>Days (0–6)</span><input id="amb-sch-days" placeholder="1,2,3,4,5" /></label>
          </div>
          <div class="row wrap">
            <label class="field" style="max-width:150px"><span>Action</span><select id="amb-sch-kind"><option value="launch">launch app</option><option value="workflow">run workflow</option><option value="note">write note</option><option value="notify">notify me</option></select></label>
            <label class="field" style="flex:1;min-width:160px"><span>Target / workflow</span><input id="amb-sch-target" placeholder="notepad.exe or workflow id" /></label>
            <label class="field" style="flex:1;min-width:160px"><span>Note or reminder text</span><input id="amb-sch-text" placeholder="optional" /></label>
          </div>
          <div class="row"><button class="btn btn-sm btn-primary" data-act="ambient-schedule-add">Add schedule</button><span class="dim small">Simulated mode records what would run without launching anything.</span></div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Learned habits</h3><span class="dim small">${a.habits?.totalSamples || 0} samples</span></div>
      <div class="card-body stack">
        <div><span class="dim small">Apps in front</span><div class="chip-row">${apps.slice(0, 10).map((app) => `<span class="badge">${esc(app.name)} · ${app.count}× · ${app.dwellSeconds}s${app.topHour != null ? ` · ~${esc(app.topHour)}:00` : ''}</span>`).join('') || '<span class="dim small">Nothing observed yet.</span>'}</div></div>
        <div><span class="dim small">Switches</span><div class="chip-row">${transitions.slice(0, 8).map((entry) => `<span class="badge">${esc(entry.from)} → ${esc(entry.to)} · ${entry.count}</span>`).join('') || '<span class="dim small">No app switches recorded yet.</span>'}</div></div>
        <div><span class="dim small">Suggested routines</span>${proposals.length ? proposals.map((proposal) => `<div class="companion-proposal"><div class="row wrap"><strong>${esc(proposal.title)}</strong><span class="badge">${esc(proposal.kind)}</span></div><p>${esc(proposal.detail)}</p><div class="hint-box small"><b>Expected:</b> ${esc(proposal.expected || '')}</div><div class="row"><button class="btn btn-sm btn-primary" data-act="ambient-proposal" data-id="${esc(proposal.id)}" data-action="accept">Add this routine</button><button class="btn btn-sm btn-ghost" data-act="ambient-proposal" data-id="${esc(proposal.id)}" data-action="dismiss">Not now</button></div></div>`).join('') : '<p class="muted small">Nothing to suggest yet. Use apps normally, then run Learn routines.</p>'}</div>
        <div><span class="dim small">Your notes</span><div class="chip-row">${notes.slice(0, 4).map((note) => `<span class="badge">${esc(note.text)}</span>`).join('') || '<span class="dim small">none yet</span>'}</div></div>
        <div class="field"><span>Preference note</span><textarea rows="2" data-scope="ambient" placeholder="Example: keep the browser on the left during meetings">${esc(ui.ambientNote || '')}</textarea></div>
        <div class="row"><button class="btn btn-sm" data-act="ambient-note-save">Save note</button><span class="spacer"></span><button class="btn btn-sm btn-ghost" data-act="ambient-compact">Tidy history</button></div>
      </div>
    </section>
  </div>

  <div class="companion-grid section-gap">
    <section class="card">
      <div class="card-head"><h3>What the agent did</h3><span class="dim small">${actions.length} recent</span></div>
      <div class="card-body stack">${actions.length ? actions.slice(0, 10).map((action) => `<div class="ambient-action"><div class="row wrap"><strong>${esc(action.ruleName || action.name || action.kind)}</strong><span class="badge ${action.ok ? 'okbadge' : 'warnbadge'}">${action.ok ? 'ok' : 'failed'}</span>${action.simulated ? '<span class="badge">simulated</span>' : ''}<span class="spacer"></span><span class="dim small">${fmtTime(action.at)}</span></div><p class="small muted">${esc(action.detail || '')}</p></div>`).join('') : '<p class="muted small">Nothing yet. Enable a rule, then bring a matching app to the front.</p>'}</div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Notifications</h3><div class="row"><button class="btn btn-sm btn-ghost" data-act="ambient-read-all">Mark all read</button></div></div>
      <div class="card-body stack">${notifications.length ? notifications.slice(0, 10).map((entry) => `<div class="companion-notification ${entry.read ? '' : 'unread'} ${entry.important ? 'important' : ''}"><div class="row wrap"><strong>${esc(entry.title)}</strong><span class="badge">${esc(entry.kind || 'note')}</span><span class="dim small">${fmtTime(entry.at)}</span></div><p>${esc(entry.body || '')}</p>${entry.read ? '' : `<button class="btn btn-sm btn-ghost" data-act="ambient-read" data-id="${esc(entry.id)}">Mark read</button>`}</div>`).join('') : '<p class="muted small">No alerts yet. You get one whenever the agent changes a window, runs a schedule or learns a routine.</p>'}</div>
    </section>
  </div>`;
}

function fileNameLabel(value) {
  return String(value || '').split(/[\\/]/).pop() || String(value || '');
}

/* ------------------------------------------------------------------ agents */
function renderJudgementCard(j) {
  const modes = j.modes || [
    { id: 'gate', label: 'Facts can veto the model' },
    { id: 'facts', label: 'Facts decide when conclusive' },
  ];
  const stats = j.stats || {};
  const reviews = j.reviews || [];
  return `<div class="card section-gap">
    <div class="card-head"><h3>Screen judgement</h3><span class="badge ${reviews.length ? 'warnbadge' : 'okbadge'}">${reviews.length ? `${reviews.length} to review` : 'in agreement'}</span></div>
    <div class="card-body">
      <p class="muted small" style="margin-bottom:10px">Every verifyScreen is read twice from the same moment — the model judges a crop of <strong>this run's own window</strong>, a free deterministic pass checks that window's handle and text — and both readings are kept as evidence behind one verdict. One switch picks who decides: the model, with the facts able to veto a lookalike window, or the facts alone when they are conclusive (which also works when the model is offline).</p>
      <div class="row wrap" style="gap:5px;margin-bottom:10px">
        ${modes.map((mode) => `<button class="chip ${j.mode === mode.id ? 'active' : ''}" data-act="judge-mode" data-mode="${esc(mode.id)}" title="${esc(mode.label)}">${esc(mode.label)}</button>`).join('')}
      </div>
      <div class="row wrap" style="gap:8px;margin-bottom:10px">
        <span class="badge">${stats.total || 0} checked</span>
        <span class="badge">${stats.agree || 0} agree${stats.agreementRate != null ? ` · ${stats.agreementRate}%` : ''}</span>
        <span class="badge">${stats.disagree || 0} disagree</span>
        ${stats.visionOnlyPass ? `<span class="badge">${stats.visionOnlyPass} vision-only pass</span>` : ''}
        ${stats.factsOnlyPass ? `<span class="badge">${stats.factsOnlyPass} facts-only pass</span>` : ''}
        ${j.requireScope ? '<span class="badge">scope required</span>' : ''}
      </div>
      ${j.requireScope ? '<p class="dim small" style="margin:-4px 0 10px">An accepted condition refuses screen checks that name no window.</p>' : ''}
      ${reviews.length
        ? `<div class="stack" style="gap:6px">${reviews.map((review) => `<div class="hint-box small"><strong>${esc(review.title)}</strong>${review.count > 1 ? ` <span class="dim">×${review.count}</span>` : ''}<br><span class="dim">${esc(review.detail)}</span><div class="row" style="gap:6px;margin-top:6px"><button class="btn btn-sm" data-act="judge-review" data-id="${esc(review.id)}" data-decision="accept">Accept</button><button class="btn btn-sm btn-ghost" data-act="judge-review" data-id="${esc(review.id)}" data-decision="dismiss">Dismiss</button></div></div>`).join('')}</div>`
        : '<p class="dim small" style="margin:0">No suggestions waiting. A repeated disagreement becomes one for review — nothing changes the switch on its own.</p>'}
    </div>
  </div>`;
}

function renderAgents() {
  const d = ui.data;
  if (!ui.settingsDraft) ui.settingsDraft = { ...d.settings };
  const s = ui.settingsDraft;
  const activity = d.activity || [];
  return `
  <div class="page-head">
    <div>
      <h1>Tools &amp; agents</h1>
      <p>A supervisor owns the failure queue and delegates to two sub-agents. The scheduler queues Ready workflows on an interval; the watchdog captures missing evidence and writes triage notes. Everything keeps running with the browser closed.</p>
    </div>
    <div class="page-head-actions">
      <span class="badge">${d.agents.filter((a) => a.enabled).length} enabled</span>
      <button class="btn btn-sm" data-nav="command">Command Center →</button>
    </div>
  </div>

  <div class="agents-grid">
    ${d.agents
      .map(
        (a) => `<div class="card agent-card">
        <div class="agent-head">
          <div style="flex:1">
            <div class="row wrap" style="gap:5px"><strong>${esc(a.name)}</strong><span class="badge">${esc(a.role || (a.kind === 'supervisor' ? 'supervisor' : 'sub-agent'))}</span><span class="badge">${esc(a.kind)}</span>${statusPill(a.status || (a.enabled ? 'idle' : 'paused'))}</div>
            <p class="agent-desc" style="margin-top:4px">${esc(a.description || '')}</p>
          </div>
          <button class="switch ${a.enabled ? 'on' : ''}" data-act="agent-toggle" data-id="${a.id}" data-enabled="${!a.enabled}" title="${
          a.enabled ? 'Disable agent' : 'Enable agent'
        }"></button>
        </div>
        ${
          a.kind === 'scheduler'
            ? `<label class="field"><span>Workflow</span><select data-scope="agent" data-id="${a.id}" data-key="workflowId">${d.workflows
                .map((w) => `<option value="${w.id}" ${a.workflowId === w.id ? 'selected' : ''}>${esc(w.name)} · ${w.status}</option>`)
                .join('')}</select></label>
               <div class="field-row">
                 <label class="field"><span>Interval (min)</span><input type="number" min="1" value="${Math.round(
                   (a.intervalMs || 300000) / 60000
                 )}" data-scope="agent" data-id="${a.id}" data-key="intervalMinutes" /></label>
                 <label class="field" style="justify-content:flex-end"><span>Loop</span><label class="check"><input type="checkbox" ${
                   a.stopOnFailure ? 'checked' : ''
                 } data-scope="agent" data-id="${a.id}" data-key="stopOnFailure" /> Stop after first failure</label></label>
               </div>`
            : a.kind === 'supervisor'
            ? `<div class="field"><span>Delegates to</span><p class="small muted">${(a.delegatesTo || [])
                .map((id) => d.agents.find((x) => x.id === id)?.name || id)
                .join(' · ') || 'No sub-agents bound'}</p><p class="dim small">Reviews up to two failures per tick, then hands evidence and note work to the watchdog.</p></div>`
            : a.kind === 'observer'
            ? `<div class="field"><span>Scope</span><p class="small muted">Watches active missions, reads selected screenshots plus the step ledger, and auto-inserts missed in-between steps. Runs at most two observations per tick.</p></div>`
            : a.kind === 'companion'
            ? `<div class="field"><span>Scope</span><p class="small muted">Learns repeat apps, files, questions and typed inputs from completed runs, then proposes new-file, research, backup, cleanup and continuation help. Notifications stay bounded by the companion preferences.</p></div>`
            : `<div class="field"><span>Scope</span><p class="small muted">Watches every failed or needs-review run, once each.</p></div>`
        }
        <div class="agent-stats">
          <span>last tick ${fmtTime(a.lastTickAt)}</span>
          <span>last run ${fmtTime(a.lastRunAt)}</span>
          ${a.kind === 'scheduler' ? `<span>queued ${a.runsStarted || 0}</span>` : a.kind === 'observer' ? `<span>observed ${a.observerCount || 0}</span>` : `<span>triaged ${(a.handled || []).length}</span>`}
        </div>
        <div class="row">
          <button class="btn btn-sm" data-act="agent-tick" data-id="${a.id}">Run now</button>
          <span class="dim small">${a.enabled ? 'active' : 'paused'}</span>
        </div>
        ${
          a.log?.length
            ? `<details class="code-wrap"><summary>Agent log · ${a.log.length}</summary><div class="log-body" style="padding:6px 0 0">${a.log
                .slice(0, 8)
                .map((l) => `<div class="log-line"><span class="t">${fmtTime(l.at)}</span><span class="m">${esc(l.message)}</span></div>`)
                .join('')}</div></details>`
            : ''
        }
      </div>`
      )
      .join('')}
  </div>

  ${renderJudgementCard(d.judgement || { mode: d.settings?.verifyJudgeMode || 'gate', stats: {}, reviews: [] })}

  <div class="section-gap" style="display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:14px">
    <div class="card">
      <div class="card-head"><h3>How the supervisor delegates</h3><span class="dim small">behaviour on each tick</span></div>
      <div class="card-body">
        <ol class="rule-list">
          <li><b>Failure triage chain.</b> A run ends Failed → the Supervisor diagnoses it with the model and writes one suggestion → it escalates the run → the Watchdog captures missing evidence and writes the run note. The run ends up with a diagnosis, a screenshot and a note.</li>
          <li><b>Scheduled regression loop.</b> The Scheduler queues a Ready workflow on its interval. Failures pause it (stop after first failure); the Supervisor's triage decision is what a human reviews before resuming.</li>
          <li><b>Tool escalation.</b> A step fails on a missing tool id. The Supervisor's suggestion names the gap → create or approve the tool in Tools &amp; commands → re-run with the same failure policy.</li>
          <li><b>Evidence gap repair.</b> A run failed while screenshots were disabled. The Watchdog captures the current screen at review time, labels it in the run and writes the note, so the reviewer is not looking at an empty evidence panel.</li>
        </ol>
        <div class="hint-box" style="margin-top:10px">A Supervisor tick handles at most two failures, so a failure storm cannot monopolise the queue. Enable it only when the AI route is reachable — otherwise it falls back to the heuristic diagnosis.</div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Agent toolbelt</h3><span class="dim small">${d.tools.length} commands</span></div>
      <div class="card-body stack" style="gap:7px">
        ${d.tools
          .map(
            (t) => `<div class="row" style="gap:8px"><span class="mono small" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(
              t.name
            )}</span>${statusPill(t.status)}<span class="dim small">${t.usage?.length || 0} runs</span></div>`
          )
          .join('') || '<p class="muted small">No tools registered.</p>'}
        <p class="dim small" style="margin-top:4px">Only approved tools execute in a run. Agent steps call them by <span class="mono">params.toolId</span>.</p>
        <button class="btn btn-sm btn-ghost" data-act="nav-tools">Open Tools &amp; commands →</button>
      </div>
    </div>
  </div>

  <div class="section-gap" style="display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px">
    <div class="card">
      <div class="card-head"><h3>Activity</h3><span class="dim small">${activity.length} events</span></div>
      <div class="card-body" style="max-height:420px;overflow:auto">
        ${activity
          .map(
            (a) => `<div class="activity-item">
              <span class="k">${esc(a.kind)}</span>
              <span>${esc(a.message)}</span>
              <span class="t">${fmtTime(a.at)}</span>
            </div>`
          )
          .join('') || '<p class="muted small">No activity yet.</p>'}
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <div class="card-head"><h3>Model &amp; console settings</h3><span class="badge">${d.platform.windows ? 'windows' : 'non-windows'}</span></div>
        <div class="card-body">
          ${settingsFields(s)}
          <button class="btn btn-primary" data-act="save-settings">Save settings</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Status model</h3></div>
        <div class="card-body">
          <div class="status-legend">
            <div class="legend-row">${statusPill('draft')} workflow, editable</div>
            <div class="legend-row">${statusPill('ready')} workflow, schedulable</div>
            <div class="legend-row">${statusPill('running')} executing</div>
            <div class="legend-row">${statusPill('passed')} all steps ok</div>
            <div class="legend-row">${statusPill('failed')} policy stopped</div>
            <div class="legend-row">${statusPill('needs_review')} failures, continue</div>
          </div>
          <p class="dim small" style="margin-top:10px">Runs always start Queued, then Running. Failure rules (stop / retry / continue) live per workflow in the builder.</p>
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ modal */
function openModal(type, payload) {
  ui.modal = { type, payload: payload || {} };
  renderModal();
}

function closeModal() {
  ui.modal = null;
  ui.annotateMode = false;
  ui.captureAnnotations = null;
  const root = $('#modal-root');
  if (root) root.innerHTML = '';
}

function renderModal() {
  const root = $('#modal-root');
  if (!root) return;
  if (!ui.modal) {
    root.innerHTML = '';
    return;
  }
  const { type, payload } = ui.modal;
  if (type === 'lightbox') {
    const c = payload.capture;
    const marks = c.marks || [];
    root.innerHTML = `
    <div class="lightbox" data-lightbox-backdrop>
      <div class="lightbox-inner">
        <div class="lightbox-bar">
          <div>
            <div class="row">${c.simulated ? '<span class="pill simulated">simulated</span>' : '<span class="pill live">live pixels</span>'}<strong>${esc(c.caption || 'Screen capture')}</strong></div>
            <div class="dim small" style="margin-top:3px">${fmtTime(c.createdAt)}${c.width ? ` · ${c.width}×${c.height}` : ''}${c.runId ? ` · run ${esc(c.runId)}` : ''}</div>
          </div>
          <div class="row">
            ${c.runId ? `<button class="btn btn-sm" data-mact="open-run" data-id="${c.runId}">Open run</button>` : ''}
            <button class="btn btn-sm ${ui.annotateMode ? 'btn-primary' : 'btn-ghost'}" data-mact="toggle-annotate" data-id="${esc(c.id || '')}">${ui.annotateMode ? 'Annotating…' : 'Annotate'}</button>
            ${String(c.id || '').startsWith('live-frame:') ? '' : `<button class="btn btn-sm btn-ghost" data-mact="delete-capture" data-id="${c.id || ''}" data-path="${esc(c.path)}">Delete</button>`}
            <button class="btn btn-sm" data-mact="close">Close</button>
          </div>
        </div>
        <div class="capture-mark-stage" id="annotate-stage" style="position:relative;display:inline-block;max-width:100%;${ui.annotateMode ? 'cursor:crosshair' : ''}">
          <img src="/api/files/raw?path=${encodeURIComponent(c.path)}" alt="${esc(c.caption || 'Capture')}" style="display:block;max-width:100%" ${ui.annotateMode ? 'data-annotate-click="1"' : ''} />
          ${marks.map((mark) => `<span title="${esc(mark.label)}" style="position:absolute;left:${Number(mark.x) || 0}%;top:${Number(mark.y) || 0}%;transform:translate(-50%,-50%);background:#e5484d;color:#fff;border-radius:50%;font-size:10px;width:18px;height:18px;line-height:18px;text-align:center;font-weight:700;box-shadow:0 0 0 2px rgba(0,0,0,.45)">${esc(mark.number)}</span>`).join('')}
          ${(ui.captureAnnotations || []).map((annotation) => annotation.kind === 'box'
            ? `<div title="${esc(annotation.text || annotation.kind)}" style="position:absolute;left:${(Number(annotation.x) || 0) * 100}%;top:${(Number(annotation.y) || 0) * 100}%;width:${(Number(annotation.w) || 0) * 100}%;height:${(Number(annotation.h) || 0) * 100}%;border:2px solid ${esc(annotation.color || '#7c5cff')};border-radius:4px;pointer-events:none"></div><span style="position:absolute;left:${(Number(annotation.x) || 0) * 100}%;top:${(Number(annotation.y) || 0) * 100}%;transform:translateY(-110%);background:${esc(annotation.color || '#7c5cff')};color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;pointer-events:none">${esc(annotation.text || annotation.by)}</span>`
            : `<span title="${esc(annotation.text || annotation.by)}" style="position:absolute;left:${(Number(annotation.x) || 0) * 100}%;top:${(Number(annotation.y) || 0) * 100}%;transform:translate(-50%,-50%);background:${esc(annotation.color || '#7c5cff')};color:#fff;border-radius:50%;font-size:9px;min-width:16px;height:16px;line-height:16px;text-align:center;font-weight:700;box-shadow:0 0 0 2px rgba(0,0,0,.45);pointer-events:none">${annotation.kind === 'pin' ? '●' : '✎'}</span>${annotation.text ? `<span style="position:absolute;left:${(Number(annotation.x) || 0) * 100}%;top:${(Number(annotation.y) || 0) * 100}%;transform:translate(10px,-6px);background:rgba(0,0,0,.72);color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;max-width:180px;pointer-events:none">${esc(annotation.text)}</span>` : ''}`).join('')}
        </div>
        <div class="card" style="margin-top:10px;padding:10px">
          <div class="row wrap" style="gap:6px;align-items:end">
            <label class="field" style="margin:0;flex:1;min-width:150px"><span>Mark label</span><input id="capture-mark-label" type="text" placeholder="Save button" /></label>
            <label class="field" style="margin:0;width:80px"><span>X %</span><input id="capture-mark-x" type="number" min="0" max="100" value="50" /></label>
            <label class="field" style="margin:0;width:80px"><span>Y %</span><input id="capture-mark-y" type="number" min="0" max="100" value="50" /></label>
            <button class="btn btn-sm btn-primary" data-mact="capture-add-mark">Add mark</button>
            <button class="btn btn-sm btn-ghost" data-mact="capture-clear-marks" ${marks.length ? '' : 'disabled'}>Clear marks</button>
          </div>
          <div class="dim small" style="margin-top:5px">${marks.length ? `${marks.length} mark(s) shown over the screenshot.` : 'Add numbered marks to point at the control or state under review.'}</div>
        </div>
      </div>
    </div>`;
    return;
  }

  let title = '';
  let body = '';
  let footer = '';
  if (type === 'confirm') {
    title = payload.title || 'Confirm';
    body = `<p class="muted" style="font-size:13px;line-height:1.6">${esc(payload.message)}</p>`;
    footer = `<button class="btn btn-ghost" data-mact="close">Cancel</button><button class="btn btn-primary" data-mact="confirm">${esc(
      payload.confirmLabel || 'Confirm'
    )}</button>`;
  } else if (type === 'admin') {
    const a = ui.auth || {};
    if (a.authenticated) {
      title = 'Admin session';
      body = `<p class="small" style="margin-bottom:10px">Signed in as <b>${esc(a.username)}</b>. Operator commands are unlocked for this browser session.</p>
        <label class="field"><span>Current password</span><input type="password" data-scope="auth" data-key="current" autocomplete="current-password" /></label>
        <label class="field"><span>New password</span><input type="password" data-scope="auth" data-key="next" autocomplete="new-password" /><span class="help">At least 8 characters; the default must be changed after first sign-in.</span></label>`;
      footer = `<button class="btn btn-ghost" data-mact="admin-logout">Sign out</button><button class="btn btn-primary" data-mact="admin-password">Update password</button>`;
    } else {
      title = 'Admin sign-in';
      body = `<p class="small muted" style="margin-bottom:10px">Operator commands — FORCE_REPLAN, OVERRIDE_PAUSE, OVERRIDE_RESUME, CHECKPOINT, CANCEL and RERUN — require the local admin account. Normal runs, missions and reads do not.</p>
        <label class="field"><span>Username</span><input type="text" value="${esc(ui.authDraft?.username || 'admin')}" data-scope="auth" data-key="username" autocomplete="username" /></label>
        <label class="field"><span>Password</span><input type="password" data-scope="auth" data-key="password" autocomplete="current-password" /></label>
        <div class="hint-box small">Default local account: <b>admin</b> / <b>sightline-admin</b>. Change it after signing in. Set <span class="mono">SIGHTLINE_ADMIN_PASSWORD</span> before first boot to seed a different one.</div>`;
      footer = `<button class="btn btn-primary" data-mact="admin-login">Sign in</button>`;
    }
  } else if (type === 'tool') {
    const t = payload.tool;
    const draft = ui.toolDraft || (ui.toolDraft = { name: t?.name || '', description: t?.description || '', code: t?.code || '' });
    title = t ? 'Edit tool' : 'New tool';
    body = `
      <label class="field"><span>Name</span><input type="text" value="${esc(draft.name)}" data-scope="tool" data-key="name" /></label>
      <label class="field"><span>Description</span><input type="text" value="${esc(draft.description)}" data-scope="tool" data-key="description" /></label>
      <label class="field"><span>PowerShell 5.1 script</span><textarea rows="10" data-scope="tool" data-key="code" placeholder="Get-Process | Select-Object -First 5">${esc(
        draft.code
      )}</textarea><span class="help">Runs non-interactively. <span class="mono">$env:CB_DATA</span> points at the data folder.</span></label>`;
    footer = `<button class="btn btn-ghost" data-mact="close">Cancel</button><button class="btn btn-primary" data-mact="save-tool" data-id="${
      t?.id || ''
    }">${t ? 'Save tool' : 'Create draft'}</button>`;
  } else if (type === 'toolgen') {
    title = 'Ask AI for a tool';
    body = `
      <p class="muted small" style="margin-bottom:10px">Describe a read-only helper. The model writes a PowerShell script and saves it as a draft for your approval.</p>
      <label class="field"><span>What should the tool do?</span><textarea rows="4" data-scope="toolgen" placeholder="List every visible window title with its process id">${esc(
        ui.toolgenPrompt || ''
      )}</textarea></label>
      ${ui.toolgenBusy ? '<p class="small muted"><span class="spinner"></span> Writing script…</p>' : ''}
      ${ui.toolgenError ? `<p class="small" style="color:var(--bad)">${esc(ui.toolgenError)}</p>` : ''}`;
    footer = `<button class="btn btn-ghost" data-mact="close">Cancel</button><button class="btn btn-primary" data-mact="generate-tool" ${
      ui.toolgenBusy ? 'disabled' : ''
    }>Generate draft</button>`;
  } else if (type === 'note') {
    const n = payload.note;
    const draft = ui.noteDraft || (ui.noteDraft = { title: n?.title || '', body: n?.body || '' });
    title = n ? n.title : 'New note';
    body = `
      <label class="field"><span>Title</span><input type="text" value="${esc(draft.title)}" data-scope="note" data-key="title" /></label>
      <label class="field"><span>Body (markdown)</span><textarea rows="14" data-scope="note" data-key="body">${esc(draft.body)}</textarea></label>`;
    footer = `<button class="btn btn-ghost" data-mact="close">Cancel</button><button class="btn btn-primary" data-mact="save-note" data-id="${
      n?.id || ''
    }">Save note</button>`;
  } else if (type === 'settings') {
    const s = ui.settingsDraft || (ui.settingsDraft = { ...ui.data.settings });
    title = 'Settings';
    body = settingsFields(s) + sharingPanel();
    footer = `<button class="btn btn-ghost" data-mact="close">Cancel</button><button class="btn btn-primary" data-mact="save-settings">Save</button>`;
  } else if (type === 'pyview') {
    const f = payload.file;
    title = f.name;
    body = `<div class="row" style="margin-bottom:9px;gap:6px">
        <span class="badge">${f.lines} lines</span><span class="badge">${fmtBytes(f.size)}</span>
        <span class="spacer"></span>
        <a class="btn btn-sm" href="/api/python/${encodeURIComponent(f.name)}/download" download>Download</a>
      </div>
      <pre class="code" style="max-height:62vh">${esc(f.code || '')}</pre>`;
    footer = `<button class="btn btn-ghost" data-mact="close">Close</button>`;
  } else if (type === 'pynew') {
    const draft = ui.pyDraft || (ui.pyDraft = { name: '', code: '' });
    title = 'New Python file';
    body = `
      <label class="field"><span>File name</span><input type="text" value="${esc(draft.name)}" data-scope="pynew" data-key="name" placeholder="my_tool.py" /></label>
      <label class="field"><span>Python source</span><textarea rows="14" data-scope="pynew" data-key="code" spellcheck="false">${esc(draft.code)}</textarea></label>`;
    footer = `<button class="btn btn-ghost" data-mact="close">Cancel</button><button class="btn btn-primary" data-mact="save-python">Save file</button>`;
  }

  root.innerHTML = `<div class="modal-backdrop" data-modal-backdrop><div class="modal ${payload.wide ? 'wide' : ''}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" data-mact="close">✕</button></div>
    <div class="modal-body">${body}</div>
    ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
  </div></div>`;
}

/* ------------------------------------------------------------------ sync */
function renderSyncPill() {
  const pill = $('#sync-pill');
  if (!pill) return;
  const g = ui.data?.gitSync || {};
  const parts = [];
  if (g.status === 'conflict') parts.push('conflicts');
  else if (g.status === 'diverged') parts.push('diverged');
  if (Number(g.behind) > 0) parts.push(`${g.behind} behind`);
  if (Number(g.ahead) > 0) parts.push(`${g.ahead} to push`);
  if (['push-failed', 'fetch-failed', 'backup-failed', 'error'].includes(g.status)) parts.push('sync failed');
  const notes = (ui.data?.handoff?.notes || []).length;
  pill.hidden = !parts.length && !notes;
  pill.textContent = parts.length ? `⇅ ${parts.join(' · ')}` : `⇅ ${notes} note${notes === 1 ? '' : 's'}`;
  pill.title = parts.length ? `Repository needs attention: ${parts.join(', ')}` : 'Handoff notes from other agents';
  pill.classList.toggle('warnbadge', parts.length > 0);
}

async function loadSync() {
  const [info, prs] = await Promise.all([api('/api/git'), api('/api/git/prs')]);
  ui.gitInfo = info.ok ? info : { ok: false, error: info.error || 'Could not read the repository', git: ui.data?.gitSync };
  ui.gitPrs = prs.ok ? prs : { ok: false, error: prs.error || 'Could not list pull requests', prs: [] };
  render();
}

async function syncAction(path, body) {
  const res = await api(path, { method: 'POST', body: body || {} });
  toast(res.message || res.error || 'Done', res.ok ? 'ok' : 'error');
  ui.gitInfo = null;
  await refresh();
  await loadSync();
}

/* ------------------------------------------------- sentinel: auto-test & repair */
function renderSentinel() {
  const s = ui.data?.sentinel || {};
  const settings = ui.data?.settings?.sentinel || {};
  const failures = s.failures || [];
  const open = failures.filter((f) => f.status !== 'dismissed' && f.status !== 'fixed');
  const runs = s.runs || [];
  const last = s.lastRun;

  const statusBadge = !s.enabled
    ? '<span class="badge">off</span>'
    : s.busy
    ? '<span class="badge okbadge">testing…</span>'
    : last
    ? last.ok
      ? '<span class="badge okbadge">last run passed</span>'
      : `<span class="badge warnbadge">${last.fail ?? '?'} failing</span>`
    : '<span class="badge">no run yet</span>';

  return `
  <div class="page-head">
    <div>
      <h1>Sentinel</h1>
      <p>Watches the project's source files, runs the test suite in a separate process whenever changes settle, and queues every failure for repair. Failures are written to <span class="mono">must-check/</span> and left as handoff notes, so auto-sync carries them to GitHub for every connected app and agent.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn btn-sm btn-ghost" data-act="sentinel-refresh">Refresh</button>
      <button class="btn btn-sm" data-act="sentinel-toggle">${s.enabled ? 'Pause watching' : 'Resume watching'}</button>
      <button class="btn btn-sm btn-primary" data-act="sentinel-run-now">Run tests now</button>
      <button class="btn btn-sm" data-act="sentinel-push" ${s.lastRun && !s.lastRun.ok ? '' : 'disabled title="Nothing failed — nothing to push as a fix"'}>Push fix</button>
    </div>
  </div>

  <div class="stack">
    <section class="card">
      <div class="card-head"><h3>Watcher</h3>${statusBadge}</div>
      <div class="card-body detail-cols">
        <div>
          <p class="small">Test command: <span class="mono">${esc(settings.testCommand || 'npm test')}</span></p>
          <p class="small dim">Watched: public, server, test, bin, examples, package.json · cooldown ${Math.round(Number(s.cooldownMs || 60000) / 1000)}s · ${s.watching ? 'watching now' : 'not watching'}</p>
          <p class="small dim">Last run: ${last ? `${fmtTime(last.at)} · ${last.ok ? 'passed' : `failed (${last.fail ?? '?'} failing)`}${last.tests ? ` · ${last.pass ?? '?'} of ${last.tests}` : ''}` : 'never run'}</p>
        </div>
        <div>
          <div class="row wrap" style="gap:8px">
            <button class="btn btn-sm ${s.autoPlan ? 'btn-ghost' : ''}" data-act="sentinel-setting" data-key="autoPlan" data-value="${s.autoPlan ? 'off' : 'on'}">AI repair plans: ${s.autoPlan ? 'on' : 'off'}</button>
            <button class="btn btn-sm ${s.showWindow ? '' : 'btn-ghost'}" data-act="sentinel-setting" data-key="showWindow" data-value="${s.showWindow ? 'off' : 'on'}">Separate window: ${s.showWindow ? 'on' : 'off'}</button>
            <button class="btn btn-sm ${s.worktree ? '' : 'btn-ghost'}" data-act="sentinel-setting" data-key="worktree" data-value="${s.worktree ? 'off' : 'on'}" title="Run the suite in a throwaway git worktree instead of this folder">Isolated worktree: ${s.worktree ? 'on' : 'off'}</button>
          </div>
          <p class="small dim" style="margin-top:8px">“Separate window” shows the test run in its own console window; either way it runs in a child process, so the console never blocks on tests.</p>
          <p class="small dim">Worktree ${s.worktree ? 'on' : 'off'}${s.lastRun?.isolated ? ' · last run tested an isolated copy' : ''} · queue file <span class="mono">${esc(s.queueFile || 'must-check/repair-queue.json')}</span></p>
          ${s.lastError ? `<div class="hint-box small" style="color:var(--bad)">${esc(s.lastError)}</div>` : ''}
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Repair queue</h3><span class="dim small">${open.length ? `${open.length} waiting` : 'clear'}</span></div>
      <div class="card-body">
        ${open.length
          ? `<div class="stack" style="gap:10px">${open.map((f) => `
            <div class="cc-note">
              <div class="row wrap" style="gap:6px;align-items:center">
                <span class="badge ${f.status === 'planned' ? 'okbadge' : 'warnbadge'}">${esc(f.status)}</span>
                <span class="small dim">${fmtTime(f.at)} · ${f.fail ?? '?'} of ${f.tests ?? '?'} failing · attempt ${f.attempts || 1}</span>
                <span class="spacer"></span>
                <button class="btn btn-sm" data-act="sentinel-plan" data-id="${esc(f.id)}">${f.plan?.text ? 'Re-plan' : 'AI repair plan'}</button>
                <button class="btn btn-sm" data-act="sentinel-opinion" data-id="${esc(f.id)}" data-lens="skeptic" title="A second look from a different angle">2nd: skeptic</button>
                <button class="btn btn-sm" data-act="sentinel-opinion" data-id="${esc(f.id)}" data-lens="race" title="Read it as a race/timing bug">2nd: race</button>
                <button class="btn btn-sm" data-act="sentinel-opinion" data-id="${esc(f.id)}" data-lens="user" title="Judge it from the user's point of view">2nd: user</button>
                <button class="btn btn-sm" data-act="sentinel-retry" data-id="${esc(f.id)}">Re-run</button>
                <button class="btn btn-sm btn-ghost" data-act="sentinel-dismiss" data-id="${esc(f.id)}">Dismiss</button>
              </div>
              ${(f.tests || []).length ? `<p class="small" style="margin-top:6px">${(f.tests || []).slice(0, 4).map((t) => `✖ ${esc(t)}`).join('<br>')}${(f.tests || []).length > 4 ? ` <span class="dim">+${f.tests.length - 4} more</span>` : ''}</p>` : ''}
              ${f.plan?.text ? `<div class="hint-box small" style="margin-top:8px;white-space:pre-wrap">${esc(f.plan.text)}</div>` : ''}
              ${(f.opinions || []).length ? `<div class="stack" style="gap:6px;margin-top:8px">${f.opinions.map((op) => op.text ? `<div class="hint-box small"><b>${esc(op.label || op.lens)}</b><div style="white-space:pre-wrap;margin-top:4px">${esc(op.text)}</div></div>` : '').join('')}</div>` : ''}
              ${f.plan?.error ? `<p class="small dim" style="margin-top:6px">Plan unavailable: ${esc(f.plan.error)}</p>` : ''}
              ${f.output ? `<details style="margin-top:6px"><summary class="small dim">Output tail</summary><pre class="mono small" style="white-space:pre-wrap">${esc(String(f.output).slice(-1500))}</pre></details>` : ''}
            </div>`).join('')}</div>`
          : '<p class="muted small" style="margin:0">No failing runs waiting. When a run fails, it lands here with a plan suggestion and a report in <span class="mono">must-check/</span>.</p>'}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Recent runs</h3><span class="dim small">${runs.length ? `${runs.length} kept` : 'none'}</span></div>
      <div class="card-body">
        ${runs.length
          ? `<div class="stack" style="gap:6px">${runs.map((run) => `<div class="row wrap" style="gap:8px;align-items:center"><span class="badge ${run.ok ? 'okbadge' : 'warnbadge'}">${run.ok ? 'pass' : 'fail'}</span><span class="small">${fmtTime(run.at)}</span><span class="small dim">${run.pass ?? '?'} passed · ${run.fail ?? 0} failed${run.timedOut ? ' · timed out' : ''}</span><span class="spacer"></span>${(run.failingTests || []).length ? `<span class="small dim mono">${esc(run.failingTests[0].slice(0, 60))}${run.failingTests.length > 1 ? ` +${run.failingTests.length - 1}` : ''}</span>` : ''}</div>`).join('')}</div>`
          : '<p class="muted small" style="margin:0">No runs yet. Change a file or press “Run tests now”.</p>'}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Must-check folder</h3><span class="dim small">tracked in git · read by every connected agent</span></div>
      <div class="card-body">
        <p class="small">Every failure drops a markdown report into <span class="mono">must-check/</span> — the one folder everyone agrees to read before touching the app. Add your own notes there too; auto-sync carries the folder to GitHub and pulls it back down for every connected machine.</p>
        <p class="small dim">The console's own agents read the same stream through the Sync page and the <span class="mono">sightline notes</span> CLI.</p>
      </div>
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ relay */
function renderRelay() {
  const relay = ui.data?.relay || {};
  const links = relay.links || [];
  const reviews = relay.reviews || [];
  const exchanges = relay.exchanges || [];
  const requests = ui.data?.inbox?.open || [];
  const pipeline = ui.data?.pipeline || {};

  return `
  <div class="page-head">
    <div>
      <h1>Relay &amp; pipeline</h1>
      <p>Direct connections to other apps' repositories: send files and folders through GitHub, take their updates back through a review gate, and answer questions any connected agent raises. The pipeline runs the queued work — repair plans, opinions, retries — with parallel workers and a checkpoint stream of what actually happened.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn btn-sm btn-ghost" data-act="relay-refresh">Refresh</button>
      <button class="btn btn-sm" data-act="pipeline-run">Run queue now</button>
    </div>
  </div>

  <div class="stack">
    <section class="card">
      <div class="card-head"><h3>Links</h3><span class="dim small">${links.length} connected</span></div>
      <div class="card-body">
        <div class="row wrap" style="gap:8px;align-items:flex-start">
          <input id="relay-name" class="input" placeholder="name (e.g. screen-client)" style="max-width:180px" />
          <input id="relay-remote" class="input mono" placeholder="https://github.com/you/other-app.git or owner/repo" style="flex:1;min-width:240px" />
          <input id="relay-branch" class="input" placeholder="branch" value="main" style="max-width:110px" />
          <button class="btn btn-sm btn-primary" data-act="relay-link-add">Link repo</button>
        </div>
        <div class="stack" style="gap:10px;margin-top:12px">
          ${links.length ? links.map((link) => `
          <div class="cc-note">
            <div class="row wrap" style="gap:6px;align-items:center">
              <strong class="small">${esc(link.name)}</strong>
              <span class="mono small dim">${esc(link.remote.replace('https://github.com/', ''))} · ${esc(link.branch)}</span>
              <span class="badge">${esc(link.direction)}</span>
              ${link.clientInstalled ? '<span class="badge okbadge">client installed</span>' : ''}
              <span class="spacer"></span>
              <button class="btn btn-sm ${link.allowances?.force ? '' : 'btn-ghost'}" data-act="relay-toggle-allowance" data-id="${esc(link.id)}" data-key="force" title="Allow forced updates">force ${link.allowances?.force ? 'on' : 'off'}</button>
              <button class="btn btn-sm ${link.allowances?.autoReview ? '' : 'btn-ghost'}" data-act="relay-toggle-allowance" data-id="${esc(link.id)}" data-key="autoReview" title="Route receives and risky pushes through review">review ${link.allowances?.autoReview ? 'on' : 'off'}</button>
              <button class="btn btn-sm btn-ghost" data-act="relay-link-rm" data-id="${esc(link.id)}">Unlink</button>
            </div>
            <div class="row wrap" style="gap:8px;margin-top:8px;align-items:flex-start">
              <input id="relay-paths-${esc(link.id)}" class="input mono" placeholder="paths to send, comma separated (e.g. public, server, must-check)" style="flex:1;min-width:220px" />
              <input id="relay-msg-${esc(link.id)}" class="input" placeholder="message" style="max-width:200px" />
              <button class="btn btn-sm btn-primary" data-act="relay-send" data-id="${esc(link.id)}">Send</button>
              <button class="btn btn-sm" data-act="relay-send-force" data-id="${esc(link.id)}" title="Force the other side to match this folder (needs client + force)">Send (force)</button>
              <button class="btn btn-sm" data-act="relay-receive" data-id="${esc(link.id)}">Take updates</button>
            </div>
            ${link.lastError ? `<p class="small" style="margin-top:6px;color:var(--bad)">${esc(link.lastError)}</p>` : ''}
            ${link.lastSyncAt ? `<p class="small dim" style="margin-top:4px">Last touched ${fmtTime(link.lastSyncAt)}</p>` : ''}
          </div>`).join('') : '<p class="muted small" style="margin:0">No links yet. A link can push to another repository, pull from it, or both.</p>'}
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Reviews</h3><span class="dim small">${relay.openReviews ? `${relay.openReviews} open` : 'clear'}</span></div>
      <div class="card-body">
        ${reviews.length ? `<div class="stack" style="gap:10px">${reviews.map((review) => `
          <div class="cc-note">
            <div class="row wrap" style="gap:6px;align-items:center">
              <span class="badge ${review.status === 'open' ? 'warnbadge' : ''}">${esc(review.status)}</span>
              <strong class="small">${esc(review.kind)}</strong>
              <span class="small dim">${esc(review.link)} · ${fmtTime(review.at)}</span>
              <span class="spacer"></span>
              <button class="btn btn-sm" data-act="relay-opinion" data-id="${esc(review.id)}">${review.opinion?.text ? 'Re-opinion' : 'AI opinion'}</button>
              ${review.status === 'open' ? `
              <button class="btn btn-sm btn-primary" data-act="relay-approve" data-id="${esc(review.id)}">Approve</button>
              <button class="btn btn-sm btn-ghost" data-act="relay-deny" data-id="${esc(review.id)}">Deny</button>` : ''}
            </div>
            ${(review.files || []).length ? `<p class="small mono" style="margin-top:6px">${(review.files || []).slice(0, 6).map((f) => esc(f)).join('<br>')}${review.files.length > 6 ? ` <span class="dim">+${review.files.length - 6} more</span>` : ''}</p>` : ''}
            ${review.opinion?.text ? `<div class="hint-box small" style="margin-top:8px;white-space:pre-wrap">${esc(review.opinion.text)}</div>` : ''}
            ${review.opinion?.error ? `<p class="small dim" style="margin-top:6px">Opinion unavailable: ${esc(review.opinion.error)}</p>` : ''}
          </div>`).join('')}</div>` : '<p class="muted small" style="margin:0">No reviews waiting. Receives and risky pushes land here when review is on for the link.</p>'}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Requests for you</h3><span class="dim small">${requests.length ? `${requests.length} open` : 'none'}</span></div>
      <div class="card-body">
        <p class="small dim" style="margin-top:0">Any connected agent can ask through the shared API: <span class="mono">POST /api/inbox</span>, then <span class="mono">GET /api/inbox/&lt;id&gt;/wait</span> until you answer. The CLI sees the same queue.</p>
        ${requests.length ? `<div class="stack" style="gap:10px;margin-top:10px">${requests.map((request) => `
          <div class="cc-note">
            <div class="row wrap" style="gap:6px;align-items:center">
              <strong class="small">${esc(request.from)}</strong>
              <span class="small dim">${fmtTime(request.at)}${request.runId ? ` · run ${esc(request.runId)}` : ''}</span>
            </div>
            <p class="small" style="margin-top:4px">${esc(request.question)}</p>
            ${request.context ? `<p class="small dim" style="margin-top:2px">${esc(request.context)}</p>` : ''}
            ${request.choices?.length ? `<p class="small dim" style="margin-top:2px">Choices: ${request.choices.map((c) => esc(c)).join(' · ')}</p>` : ''}
            <div class="row wrap" style="gap:8px;margin-top:8px">
              <input id="inbox-answer-${esc(request.id)}" class="input" placeholder="your answer" style="flex:1;min-width:220px" />
              <button class="btn btn-sm btn-primary" data-act="inbox-answer" data-id="${esc(request.id)}">Answer</button>
              <button class="btn btn-sm btn-ghost" data-act="inbox-cancel" data-id="${esc(request.id)}">Cancel</button>
            </div>
          </div>`).join('')}</div>` : '<p class="muted small" style="margin-top:10px">No open requests.</p>'}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Pipeline</h3><span class="dim small">${pipeline.busy ? `${pipeline.busy} running` : 'idle'} · ${pipeline.queued?.length || 0} queued</span></div>
      <div class="card-body">
        <div class="row wrap" style="gap:8px;align-items:center">
          <button class="btn btn-sm" data-act="pipeline-workers" data-delta="-1">− worker</button>
          <span class="small">${pipeline.workers || 2} workers</span>
          <button class="btn btn-sm" data-act="pipeline-workers" data-delta="1">+ worker</button>
          <span class="dim small">handlers: ${(pipeline.handlers || []).map((h) => esc(h)).join(', ') || 'none'}</span>
        </div>
        ${(pipeline.queued || []).length ? `<div class="stack" style="gap:6px;margin-top:10px">${pipeline.queued.map((job) => `<div class="row wrap" style="gap:8px;align-items:center"><span class="badge">${esc(job.kind)}</span><span class="small dim">attempt ${job.attempts || 0} · priority ${job.priority}</span><span class="spacer"></span><span class="small dim mono">${esc(String(job.key).slice(0, 60))}</span></div>`).join('')}</div>` : '<p class="muted small" style="margin-top:10px">Queue is empty. Sentinel failures and relay reviews enqueue their own work.</p>'}
        ${(pipeline.checkpoints || []).length ? `<div class="stack" style="gap:4px;margin-top:12px"><p class="small dim" style="margin:0">Checkpoint stream (what actually happened, newest first):</p>${pipeline.checkpoints.map((cp) => `<div class="row wrap" style="gap:6px"><span class="badge ${cp.ok ? 'okbadge' : 'warnbadge'}">${cp.ok ? 'ok' : 'fail'}</span><span class="small dim">${fmtTime(cp.at)}</span><span class="small">${esc(cp.summary)}</span></div>`).join('')}</div>` : ''}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>AIs working now</h3><span class="dim small">${(() => { const a = ui.data?.agentsWorking || {}; return a.active ? 'active' : 'none detected'; })()}</span></div>
      <div class="card-body">
        ${(() => {
          const a = ui.data?.agentsWorking || {};
          if (!a.active) return '<p class="muted small" style="margin:0">No agent is editing the app right now. Working agents can announce themselves: <span class="mono">POST /api/agents/heartbeat {name, task}</span>, and sign out with <span class="mono">/api/agents/done</span>.</p>';
          return `<div class="stack" style="gap:6px">${(a.agents || []).map((agent) => `<div class="row wrap" style="gap:8px;align-items:center"><span class="badge okbadge">working</span><strong class="small">${esc(agent.name)}</strong><span class="small dim">${esc(agent.task || 'no task given')} · ${fmtTime(agent.at)}</span></div>`).join('')}${(a.signals || []).length ? `<p class="small dim" style="margin-top:4px">Signals: ${a.signals.map((s) => esc(s)).join(' · ')}</p>` : ''}${(a.files || []).length ? `<p class="small dim mono" style="margin-top:2px">${(a.files || []).slice(0, 8).map((f) => esc(f)).join(', ')}</p>` : ''}</div>`;
        })()}
        <p class="small dim" style="margin-top:8px">While agents are editing, the Sentinel stretches its auto-test cooldown so it never tests half-written files, and failures are sent to the working agents as continuation messages.</p>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Action log</h3><span class="dim small">${(() => { const al = ui.data?.actionLog || {}; return al.open ? `${al.open} open${al.triaged ? ` · ${al.triaged} with suggestions` : ''}` : 'clear'; })()}</span></div>
      <div class="card-body">
        <p class="small dim" style="margin-top:0">Every UI action, click and error is reported here and deduplicated. A recurring problem is written once into <span class="mono">must-check/</span> — the folder auto-sync carries to GitHub — and the pipeline drafts an AI suggestion for it. Nothing is auto-applied to source files.</p>
        ${(ui.data?.actionLog?.items || []).length ? `<div class="stack" style="gap:10px;margin-top:10px">${(ui.data?.actionLog?.items || []).slice(0, 10).map((item) => `
          <div class="cc-note">
            <div class="row wrap" style="gap:6px;align-items:center">
              <span class="badge ${item.status === 'fix-suggested' ? 'okbadge' : item.status === 'fix-applied' || item.status === 'dismissed' || item.status === 'suppressed' ? '' : 'warnbadge'}">${esc(item.status)}</span>
              <strong class="small">${esc(item.action || item.kind)}</strong>
              <span class="small dim">${item.count}× · ${fmtTime(item.lastAt)}${item.pattern ? ` · known: ${esc(item.pattern.id)}` : ''}</span>
              <span class="spacer"></span>
              <button class="btn btn-sm" data-act="alog-triage" data-id="${esc(item.id)}" title="Ask the model for a fix suggestion">${item.suggestion ? 'Re-suggest' : 'AI suggestion'}</button>
              ${item.suggestion ? `<button class="btn btn-sm btn-primary" data-act="alog-implement" data-id="${esc(item.id)}" title="Turn the suggestion into reviewable workflow steps">Implement</button>` : ''}
              ${item.implementation?.steps?.length ? `<span class="small dim">→ ${item.implementation.steps.length} step(s) drafted</span>` : ''}
              <button class="btn btn-sm ${item.pattern?.fix ? '' : 'btn-ghost'}" data-act="alog-fix" data-id="${esc(item.id)}" title="Mark handled / apply the known safe fix">Mark fixed</button>
              <button class="btn btn-sm btn-ghost" data-act="alog-dismiss" data-id="${esc(item.id)}">Dismiss</button>
            </div>
            ${item.error ? `<p class="small mono" style="margin-top:6px">${esc(String(item.error).slice(0, 220))}</p>` : ''}
            ${item.pattern?.advice ? `<p class="small" style="margin-top:4px;color:var(--ok)">${esc(item.pattern.advice)}</p>` : ''}
            ${item.suggestion ? `<div class="hint-box small" style="margin-top:6px;white-space:pre-wrap">${esc(item.suggestion)}</div>` : ''}
            ${item.reportFile ? `<p class="small dim" style="margin-top:4px">Reported to <span class="mono">${esc(item.reportFile)}</span> (synced to GitHub)</p>` : ''}
          </div>`).join('')}</div>` : '<p class="muted small" style="margin-top:10px">Nothing recurring. Click around; if something breaks twice, it shows up here and in must-check/.</p>'}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Action firewall</h3><span class="dim small">${(() => { const fw = ui.data?.firewall || {}; return `${(fw.rules || []).length} rule(s) · mode: ${fw.mode || 'enforce'}`; })()}</span></div>
      <div class="card-body">
        <div class="row wrap" style="gap:8px;align-items:center">
          <button class="btn btn-sm ${ui.data?.firewall?.mode === 'enforce' ? 'btn-primary' : 'btn-ghost'}" data-act="fw-mode" title="Enforce blocks/holds steps; log only records what the rules would do">mode: ${ui.data?.firewall?.mode || 'enforce'}</button>
          <button class="btn btn-sm btn-ghost" data-act="fw-reset">Reset to defaults</button>
        </div>
        <p class="small dim" style="margin-top:6px">Every live step passes the gate before it acts. Defaults: nothing destructive, nothing closes a window with unsaved work, nothing types without a proven destination, installs are reviewed.</p>
        <div class="stack" style="gap:6px;margin-top:10px">
          ${(ui.data?.firewall?.rules || []).map((rule) => `<div class="row wrap" style="gap:8px;align-items:center"><span class="badge ${rule.verdict === 'deny' ? 'warnbadge' : rule.verdict === 'review' ? '' : 'okbadge'}">${esc(rule.verdict)}</span><strong class="small">${esc(rule.name)}</strong><span class="small dim mono">${esc((rule.match?.types || []).join(', ') || 'any type')} · ${esc(String(rule.match?.paramPattern || '').slice(0, 50))}</span><span class="spacer"></span><button class="btn btn-sm btn-ghost" data-act="fw-rule-rm" data-id="${esc(rule.id)}">Remove</button></div>`).join('')}
        </div>
        <div class="row wrap" style="gap:8px;margin-top:10px;align-items:flex-start">
          <input id="fw-name" class="input" placeholder="rule name" style="max-width:170px" />
          <input id="fw-pattern" class="input mono" placeholder="regex against step params" style="flex:1;min-width:200px" />
          <input id="fw-types" class="input" placeholder="types (comma, empty=any)" style="max-width:180px" />
          <select id="fw-verdict" class="input" style="max-width:110px"><option>review</option><option>deny</option><option>allow</option></select>
          <button class="btn btn-sm btn-primary" data-act="fw-rule-add">Add rule</button>
        </div>
        <details style="margin-top:10px"><summary class="small dim">Test a step against the rules</summary>
          <div class="row wrap" style="gap:8px;margin-top:8px">
            <textarea id="fw-test-input" class="input mono" rows="2" placeholder='{"type":"runTool","params":{"toolName":"cleanup","command":"del /f old.log"}}' style="flex:1"></textarea>
            <button class="btn btn-sm" data-act="fw-test">Test</button>
          </div>
          ${ui.firewallTestResult ? `<p class="small" style="margin-top:6px">Verdict: <b>${esc(ui.firewallTestResult.verdict)}</b>${ui.firewallTestResult.ruleName ? ` — ${esc(ui.firewallTestResult.ruleName)}` : ''}${ui.firewallTestResult.reason ? `<br><span class="dim">${esc(ui.firewallTestResult.reason)}</span>` : ''}</p>` : ''}
        </details>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Exchange stream</h3><span class="dim small">${exchanges.length ? `${exchanges.length} recorded` : 'empty'}</span></div>
      <div class="card-body">
        ${exchanges.length ? `<div class="stack" style="gap:6px">${exchanges.slice(0, 12).map((exchange) => `<div class="row wrap" style="gap:8px;align-items:center"><span class="badge">${exchange.direction === 'push' ? '→ sent' : '← received'}</span><strong class="small">${esc(exchange.link)}</strong><span class="small dim">${fmtTime(exchange.at)}${exchange.forced ? ' · forced' : ''}</span><span class="spacer"></span><span class="small dim">${(exchange.files || []).length} path(s)</span></div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Nothing has moved through a link yet.</p>'}
      </div>
    </section>
  </div>`;
}

function renderBenchCard() {
  const bench = ui.data?.bench || {};
  const offline = bench.online === false;
  const unknown = bench.online === null || bench.online === undefined;
  const badge = offline ? '<span class="badge">offline</span>' : unknown ? '<span class="badge">unknown</span>' : `<span class="badge okbadge">linked · ${Number(bench.latencyMs || 0)}ms</span>`;
  const popups = bench.popups || [];
  const targets = bench.targets || [];
  const runs = bench.runs || [];
  return `
  <section class="card">
    <div class="card-head"><h3>Test bench</h3>${badge}</div>
    <div class="card-body">
      <p class="small ${offline ? 'preview-error' : 'muted'}">${offline
        ? `The bench at ${esc(bench.url || '127.0.0.1:4319')} is not answering. Start it with <span class="mono">npm start</span> in the sightline-bench folder; this card follows within seconds.`
        : unknown
        ? 'Checking the bench link…'
        : `The bench is watching ${targets.length} repository(ies) and tests every commit it detects, in its own process.`}</p>
      ${popups.length ? `<div class="section-gap">
        ${popups.map((p) => `
        <div class="side-card" style="border-color:#7c5cff">
          <div class="side-card-head"><h3>What the bench is doing next</h3><span class="pill ${p.status === 'stale' ? 'simulated' : 'live'}">${esc(p.status)}</span></div>
          <div class="side-card-body">
            <p class="small" style="margin-bottom:6px">${esc(p.text)}</p>
            ${p.context ? `<p class="small dim" style="margin-bottom:6px">${esc(p.context)}</p>` : ''}
            <div class="row wrap" style="gap:7px">
              ${(p.options || []).map((o) => `<button class="btn btn-sm" data-act="bench-answer" data-id="${esc(p.id)}" data-decision="${esc(o.id)}">${esc(o.label)}</button>`).join('')}
              <button class="btn btn-sm btn-primary" data-act="bench-answer" data-id="${esc(p.id)}" data-decision="ok">OK</button>
              <button class="btn btn-sm btn-ghost" data-act="bench-answer" data-id="${esc(p.id)}" data-decision="later">Later</button>
            </div>
            <p class="small dim" style="margin-top:6px">Posted by ${esc(p.source)}${p.targetName ? ` on ${esc(p.targetName)}` : ''} · ${Number(p.ageMin || 0)} min ago</p>
          </div>
        </div>`).join('')}
      </div>` : ''}
      ${(bench.reviews || []).length ? `<div class="section-gap">
        <p class="small" style="font-weight:600;margin-bottom:6px">Proposals waiting for a verdict</p>
        ${bench.reviews.map((r) => `
        <div class="side-card" style="border-color:#d68f2c">
          <div class="side-card-head"><h3>${esc(r.from)} → ${esc(r.targetPath || 'the project')}</h3><span class="pill simulated">${esc(r.status)}</span></div>
          <div class="side-card-body">
            <p class="small" style="margin-bottom:6px">${r.fileCount} file(s) · ${Number(r.totalBytes || 0)} bytes · ${Number(r.deletions || 0)} deletion(s)</p>
            ${r.note ? `<p class="small dim" style="margin-bottom:6px">${esc(r.note)}</p>` : ''}
            <details class="log" style="margin-bottom:8px"><summary>Files</summary><ul class="rule-list">${(r.files || []).map((f) => `<li class="mono">${esc(f.action)} ${esc(f.path)} (${f.bytes}b)</li>`).join('')}</ul></details>
            <div class="row wrap" style="gap:7px">
              <button class="btn btn-sm btn-primary" data-act="bench-verdict" data-id="${esc(r.id)}" data-decision="approve">Approve</button>
              <button class="btn btn-sm" data-act="bench-verdict" data-id="${esc(r.id)}" data-decision="deny">Deny</button>
            </div>
            <p class="small dim" style="margin-top:6px">Approving opens the apply gate on the bench; denying blocks it with your reason on record.</p>
          </div>
        </div>`).join('')}
      </div>` : ''}
      ${targets.length ? `<div class="section-gap"><table style="width:100%;font-size:12px;border-collapse:collapse">
        <tr style="color:var(--dim)"><th style="text-align:left;padding:4px 6px">Target</th><th style="text-align:left;padding:4px 6px">Status</th><th style="text-align:left;padding:4px 6px">Last verdict</th><th></th></tr>
        ${targets.map((t) => {
          const last = t.lastRun;
          const verdict = last ? (last.ok ? `<span class="okbadge badge">pass</span> ${last.pass}/${last.tests}` : `<span class="badge warnbadge">fail</span> ${last.fail}/${last.tests}`) : '<span class="dim">not tested yet</span>';
          return `<tr><td style="padding:4px 6px" class="mono">${esc(t.name)}</td><td style="padding:4px 6px">${esc(t.status)}</td><td style="padding:4px 6px">${verdict}${last?.failingTests?.length ? `<div class="dim small">${esc(last.failingTests[0])}</div>` : ''}</td><td style="padding:4px 6px"><button class="btn btn-sm btn-ghost" data-act="bench-test" data-id="${esc(t.id)}">Test now</button></td></tr>`;
        }).join('')}
      </table></div>` : ''}
      ${runs.length && !targets.length ? '' : ''}
      <div class="row wrap section-gap" style="gap:7px">
        <button class="btn btn-sm btn-ghost" data-act="bench-poll">Refresh</button>
      </div>
    </div>
  </section>`;
}

function renderSync() {
  const info = ui.gitInfo;
  if (!info) {
    loadSync().catch(() => {});
    return '<div class="empty"><strong>Reading the repository…</strong>Fetching the remote, pull requests and conflicts.</div>';
  }
  const g = info.git || ui.data?.gitSync || {};
  const backup = ui.data?.backup || {};
  const conflicts = info.conflicts || [];
  const prs = ui.gitPrs?.prs || [];
  const notes = ui.data?.handoff?.notes || [];
  const commands = ui.data?.handoff?.commands || [];
  const remote = info.remote ? `<a href="${esc(info.remote)}" target="_blank" rel="noreferrer">${esc(info.remote.replace('https://github.com/', ''))}</a>` : 'no GitHub remote';

  return `
  <div class="page-head">
    <div>
      <h1>Sync &amp; pull requests</h1>
      <p>Review this console's current branch against its GitHub remote. Automatic pushes and fast-forward pulls run tests first; pulls also create a recovery snapshot. Other branches, devices, and repositories are not synchronized by this loop.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn btn-sm btn-ghost" data-act="sync-load">Refresh</button>
      <button class="btn btn-sm" data-act="sync-pull">Pull</button>
      <button class="btn btn-sm" data-act="sync-push" ${Number(g.ahead) > 0 ? '' : 'disabled'}>Push</button>
      <button class="btn btn-sm" data-act="sync-merge" ${Number(info.behind) > 0 || Number(info.ahead) > 0 ? '' : 'disabled'}>Merge origin</button>
    </div>
  </div>

  <div class="stack">
    <section class="card">
      <div class="card-head"><h3>${esc(info.branch || g.branch || 'branch')} → ${remote}</h3><span class="badge ${conflicts.length ? 'warnbadge' : 'okbadge'}">${conflicts.length ? `${conflicts.length} conflict(s)` : esc(g.status || 'idle')}</span></div>
      <div class="card-body detail-cols">
        <div>
          <p class="small">Local is <b>${Number(info.ahead ?? g.ahead) || 0}</b> commit(s) ahead and <b>${Number(info.behind ?? g.behind) || 0}</b> behind.</p>
          <p class="small dim">Last sync: ${g.lastSyncAt ? fmtTime(g.lastSyncAt) : 'never'} · auto-sync ${g.enabled ? 'on' : 'off'} every ${Math.round(Number(g.intervalMs || 10000) / 1000)}s · tested auto-pull ${ui.data?.settings?.autoPull === true ? 'on' : 'off'}</p>
          ${g.autoBranch ? `<p class="small dim">Conveyor: <span class="mono">${esc(g.autoBranch)}</span> — every automatic commit lands there first; ${g.branch || 'main'} can only fast-forward to it after the suite passes on that exact commit.${g.held && g.held.ok === false ? ` <span style="color:var(--bad)">Held back by ${g.held.fail ?? 'failing'} test(s).</span>` : ''}</p>` : ''}
        </div>
        <div>
          ${g.lastError ? `<div class="hint-box small" style="color:var(--bad)">${esc(g.lastError)}</div>` : '<p class="small dim">No errors. Nothing to do means the folder matches the remote.</p>'}
          ${info.note ? `<p class="small dim">${esc(info.note)}</p>` : ''}
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Local backup copy</h3><span class="badge ${Number(backup.consecutiveFailures) >= 3 ? 'warnbadge' : backup.inSync ? 'okbadge' : ''}">${esc(backup.status || 'off')}</span></div>
      <div class="card-body detail-cols">
        <div>
          <p class="small">${backup.enabled ? `A second copy of this repository is kept at <span class="mono">${esc(backup.mirrorPath || 'not set')}</span> and stays level with GitHub in both directions.` : 'Off. Choose a folder to keep a second, independent copy of this repository on this machine. It is updated in both directions and never force-pushed.'}</p>
          <p class="small dim">Link tested every ${Math.round(Number(backup.intervalMs || 10000) / 1000)}s · ${backup.lastOkAt ? `last good ${fmtTime(backup.lastOkAt)}` : 'no successful check yet'}${backup.latencyMs !== null && backup.latencyMs !== undefined ? ` · ${backup.latencyMs}ms` : ''} · ${Number(backup.consecutiveFailures) || 0} failure(s) in a row</p>
          ${backup.held ? `<p class="small" style="color:var(--bad)">${esc(backup.held.message)}</p>` : ''}
          ${backup.lastError ? `<p class="small" style="color:var(--bad)">${esc(backup.lastError)}</p>` : ''}
        </div>
        <div>
          <p class="small dim">This folder <span class="mono">${esc((backup.localSha || '').slice(0, 7) || '—')}</span> · backup <span class="mono">${esc((backup.mirrorSha || '').slice(0, 7) || '—')}</span> · GitHub <span class="mono">${esc((backup.remoteSha || '').slice(0, 7) || '—')}</span></p>
          <div class="row wrap" style="gap:7px;margin-top:8px">
            <button class="btn btn-sm" data-act="backup-check">Check now</button>
            <button class="btn btn-sm btn-ghost" data-act="backup-toggle">${backup.enabled ? 'Turn off' : 'Turn on'}</button>
          </div>
          <p class="small dim" style="margin-top:8px">A pass that would delete ${Number(backup.maxDeletes) || 25} or more tracked files is refused and reported instead of committed. The folder is cloned once, then only fast-forwarded — nothing is reset or force-pushed.</p>
        </div>
      </div>
      <div class="card-body row wrap" style="gap:8px;padding-top:0">
        <input id="backup-path" class="input mono" placeholder="C:\\Users\\you\\Sightline-backup" value="${esc(backup.mirrorPath || '')}" style="flex:1;min-width:260px" />
        <button class="btn btn-sm btn-primary" data-act="backup-path">Save folder</button>
      </div>
    </section>

    ${renderBenchCard()}

    <section class="card">
      <div class="card-head"><h3>Conflicts</h3><span class="dim small">${conflicts.length ? 'a human or the model picks a side' : 'none'}</span></div>
      <div class="card-body">
        ${conflicts.length
          ? `<ul class="rule-list small">${conflicts.map((file) => `<li class="mono">${esc(file)}</li>`).join('')}</ul>
             <div class="row wrap" style="gap:7px;margin-top:10px">
               <button class="btn btn-sm" data-act="sync-ours">Keep mine</button>
               <button class="btn btn-sm" data-act="sync-theirs">Take remote</button>
               <button class="btn btn-sm btn-primary" data-act="sync-ai">Let AI merge</button>
               <button class="btn btn-sm btn-ghost" data-act="sync-commit">Commit merge</button>
             </div>
             <p class="small dim" style="margin-top:8px">“Let AI merge” backs up every file to data/git-backups, merges the markers, and refuses any reply that still contains them. Nothing is committed until you press Commit merge.</p>`
          : '<p class="muted small" style="margin:0">No conflicted files. Pull and merge can run without a decision.</p>'}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Pull requests</h3><span class="dim small">${ui.gitPrs?.ok ? `${prs.length} open` : 'unavailable'}</span></div>
      <div class="card-body">
        ${!ui.gitPrs?.ok
          ? `<p class="small dim" style="margin:0">${esc(ui.gitPrs?.error || 'Reading pull requests…')}</p>`
          : prs.length
          ? `<div class="stack" style="gap:6px">${prs.map((pr) => `<div class="row wrap" style="gap:8px;align-items:center"><span class="badge">#${pr.number}</span><span class="mono small">${esc(pr.sha)}</span><span class="spacer"></span><a class="btn btn-sm btn-ghost" href="${esc(pr.url)}" target="_blank" rel="noreferrer">Open</a><button class="btn btn-sm" data-act="sync-pr-fetch" data-id="${pr.number}">Fetch as pr/${pr.number}</button></div>`).join('')}</div>`
          : '<p class="muted small" style="margin:0">No open pull requests on this remote.</p>'}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Notes for the next agent</h3><span class="dim small">${notes.length} kept</span></div>
      <div class="card-body">
        <div class="row" style="gap:8px;align-items:flex-start"><textarea id="note-text" class="input" rows="2" placeholder="What the next agent or app needs to know: what changed, what to avoid, what to try." style="flex:1"></textarea><button class="btn btn-sm btn-primary" data-act="note-add">Leave note</button></div>
        <div class="stack" style="gap:6px;margin-top:10px">
          ${notes.length
            ? notes.map((note) => `<div class="cc-note"><div class="row" style="gap:6px"><strong class="small">${esc(note.by)}</strong><span class="dim small">${fmtTime(note.at)}</span></div><p class="small" style="margin-top:3px">${esc(note.text)}</p></div>`).join('')
            : '<p class="muted small">No notes yet. The CLI writes here too: <span class="mono">npm run sightline -- notes add \"…\"</span></p>'}
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Custom commands</h3><span class="dim small">${commands.length} saved</span></div>
      <div class="card-body">
        <div class="row wrap" style="gap:8px;align-items:flex-start">
          <input id="command-name" class="input" placeholder="name (e.g. pull-and-test)" style="max-width:220px" />
          <input id="command-body" class="input mono" placeholder="command to run in this folder" style="flex:1;min-width:240px" />
          <button class="btn btn-sm btn-primary" data-act="command-save">Save</button>
        </div>
        <p class="small dim" style="margin-top:6px">Commands run with this folder as the working directory and never run on their own. Same store as the CLI: <span class="mono">npm run sightline -- cmd add name -- \"…\"</span></p>
        <div class="stack" style="gap:6px;margin-top:10px">
          ${commands.length
            ? commands.map((cmd) => `<div class="cc-note"><div class="row wrap" style="gap:6px;align-items:center"><strong class="small">${esc(cmd.name)}</strong><span class="mono small dim">${esc(cmd.command)}</span><span class="spacer"></span><button class="btn btn-sm" data-act="command-run" data-id="${esc(cmd.id)}">Run</button><button class="btn btn-sm btn-ghost" data-act="command-rm" data-id="${esc(cmd.id)}">Delete</button></div>${cmd.lastRun ? `<p class="small ${cmd.lastRun.ok ? 'dim' : ''}" style="margin-top:4px;${cmd.lastRun.ok ? '' : 'color:var(--bad)'}">${cmd.lastRun.ok ? 'ok' : `exit ${cmd.lastRun.code}`} · ${fmtTime(cmd.lastRun.at)}${cmd.lastRun.stdout ? ` · ${esc(String(cmd.lastRun.stdout).slice(0, 160))}` : ''}${cmd.lastRun.stderr ? ` · ${esc(String(cmd.lastRun.stderr).slice(0, 160))}` : ''}</p>` : ''}</div>`).join('')
            : '<p class="muted small">No custom commands yet.</p>'}
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Version snapshots</h3><span class="dim small">${(ui.data?.snapshots?.count || 0)} kept · full-project copies off-branch</span></div>
      <div class="card-body">
        <div class="row wrap" style="gap:8px;align-items:flex-start">
          <input id="snapshot-label" class="input" placeholder="label (e.g. before the relay refactor)" style="flex:1;min-width:220px" />
          <button class="btn btn-sm btn-primary" data-act="snapshot-create">Snapshot now</button>
        </div>
        <p class="small dim" style="margin-top:6px">A snapshot captures the whole folder as a git commit object without touching any branch, so auto-sync and your own history stay untouched. Restores take a safety snapshot of what is here first.</p>
        ${(ui.data?.snapshots?.snapshots || []).length ? `
        <div class="row wrap" style="gap:8px;margin-top:10px;align-items:center">
          <select id="snapshot-diff-select" class="input" style="max-width:340px">
            ${(ui.data?.snapshots?.snapshots || []).slice(0, 12).map((snap, index, all) => index < all.length - 1 ? `<option value="${esc(all[index + 1].id)}|${esc(snap.id)}">${esc(all[index + 1].label)} → ${esc(snap.label)}</option>` : '').join('')}
          </select>
          <button class="btn btn-sm" data-act="snapshot-diff">Diff</button>
          <button class="btn btn-sm" data-act="snapshot-transfer" title="Apply the changes between the two versions onto the current tree (three-way)">Transfer changes</button>
        </div>
        <div class="stack" style="gap:6px;margin-top:10px">
          ${(ui.data?.snapshots?.snapshots || []).slice(0, 8).map((snap) => `<div class="row wrap" style="gap:8px;align-items:center"><strong class="small">${esc(snap.label)}</strong><span class="mono small dim">${esc(snap.commit.slice(0, 8))}</span><span class="small dim">${fmtTime(snap.at)}</span><span class="spacer"></span><button class="btn btn-sm" data-act="snapshot-restore" data-id="${esc(snap.id)}">Restore</button></div>`).join('')}
        </div>` : '<p class="muted small" style="margin-top:10px">No snapshots yet.</p>'}
        ${ui.snapshotDiff ? `<details style="margin-top:10px" open><summary class="small dim">Diff: ${esc(ui.snapshotDiff.from)} → ${esc(ui.snapshotDiff.to)}</summary><pre class="mono small" style="white-space:pre-wrap">${esc(ui.snapshotDiff.patch || '(no differences)')}</pre></details>` : ''}
      </div>
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ data loads */
async function refresh(options = {}) {
  const res = await api('/api/state');
  if (!res.ok) {
    toast(res.error || 'Could not reach the console server', 'error');
    return;
  }
  const changed = ui.rev != null && res.rev !== ui.rev;
  ui.data = res;
  ui.rev = res.rev;
  if (res.companion) {
    ui.companion = res.companion;
    announceCompanion(res.companion);
  }
  if (res.ambient) announceAmbient(res.ambient);
  if (res.continuity) ui.continuity = res.continuity;
  if (changed && !options.fromSync) {
    const message = { type: 'state', rev: res.rev, tab: TAB_ID, at: Date.now() };
    try {
      SYNC_CHANNEL?.postMessage(message);
      localStorage.setItem('sightline-state-sync', JSON.stringify(message));
    } catch {}
  }
  if (ui.view === 'shortcuts') await loadShortcuts(true);
  if (ui.view === 'memory') await loadWorkflowMemory(true);
  if (ui.view === 'captures') await loadCaptures();
  if (ui.view === 'files' && ui.fileTab === 'files') {
    const files = await api('/api/files');
    if (files.ok) ui.files = files.files;
  }
  if (ui.view === 'runs' && ui.selectedRun) {
    const detail = await api(`/api/runs/${encodeURIComponent(ui.selectedRun)}`);
    if (detail.ok) ui.runDetail = detail.run;
  }
  if (ui.view === 'command' && ui.selectedMission) {
    const detail = await api(`/api/missions/${encodeURIComponent(ui.selectedMission)}`);
    if (detail.ok) ui.missionDetail = detail.mission;
  }
  if (ui.view === 'presentation') {
    const missions = ui.data.missions || [];
    const workflows = ui.data.workflows || [];
    if (!workflows.some((workflow) => workflow.id === ui.presentationWorkflow)) ui.presentationWorkflow = null;
    const mission = ui.presentationMission ? missions.find((item) => item.id === ui.presentationMission) : null;
    if (mission && (!ui.presentationWorkflow || mission.workflowId === ui.presentationWorkflow)) {
      ui.presentationWorkflow = mission.workflowId;
      await loadPresentation(mission.id, { silent: true });
    } else if (ui.presentationMission && !mission) {
      ui.presentation = null;
      ui.presentationMission = null;
    }
  }
  render();
}

async function loadHealth() {
  const res = await api('/api/health');
  ui.health = res.ok ? res : { online: false, error: res.error };
  renderHeader();
}

async function loadCompanion({ scan = false } = {}) {
  ui.companionLoading = true;
  const res = scan
    ? await api('/api/companion/scan', { method: 'POST', body: {} })
    : await api('/api/companion');
  ui.companionLoading = false;
  if (!res.ok) return toast(res.error || 'Could not load the companion', 'error');
  ui.companion = res.companion || res;
  announceCompanion(ui.companion);
  render();
  return ui.companion;
}

async function loadContinuity({ scan = false } = {}) {
  const res = scan
    ? await api('/api/continuity/scan', { method: 'POST', body: {} })
    : await api('/api/continuity');
  if (!res.ok) return toast(res.error || 'Could not load continuity checks', 'error');
  ui.continuity = res.continuity || res;
  if (ui.data) ui.data.continuity = ui.continuity;
  render();
  return ui.continuity;
}

async function loadAuth() {
  const res = await api('/api/auth/status');
  ui.auth = res.ok ? res : { authenticated: false };
  renderHeader();
  return ui.auth;
}

async function loadChat(force) {
  if (ui.chatLoaded && !force) return;
  const res = await api('/api/history');
  if (res.ok) {
    ui.chat = res.history || [];
    ui.memory = res.memory || ui.memory;
    ui.chatLoaded = true;
  }
}

async function loadWorkflowMemory(force = false) {
  if (ui.memoryLoading) return ui.workflowMemory;
  if (ui.workflowMemory && !force) return ui.workflowMemory;
  ui.memoryLoading = true;
  const params = new URLSearchParams({ limit: '60' });
  if (ui.memoryWorkflow) params.set('workflowId', ui.memoryWorkflow);
  const res = await api(`/api/workflow-memory?${params.toString()}`);
  ui.memoryLoading = false;
  ui.workflowMemory = res.ok
    ? { count: res.count || 0, episodes: res.episodes || [] }
    : { count: 0, episodes: [], error: res.error || 'Could not load workflow memory' };
}

async function loadFiles(force) {
  if (ui.files?.length && !force) return;
  const res = await api('/api/files');
  ui.files = res.ok ? res.files : [];
}

async function loadFileChunk(filePath, offset = 0, reset = false) {
  if (!filePath) return;
  if (reset) {
    ui.fileText = '';
    ui.fileRead = null;
    ui.fileSummary = null;
  }
  ui.fileBusy = 'read';
  ui.fileError = null;
  render();
  const res = await api(`/api/files/read?path=${encodeURIComponent(filePath)}&offset=${Number(offset) || 0}&maxTokens=2500`);
  ui.fileBusy = '';
  if (!res.ok) {
    ui.fileError = res.error || 'Could not read the file';
    render();
    return;
  }
  ui.fileRead = {
    path: filePath,
    offset: res.offset,
    nextOffset: res.nextOffset,
    eof: res.eof,
    totalChars: res.totalChars,
    totalTokens: res.totalTokens,
    chunkTokens: res.chunkTokens,
    chunkIndex: res.chunkIndex,
    totalChunks: res.totalChunks,
  };
  ui.fileText = reset || !ui.fileText ? res.text : `${ui.fileText}\n\n${res.text}`;
  render();
}

async function loadExamples(force) {
  if (ui.examples?.length && !force) return;
  const res = await api('/api/examples');
  ui.examples = res.ok ? res.examples : [];
}

async function loadKnack(force) {
  if (ui.knack && !force) return ui.knack;
  const res = await api('/api/knack');
  if (res.ok) ui.knack = res;
  return ui.knack;
}

async function loadPython(force) {
  if (ui.python?.length && !force) return;
  const res = await api('/api/python');
  ui.python = res.ok ? res.files : [];
}

async function loadModels(force) {
  if (!force && ui.models?.length) return { ok: true, models: ui.models };
  ui.modelsBusy = true;
  const res = await api(`/api/models${force ? '?refresh=1' : ''}`);
  ui.modelsBusy = false;
  if (res.ok && Array.isArray(res.models)) {
    ui.models = res.models;
    ui.modelsError = '';
    return res;
  }
  ui.modelsError = res.error || 'Could not load models';
  return res;
}

/* ------------------------------------------------------- step thinking card */
function renderStepThink(step) {
  const think = step?.think;
  if (!think) return '';
  const notes = (think.notes || []).slice(-5);
  const alternatives = (think.alternatives || think.choices || []).slice(0, 5);
  const overseer = think.overseer;
  return `<details class="code-wrap" style="margin-top:6px">
    <summary class="small">Thinking · ${Number(think.reads) || Number(think.ticks) || 0} read(s) · ${(think.choices || []).length} choice(s)${think.best ? ` · best ${esc(think.best.name)} (${Math.round((Number(think.best.confidence) || 0) * 100)}%)` : ''}${think.autoApplyBlocked ? ' · auto-apply held' : ''}</summary>
    <div style="padding:6px 0 0">
      ${overseer ? `<div class="small"><b>Overseer:</b> ${esc(overseer.decision)} — ${esc(overseer.recommend)}${overseer.why ? ` <span class="dim">(${esc(overseer.why)})</span>` : ''}${overseer.preservation ? `<div class="dim">${esc(overseer.preservation)}</div>` : ''}</div>` : ''}
      ${notes.map((note) => `<div class="small dim">${esc(note.text)}</div>`).join('')}
      ${alternatives.map((choice) => `<div class="small"><span class="badge ${choice.verdict === 'best' ? 'okbadge' : choice.verdict === 'rejected' ? 'warnbadge' : ''}">${Math.round((Number(choice.confidence) || 0) * 100)}%</span> ${esc(choice.name)}${choice.verdict ? ` <span class="dim">${esc(choice.verdict)}</span>` : ''} <span class="dim">${esc((choice.reasons || [])[0] || choice.why || '')}</span></div>`).join('')}
      ${think.model?.why ? `<div class="small dim">Model: ${esc(think.model.why)}</div>` : ''}
      ${think.autoApplyBlocked ? `<div class="small" style="color:var(--bad)">${esc(think.autoApplyBlocked)}</div>` : ''}
      ${think.summary ? `<div class="small dim">${esc(think.summary)}</div>` : ''}
    </div>
  </details>`;
}

/* --------------------------------------------------------- deep focus card */
function renderDeepFocusCard(run) {
  const focus = run.deepFocus;
  const terminal = ['failed', 'needs_review', 'cancelled'].includes(run.status);
  const actions = [];
  if (terminal) {
    actions.push(`<button class="btn btn-sm btn-primary" data-act="df-start" data-id="${esc(run.id)}">Focus ×5</button>`);
    if (focus?.reshaped?.steps?.length && !focus.appliedAt) actions.push(`<button class="btn btn-sm btn-primary" data-act="df-apply" data-id="${esc(run.id)}" title="Snapshot gate, then reshape the workflow and re-run">Apply reshaped &amp; re-run</button>`);
    if (focus && !focus.finishedAt) actions.push(`<button class="btn btn-sm btn-ghost" data-act="df-stop" data-id="${esc(run.id)}">Stop focusing</button>`);
  }
  if (!focus && !actions.length) return '';
  const reflexBadge = (check) => check == null ? '' : check.ok === false ? '<span class="badge warnbadge">!</span>' : check.ok === true ? '<span class="badge okbadge">✓</span>' : '';
  return `
  <section class="card section-gap">
    <div class="card-head"><h3>Deep focus</h3><span class="dim small">${focus ? (focus.finishedAt ? 'concluded' : `${(focus.rounds || []).length} round(s), live`) : 'available for failed runs'}</span></div>
    <div class="card-body">
      ${!focus ? `<p class="small dim" style="margin:0">When a run fails, the app re-reads the live desktop (window in front, caret, unsaved work, minimized state), thinks, and reshapes the remaining steps — several rounds wide. You can start it now.</p>` : `
      <div class="stack" style="gap:8px">
        ${(focus.rounds || []).map((round) => `
        <div class="cc-note">
          <div class="row wrap" style="gap:6px;align-items:center">
            <span class="badge">round ${round.index}</span>
            <span class="small">${esc(round.foreground || 'nothing in front')}${round.process ? ` <span class="dim">(${esc(round.process)})</span>` : ''}</span>
            ${round.caret ? `<span class="small dim">caret: ${esc(round.caret)}</span>` : ''}
            <span class="spacer"></span>
            ${reflexBadge(round.reflexes?.windowFocus)}${reflexBadge(round.reflexes?.saveCheck)}${reflexBadge(round.reflexes?.typingFlow)}${reflexBadge(round.reflexes?.minimizeCheck)}
            <span class="badge ${round.decision === 'reshape' ? 'okbadge' : ''}">${esc(round.decision)}</span>
          </div>
          ${round.note ? `<p class="small dim" style="margin-top:4px">${esc(round.note)}</p>` : ''}
        </div>`).join('')}
        ${Object.entries(focus.reflexes || {}).filter(([, check]) => check.ok === false && check.note).length ? `<div class="hint-box small">${Object.entries(focus.reflexes).filter(([, check]) => check.ok === false && check.note).map(([name, check]) => `<div><b>${esc(name)}:</b> ${esc(check.note)}</div>`).join('')}</div>` : ''}
        ${focus.diff ? `<details ${focus.appliedAt ? '' : 'open'}><summary class="small dim">Reshape diff — ${focus.diff.added.length} added, ${focus.diff.removed.length} removed</summary><div class="stack" style="gap:4px;margin-top:6px">
          ${(focus.diff.added || []).map((step) => `<div class="small"><span class="badge okbadge">+</span> ${esc(step.type)}: ${esc(step.name || '')}</div>`).join('')}
          ${(focus.diff.removed || []).map((step) => `<div class="small"><span class="badge warnbadge">−</span> ${esc(step.type)}: ${esc(step.name || '')}</div>`).join('')}
        </div></details>` : ''}
        ${focus.conclusion ? `<p class="small"><b>Conclusion:</b> ${esc(focus.conclusion)}</p>` : ''}
        ${focus.reshaped?.steps?.length ? `<details open><summary class="small">Proposed commands — review before applying</summary><div class="stack" style="gap:6px;margin-top:6px">${focus.reshaped.steps.map((step, index) => `<div class="small"><b>${index + 1}. ${esc(step.name || step.type)}</b> <span class="dim">(${esc(step.type)})</span><pre style="white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0">${esc(JSON.stringify(step.params || {}, null, 2))}</pre></div>`).join('')}</div></details>` : ''}
        ${focus.applyGate ? `<p class="small dim">Apply gate: snapshot ${esc(String(focus.applyGate.snapshot || '').slice(0, 8))} ${focus.applyGate.blocked ? '(blocked — nothing applied)' : 'ok'}</p>` : ''}
        ${focus.error ? `<p class="small" style="color:var(--bad)">${esc(focus.error)}</p>` : ''}
      </div>`}
        <div class="row wrap" style="gap:8px;margin-top:10px">${actions.join('')}<button class="btn btn-sm" data-act="df-presentation" data-id="${esc(run.id)}" title="Turn the focus rounds into a Presentation deck">Form presentation</button></div>
    </div>
  </section>`;
}

/** Follow a background re-plan until it queues a retry or says why it did not. */
async function followReplan(runId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const res = await api(`/api/runs/${encodeURIComponent(runId)}`);
    if (!res.ok || !res.run) return;
    const replan = res.run.replan || {};
    if (replan.status === 'queued' && replan.retryRunId) {
      toast('AI plan tested; retry queued', 'ok');
      ui.selectedRun = replan.retryRunId;
      await refresh();
      await loadRun(replan.retryRunId);
      return;
    }
    if (['needs_review', 'failed'].includes(replan.status)) {
      toast(replan.reason || 'No candidate plan passed; nothing was retried', 'error');
      ui.selectedRun = runId;
      await refresh();
      await loadRun(runId);
      return;
    }
  }
  toast('Re-planning is still running; this run shows the tested plan when it finishes', 'error');
}

async function loadRun(id) {
  const changed = ui.runDetail?.id !== id || !ui.runDetailOpen;
  ui.selectedRun = id;
  ui.runDetailOpen = true;
  const res = await api(`/api/runs/${encodeURIComponent(id)}`);
  if (ui.selectedRun !== id) return;
  ui.runDetail = res.ok ? { ...res.run, recoveryPack: res.recoveryPack || null } : null;
  if (changed && !ui.simBusy) {
    const simulations = await api(`/api/runs/${encodeURIComponent(id)}/simulations`);
    if (ui.selectedRun !== id) return;
    ui.sim = simulations.ok && simulations.simulations?.length ? { runId: id, record: simulations.simulations[0] } : null;
  }
  if (ui.runDetail) ui.reviewComment = ui.runDetail.review?.comment || '';
  render();
}

async function loadShortcuts(force = false) {
  if (ui.shortcuts && !force) return ui.shortcuts;
  const res = await api('/api/shortcuts');
  if (res.ok) ui.shortcuts = { candidates: res.candidates || [], habits: res.habits || [], blocked: res.blocked || [] };
  return ui.shortcuts;
}

async function loadMission(id) {
  ui.selectedMission = id;
  const res = await api(`/api/missions/${encodeURIComponent(id)}`);
  ui.missionDetail = res.ok ? res.mission : null;
  if (!res.ok) toast(res.error || 'Could not load mission', 'error');
  render();
}

function updateMissionDraft(el) {
  const draft = missionDraft();
  const key = el.dataset.key;
  if (!key) return;
  draft[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
}

async function createMissionRequest() {
  const draft = missionDraft();
  const workflow = ui.data.workflows.find((w) => w.id === draft.workflowId);
  if (!workflow) return toast('Pick a workflow first', 'error');
  if (!String(draft.goal || '').trim()) return toast('Describe what this mission must achieve', 'error');
  ui.missionBusy = 'launching…';
  render();
  const res = await api('/api/missions', {
    method: 'POST',
    body: {
      workflowId: draft.workflowId,
      goal: draft.goal,
      mode: draft.mode,
      conditions: {
        maxAttempts: Number(draft.maxAttempts) || 2,
        checkIntervalMs: Math.max(1, Number(draft.checkSeconds) || 5) * 1000,
        vision: Boolean(draft.vision),
        autoReplan: Boolean(draft.autoReplan),
        useLearnedPatterns: Boolean(draft.useLearnedPatterns),
        observeEnabled: Boolean(draft.observeEnabled),
        autoApplyObserved: Boolean(draft.autoApplyObserved),
        newChat: draft.newChatMode === 'new' ? true : draft.newChatMode === 'reuse' ? false : null,
      },
    },
  });
  ui.missionBusy = '';
  if (!res.ok) {
    toast(res.error, 'error');
    return render();
  }
  ui.selectedMission = res.mission.id;
  ui.missionDetail = res.mission;
  toast('Mission launched — the supervisor is holding the frame.', 'ok');
  await refresh();
  await loadMission(res.mission.id);
}

/* ------------------------------------------------------------------ actions */
async function runAction(name, ds, el) {
  const d = ui.data;
  switch (name) {
    case 'memory-refresh':
      await loadWorkflowMemory(true);
      render();
      break;
    case 'memory-filter':
      ui.memoryFilter = ds.filter || 'all';
      render();
      break;
    case 'memory-new-workflow':
      await runAction('new-workflow', ds, el);
      break;
    case 'open-memory-run':
      if (!ds.id) return toast('This memory has no source run', 'error');
      ui.view = 'runs';
      loadRun(ds.id);
      break;
    case 'toggle-mode': {
      const next = !d.settings.dryRun;
      if (!next) {
        const check = await api('/api/live/check', { method: 'POST', body: {} });
        if (!check.ok || !check.available) {
          if (check.platform) d.platform = check.platform;
          renderHeader();
          return toast(`Live check failed: ${check.reason || check.error || 'desktop executor is unavailable'}`, 'error');
        }
      }
      const res = await api('/api/settings', { method: 'PATCH', body: { dryRun: next } });
      if (res.ok) {
        toast(next ? 'Simulated mode — no desktop input.' : 'Live control enabled — runs will move your mouse and type.', 'ok');
        await refresh();
      } else toast(res.error, 'error');
      break;
    }
    case 'capture-now': {
      const filled = await api('/api/captures', { method: 'POST', body: { caption: 'Manual capture' } });
      if (!filled.ok) return toast(filled.error, 'error');
      toast(filled.capture.simulated ? 'Simulated capture recorded.' : 'Screen captured.', 'ok');
      await loadCaptures();
      await refresh();
      break;
    }
    case 'admin-open': {
      await loadAuth();
      if (!ui.auth?.authenticated) ui.authDraft = { username: ui.auth?.defaultUser || 'admin', password: '', current: '', next: '' };
      openModal('admin');
      break;
    }
    case 'operator-command': {
      const mission = ui.missionDetail;
      if (!mission) return;
      const command = ui.commandDraft?.command || 'FORCE_REPLAN';
      const reason = String(ui.commandDraft?.reason || '').trim();
      if (!ui.auth?.authenticated) {
        toast('Sign in as admin to issue operator commands', 'error');
        openModal('admin');
        return;
      }
      const res = await api(`/api/missions/${encodeURIComponent(mission.id)}/command`, {
        method: 'POST',
        body: { command, reason },
      });
      if (!res.ok) {
        toast(res.error, 'error');
        if (/sign in/i.test(res.error || '')) openModal('admin');
        return;
      }
      ui.commandDraft = { command, reason: '' };
      toast(`Operator ${command} accepted and recorded.`, 'ok');
      if (command === 'RERUN' && res.mission?.id) await loadMission(res.mission.id);
      else await loadMission(mission.id);
      await refresh();
      break;
    }
    case 'model-preset': {
      const presets = {
        ollama: { apiStyle: 'ollama', baseUrl: 'https://quantumclaw.net/ollama', chatPath: '/api/chat' },
        llamacpp: { apiStyle: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', chatPath: '/chat/completions' },
        lmstudio: { apiStyle: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', chatPath: '/chat/completions' },
      };
      if (!presets[ds.preset]) return;
      ui.settingsDraft = { ...(ui.settingsDraft || ui.data.settings), ...presets[ds.preset] };
      ui.models = null;
      ui.modelsError = '';
      renderModal();
      break;
    }
    case 'cc-view':
      ui.missionEventFilter = { view: ds.view || 'all', agent: 'all', kind: 'all', severity: 'all', q: '', sort: 'newest' };
      render();
      break;
    case 'git-sync-now': {
      const res = await api('/api/git-sync/now', { method: 'POST', body: {} });
      if (!res.ok) toast(res.gitSync?.lastError || res.error || 'Sync failed', 'error');
      else toast(`Sync: ${res.gitSync?.status || 'done'}`, 'ok');
      await refresh();
      renderModal();
      break;
    }
    case 'toggle-autosync': {
      const next = ui.data?.gitSync?.enabled === false;
      const res = await api('/api/settings', { method: 'PATCH', body: { autoSync: next } });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      renderModal();
      toast(next ? 'Auto-sync on' : 'Auto-sync paused', 'ok');
      break;
    }
    case 'backup-check': {
      const res = await api('/api/backup/check', { method: 'POST', body: {} });
      toast(res.message || (res.ok ? 'Local copy checked' : 'The check needs attention'), res.ok ? 'ok' : 'error');
      await refresh();
      break;
    }
    case 'bench-answer': {
      const res = await api(`/api/bench/popup/${ds.id}/answer`, { method: 'POST', body: { decision: ds.decision, by: 'operator' } });
      toast(res.message || (res.ok ? 'Answered' : 'The bench did not take the answer'), res.ok ? 'ok' : 'error');
      await refresh();
      break;
    }
    case 'bench-test': {
      toast('Asked the bench to run that target; this can take minutes…', 'ok');
      const res = await api(`/api/bench/test/${ds.id}`, { method: 'POST', body: {} });
      toast(res.message || (res.ok ? 'The bench finished the run' : 'The bench could not run it'), res.ok ? 'ok' : 'error');
      await refresh();
      break;
    }
    case 'bench-verdict': {
      const reason = ds.decision === 'deny' ? (window.prompt('Why is this proposal denied? (kept on record, optional)') || '') : '';
      const res = await api(`/api/bench/review/${ds.id}/verdict`, { method: 'POST', body: { decision: ds.decision, reasons: reason ? [reason] : [], by: 'operator' } });
      toast(res.message || (res.ok ? 'Verdict recorded' : 'The bench refused the verdict'), res.ok ? 'ok' : 'error');
      await refresh();
      break;
    }
    case 'bench-poll': {
      await api('/api/bench/poll', { method: 'POST', body: {} });
      await refresh();
      break;
    }
    case 'backup-toggle': {
      const next = !(ui.data?.backup?.enabled);
      const body = { localBackupEnabled: next };
      if (next && !ui.data?.backup?.mirrorPath) return toast('Choose a folder first, then turn it on.', 'error');
      const res = await api('/api/settings', { method: 'PATCH', body });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      toast(next ? 'Local backup on' : 'Local backup off', 'ok');
      break;
    }
    case 'backup-path': {
      const value = String(document.getElementById('backup-path')?.value || '').trim();
      if (!value) return toast('A folder path is required.', 'error');
      const res = await api('/api/settings', { method: 'PATCH', body: { localBackupPath: value, localBackupEnabled: true } });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      toast('Backup folder saved; the first pass is cloning it.', 'ok');
      break;
    }
    case 'share-start': {
      const res = await api('/api/share/start', { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error || 'Could not start sharing', 'error');
      ui.shareLink = res.share?.link || '';
      await refresh();
      renderModal();
      toast(res.share?.publicUrl ? 'Public test link ready' : 'Test link ready on your network', 'ok');
      break;
    }
    case 'share-stop': {
      const res = await api('/api/share/stop', { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      ui.shareLink = '';
      await refresh();
      renderModal();
      toast('Sharing stopped', 'ok');
      break;
    }
    case 'copy-share-link': {
      const link = ui.data?.share?.link || ui.shareLink || '';
      try {
        await navigator.clipboard.writeText(link);
        toast('Link copied', 'ok');
      } catch {
        toast('Copy failed — select the link instead', 'error');
      }
      break;
    }
    case 'open-settings':
      ui.settingsDraft = { ...d.settings };
      openModal('settings');
      loadModels(false).then(() => {
        if (ui.modal?.type === 'settings') renderModal();
      });
      break;
    case 'sync-load':
      ui.gitInfo = null;
      await loadSync();
      break;
    case 'sync-pull':
      await syncAction('/api/git/pull', { ffOnly: true });
      break;
    case 'sync-push':
      await syncAction('/api/git/push', {});
      break;
    case 'sync-merge':
      await syncAction('/api/git/merge', {});
      break;
    case 'sync-commit':
      await syncAction('/api/git/conflicts/commit', {});
      break;
    case 'sync-ours':
      await syncAction('/api/git/conflicts/resolve', { side: 'ours' });
      break;
    case 'sync-theirs':
      await syncAction('/api/git/conflicts/resolve', { side: 'theirs' });
      break;
    case 'sync-ai':
      await syncAction('/api/git/conflicts/ai', {});
      break;
    case 'sync-pr-fetch':
      await syncAction('/api/git/prs/fetch', { number: Number(ds.id) });
      break;
    case 'sentinel-refresh':
      await refresh();
      render();
      break;
    case 'sentinel-toggle': {
      const res = await api('/api/sentinel/settings', { method: 'POST', body: { enabled: !(ui.data?.sentinel?.enabled) } });
      if (!res.ok) return toast(res.error, 'error');
      toast(res.sentinel?.enabled ? 'Sentinel is watching for changes.' : 'Sentinel paused.', 'ok');
      await refresh();
      render();
      break;
    }
    case 'sentinel-setting': {
      const key = ds.key;
      const body = {};
      body[key] = ds.value === 'on';
      const res = await api('/api/sentinel/settings', { method: 'POST', body });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      render();
      break;
    }
    case 'sentinel-run-now': {
      toast('Running the test suite…');
      const res = await api('/api/sentinel/run-now', { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      const run = res.sentinel?.lastRun;
      toast(run?.ok ? 'All tests passed.' : `${run?.fail ?? '?'} test(s) failing — queued for repair.`, run?.ok ? 'ok' : 'error');
      await refresh();
      render();
      break;
    }
    case 'sentinel-plan': {
      const res = await api(`/api/sentinel/failures/${encodeURIComponent(ds.id)}/plan`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      toast(res.failure?.plan?.text ? 'Repair plan drafted — review it before touching anything.' : 'No plan available right now.', res.failure?.plan?.text ? 'ok' : 'error');
      await refresh();
      render();
      break;
    }
    case 'sentinel-retry': {
      const res = await api(`/api/sentinel/failures/${encodeURIComponent(ds.id)}/retry`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      const run = res.sentinel?.lastRun;
      toast(run?.ok ? 'Re-run passed.' : `Still failing: ${run?.fail ?? '?'} test(s).`, run?.ok ? 'ok' : 'error');
      await refresh();
      render();
      break;
    }
    case 'sentinel-dismiss': {
      const res = await api(`/api/sentinel/failures/${encodeURIComponent(ds.id)}/dismiss`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      render();
      break;
    }
    case 'sentinel-push': {
      toast('Committing and pushing…');
      const res = await api('/api/sentinel/push-fix', { method: 'POST', body: { message: 'after sentinel auto-test' } });
      toast(res.message || res.error || 'Done', res.ok ? 'ok' : 'error');
      await refresh();
      break;
    }
    case 'sentinel-opinion': {
      const lens = ds.lens || 'skeptic';
      toast(`Drafting a ${lens} second opinion…`);
      const res = await api(`/api/opinions/sentinel-failure/${encodeURIComponent(ds.id)}`, { method: 'POST', body: { lens } });
      if (!res.ok) return toast(res.error, 'error');
      toast(res.opinion?.text ? 'Second opinion added.' : 'No opinion available right now.', res.opinion?.text ? 'ok' : 'error');
      await refresh();
      render();
      break;
    }
    case 'relay-refresh':
      await refresh();
      render();
      break;
    case 'relay-link-add': {
      const name = $('#relay-name')?.value?.trim();
      const remote = $('#relay-remote')?.value?.trim();
      const branch = $('#relay-branch')?.value?.trim() || 'main';
      if (!name || !remote) return toast('A link needs a name and a remote', 'error');
      const res = await api('/api/relay/links', { method: 'POST', body: { name, remote, branch } });
      if (!res.ok) return toast(res.error, 'error');
      toast(`Linked ${name}.`, 'ok');
      await refresh();
      render();
      break;
    }
    case 'relay-link-rm': {
      const res = await api(`/api/relay/links/${encodeURIComponent(ds.id)}`, { method: 'DELETE', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      render();
      break;
    }
    case 'relay-toggle-allowance': {
      const link = (ui.data?.relay?.links || []).find((entry) => entry.id === ds.id);
      if (!link) return;
      const next = !(link.allowances || {})[ds.key];
      const res = await api(`/api/relay/links/${encodeURIComponent(ds.id)}/settings`, { method: 'POST', body: { allowances: { [ds.key]: next } } });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      render();
      break;
    }
    case 'relay-send':
    case 'relay-send-force': {
      const paths = $(`#relay-paths-${CSS.escape(ds.id)}`)?.value?.split(',').map((part) => part.trim()).filter(Boolean) || [];
      const message = $(`#relay-msg-${CSS.escape(ds.id)}`)?.value?.trim() || '';
      if (!paths.length) return toast('Name at least one file or folder to send', 'error');
      toast('Staging and pushing…');
      const res = await api(`/api/relay/links/${encodeURIComponent(ds.id)}/send`, { method: 'POST', body: { paths, message, force: name === 'relay-send-force' } });
      toast(res.message || res.error || 'Done', res.ok ? 'ok' : 'error');
      await refresh();
      render();
      break;
    }
    case 'relay-receive': {
      const res = await api(`/api/relay/links/${encodeURIComponent(ds.id)}/receive`, { method: 'POST', body: {} });
      toast(res.message || res.error || 'Done', res.ok ? 'ok' : 'error');
      await refresh();
      render();
      break;
    }
    case 'relay-approve': {
      const res = await api(`/api/relay/reviews/${encodeURIComponent(ds.id)}/approve`, { method: 'POST', body: {} });
      toast(res.message || res.error || 'Done', res.ok ? 'ok' : 'error');
      await refresh();
      render();
      break;
    }
    case 'relay-deny': {
      const res = await api(`/api/relay/reviews/${encodeURIComponent(ds.id)}/deny`, { method: 'POST', body: { reason: 'Denied from the Relay page' } });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      render();
      break;
    }
    case 'relay-opinion': {
      toast('Asking the model…');
      const res = await api(`/api/relay/reviews/${encodeURIComponent(ds.id)}/opinion`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      render();
      break;
    }
    case 'inbox-answer': {
      const text = $(`#inbox-answer-${CSS.escape(ds.id)}`)?.value?.trim();
      if (!text) return toast('Write the answer first', 'error');
      const res = await api(`/api/inbox/${encodeURIComponent(ds.id)}/answer`, { method: 'POST', body: { answer: text } });
      if (!res.ok) return toast(res.error, 'error');
      toast('Answer sent back to the asking agent.', 'ok');
      await refresh();
      render();
      break;
    }
    case 'inbox-cancel': {
      const res = await api(`/api/inbox/${encodeURIComponent(ds.id)}/cancel`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      render();
      break;
    }
    case 'pipeline-run': {
      await api('/api/pipeline/run-now', { method: 'POST', body: {} });
      await refresh();
      render();
      break;
    }
    case 'pipeline-workers': {
      const current = Number(ui.data?.pipeline?.workers || 2);
      const next = Math.max(1, Math.min(8, current + Number(ds.delta || 1)));
      const res = await api('/api/pipeline/settings', { method: 'POST', body: { workers: next } });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      render();
      break;
    }
    case 'snapshot-create': {
      const label = $('#snapshot-label')?.value?.trim() || '';
      toast('Taking a snapshot…');
      const res = await api('/api/snapshots', { method: 'POST', body: { label } });
      toast(res.message || res.error || 'Done', res.ok ? 'ok' : 'error');
      await refresh();
      render();
      break;
    }
    case 'snapshot-diff': {
      const sel = $('#snapshot-diff-select');
      const value = sel?.value || '';
      const [a, b] = value.split('|');
      if (!a || !b) return toast('Pick two snapshots to compare', 'error');
      const res = await api('/api/snapshots/diff', { method: 'POST', body: { a, b } });
      if (!res.ok) return toast(res.error, 'error');
      ui.snapshotDiff = res;
      render();
      break;
    }
    case 'snapshot-transfer': {
      const sel = $('#snapshot-diff-select');
      const value = sel?.value || '';
      const [a, b] = value.split('|');
      if (!a || !b) return toast('Pick two snapshots first', 'error');
      toast('Applying three-way…');
      const res = await api('/api/snapshots/transfer', { method: 'POST', body: { a, b } });
      toast(res.message || res.error || 'Done', res.ok ? 'ok' : 'error');
      await refresh();
      break;
    }
    case 'snapshot-restore': {
      const id = ds.id;
      const res = await api(`/api/snapshots/${encodeURIComponent(id)}/restore`, { method: 'POST', body: {} });
      toast(res.message || res.error || 'Done', res.ok ? 'ok' : 'error');
      await refresh();
      break;
    }
    case 'alog-triage': {
      toast('Asking the model…');
      const res = await api(`/api/action-log/${encodeURIComponent(ds.id)}/triage`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      toast(res.item?.suggestion ? 'Suggestion drafted — review it in the Action log.' : 'No suggestion right now.', res.item?.suggestion ? 'ok' : 'error');
      await refresh();
      render();
      break;
    }
    case 'alog-fix': {
      const res = await api(`/api/action-log/${encodeURIComponent(ds.id)}/fix`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      toast('Marked as handled; the must-check report was updated.', 'ok');
      await refresh();
      render();
      break;
    }
    case 'alog-dismiss': {
      const res = await api(`/api/action-log/${encodeURIComponent(ds.id)}/dismiss`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      render();
      break;
    }
    case 'alog-implement': {
      toast('Turning the suggestion into workflow steps…');
      const res = await api(`/api/action-log/${encodeURIComponent(ds.id)}/implement`, { method: 'POST', body: {} });
      toast(res.message || res.error || 'Done', res.ok ? 'ok' : 'error');
      await refresh();
      render();
      break;
    }
    case 'df-start': {
      toast('Starting deep focus: live reads, then a rethink…');
      const res = await api(`/api/deep-focus/${encodeURIComponent(ds.id)}/start`, { method: 'POST', body: { rounds: 5 } });
      if (!res.ok) return toast(res.error, 'error');
      await loadRun(ds.id);
      break;
    }
    case 'df-apply': {
      toast('Snapshot gate, then applying reshaped steps…');
      const res = await api(`/api/deep-focus/${encodeURIComponent(ds.id)}/apply`, { method: 'POST', body: {} });
      toast(res.message || res.error || 'Done', res.ok ? 'ok' : 'error');
      await loadRun(ds.id);
      break;
    }
    case 'df-stop': {
      await api(`/api/deep-focus/${encodeURIComponent(ds.id)}/stop`, { method: 'POST', body: {} });
      await loadRun(ds.id);
      break;
    }
    case 'closeout-append': {
      const res = await api(`/api/closeout/${encodeURIComponent(ds.id)}/append`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      toast(`Appended ${res.appended?.appended ?? 0} follow-up step(s) to the workflow.`, 'ok');
      await loadRun(ds.id);
      break;
    }
    case 'df-presentation': {
      toast('Forming the presentation from the focus rounds…');
      const res = await api(`/api/deep-focus/${encodeURIComponent(ds.id)}/presentation`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      toast('Deck formed — open the Presentation page to view it.', 'ok');
      break;
    }
    case 'fw-mode': {
      const res = await api('/api/firewall/mode', { method: 'POST', body: { mode: ui.data?.firewall?.mode === 'enforce' ? 'log' : 'enforce' } });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      render();
      break;
    }
    case 'factoring-pin': {
      const res = await api('/api/factoring/pin', { method: 'POST', body: { workflowId: ds.id } });
      if (!res.ok) return toast(res.error, 'error');
      toast(`Pinned ${res.pinned?.pinned ?? 0} intent(s) — ${res.pinned?.kept ?? 0} already set.`, 'ok');
      await refresh();
      render();
      break;
    }
    case 'factoring-plan': {
      toast('Scanning every workflow for duplication…');
      const res = await api('/api/factoring/plan', { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      toast(res.plan?.summary || 'Scan complete.', 'ok');
      await refresh();
      render();
      break;
    }
    case 'factoring-apply': {
      const res = await api('/api/factoring/apply', { method: 'POST', body: { planId: ds.id } });
      if (!res.ok) return toast(res.error, 'error');
      toast(`Pushed ${res.applied?.suggestions?.length ?? 0} refactor suggestion(s) to the builder for your approval.`, 'ok');
      await refresh();
      render();
      break;
    }
    case 'judge-mode': {
      const res = await api('/api/judgement/mode', { method: 'POST', body: { mode: ds.mode } });
      if (!res.ok) return toast(res.error, 'error');
      toast(`Screen judgement: ${ds.mode}.`, 'ok');
      await refresh();
      render();
      break;
    }
    case 'judge-review': {
      const res = await api(`/api/judgement/reviews/${encodeURIComponent(ds.id)}/${ds.decision}`, {
        method: 'POST',
        body: {},
      });
      if (!res.ok) return toast(res.error, 'error');
      toast(ds.decision === 'accept' ? 'Applied the judgement suggestion.' : 'Suggestion dismissed.', 'ok');
      await refresh();
      render();
      break;
    }
    case 'fw-reset': {
      const res = await api('/api/firewall/reset', { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      toast('Firewall rules reset to the built-in safeguards.', 'ok');
      await refresh();
      render();
      break;
    }
    case 'fw-rule-add': {
      const name = $('#fw-name')?.value?.trim();
      const pattern = $('#fw-pattern')?.value?.trim();
      const verdict = $('#fw-verdict')?.value || 'review';
      const types = $('#fw-types')?.value?.split(',').map((t) => t.trim()).filter(Boolean) || [];
      if (!name || !pattern) return toast('A rule needs a name and a pattern', 'error');
      const res = await api('/api/firewall/rules', { method: 'POST', body: { name, pattern, verdict, types } });
      if (!res.ok) return toast(res.error, 'error');
      toast(`Rule “${name}” added.`, 'ok');
      await refresh();
      render();
      break;
    }
    case 'fw-rule-rm': {
      const res = await api(`/api/firewall/rules/${encodeURIComponent(ds.id)}`, { method: 'DELETE', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      render();
      break;
    }
    case 'fw-test': {
      const raw = $('#fw-test-input')?.value?.trim();
      if (!raw) return toast('Paste a step JSON first', 'error');
      let step;
      try { step = JSON.parse(raw); } catch { return toast('That is not valid JSON', 'error'); }
      const res = await api('/api/firewall/test', { method: 'POST', body: { step } });
      if (!res.ok) return toast(res.error, 'error');
      ui.firewallTestResult = res.verdict;
      render();
      break;
    }
    case 'note-add': {
      const text = $('#note-text')?.value?.trim();
      if (!text) return toast('Write the note first', 'error');
      const res = await api('/api/handoff/notes', { method: 'POST', body: { text } });
      if (!res.ok) return toast(res.error, 'error');
      const box = $('#note-text');
      if (box) box.value = '';
      toast('Note saved for the next agent', 'ok');
      await refresh();
      render();
      break;
    }
    case 'command-save': {
      const name = $('#command-name')?.value?.trim();
      const command = $('#command-body')?.value?.trim();
      const res = await api('/api/commands', { method: 'POST', body: { name, command } });
      if (!res.ok) return toast(res.error, 'error');
      toast(`Command “${res.command.name}” saved`, 'ok');
      await refresh();
      render();
      break;
    }
    case 'command-run': {
      toast('Running…', 'ok');
      const res = await api(`/api/commands/${encodeURIComponent(ds.id)}/run`, { method: 'POST', body: {} });
      toast(
        res.ok ? `${res.command?.name || 'Command'} finished${res.stdout ? `: ${String(res.stdout).slice(0, 120)}` : ''}` : res.error || 'Command failed',
        res.ok ? 'ok' : 'error'
      );
      await refresh();
      render();
      break;
    }
    case 'command-rm': {
      const res = await api(`/api/commands/${encodeURIComponent(ds.id)}`, { method: 'DELETE' });
      if (!res.ok) return toast(res.error, 'error');
      toast('Command removed', 'ok');
      await refresh();
      render();
      break;
    }
    case 'refresh':
      await refresh();
      break;
    case 'new-workflow': {
      const res = await api('/api/workflows', { method: 'POST', body: { name: 'Untitled workflow' } });
      if (!res.ok) return toast(res.error, 'error');
      ui.selectedWorkflow = res.workflow.id;
      ui.selectedStep = null;
      ui.draft = null;
      ui.paletteAt = 0;
      await refresh();
      break;
    }
    case 'select-workflow': {
      ui.view = 'builder';
      ui.selectedWorkflow = ds.id;
      ui.selectedStep = null;
      ui.draft = null;
      ui.paletteAt = null;
      ui.runDetail = null;
      await refresh();
      break;
    }
    case 'delete-workflow': {
      const wf = d.workflows.find((w) => w.id === ds.id);
      openModal('confirm', {
        title: 'Delete workflow',
        message: `Delete “${wf?.name}” and its steps? Existing runs and evidence stay in the run history.`,
        confirmLabel: 'Delete workflow',
        action: { act: 'delete-workflow-confirm', id: ds.id },
      });
      break;
    }
    case 'delete-workflow-confirm': {
      const res = await api(`/api/workflows/${encodeURIComponent(ds.id)}`, { method: 'DELETE' });
      closeModal();
      if (!res.ok) return toast(res.error, 'error');
      ui.selectedWorkflow = null;
      toast('Workflow deleted', 'ok');
      await refresh();
      break;
    }
    case 'wf-status': {
      const res = await api(`/api/workflows/${encodeURIComponent(ds.id)}`, { method: 'PATCH', body: { status: ds.status } });
      if (!res.ok) return toast(res.error, 'error');
      toast(ds.status === 'ready' ? 'Workflow marked Ready — background agents may queue it.' : 'Workflow marked Draft — manual runs only.', 'ok');
      await refresh();
      break;
    }
    case 'run-live-offer': {
      openModal('confirm', {
        title: 'Run this workflow live',
        message:
          'The console will drive your real desktop for this workflow: the pointer moves and keystrokes are typed into the focused window. The simulated run you just reviewed stays as it is.',
        confirmLabel: 'Run live now',
        action: { act: 'run-live-consent', id: ds.id },
      });
      break;
    }
    case 'run-live-consent': {
      closeModal();
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/run-live`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      toast('Live run started with your consent.', 'ok');
      await refresh();
      break;
    }
    case 'run-workflow': {
      const wf = d.workflows.find((w) => w.id === ds.id) || d.workflows.find((w) => w.id === ui.selectedWorkflow);
      if (!wf) return;
      const mode = ds.mode || (d.settings.dryRun ? 'dry' : 'live');
      if (mode === 'live') {
        openModal('confirm', {
          title: 'Run with live desktop control',
          message: `“${wf.name}” will run ${wf.steps.length} steps against your real desktop: the pointer will move and keystrokes will be typed into the focused window. Switch to simulated mode if you only want to validate the workflow shape.`,
          confirmLabel: 'Run live now',
          action: { act: 'run-now', id: wf.id, mode },
        });
        return;
      }
      await queueRun(wf.id, mode);
      break;
    }
    case 'run-now': {
      closeModal();
      await queueRun(ds.id, ds.mode);
      break;
    }
    case 'open-palette': {
      ui.paletteAt = Number(ds.index);
      ui.railTab = 'inspector';
      render();
      break;
    }
    case 'close-palette':
      ui.paletteAt = null;
      render();
      break;
    case 'pick-step': {
      const type = ds.type;
      const index = Number(ds.index);
      const name = TYPE_META[type]?.label || type;
      const res = await api(`/api/workflows/${encodeURIComponent(ui.selectedWorkflow)}/steps`, {
        method: 'POST',
        body: { index, step: { type, name, params: { ...(DEFAULTS[type] || {}) } } },
      });
      if (!res.ok) return toast(res.error, 'error');
      ui.paletteAt = null;
      ui.selectedStep = res.step.id;
      ui.draft = { ...res.step };
      ui.railTab = 'inspector';
      await refresh();
      break;
    }
    case 'select-step': {
      const wf = d.workflows.find((w) => w.id === ui.selectedWorkflow);
      const step = wf.steps.find((s) => s.id === ds.id);
      if (!step) return;
      ui.selectedStep = step.id;
      ui.draft = JSON.parse(JSON.stringify(step));
      ui.railTab = 'inspector';
      render();
      break;
    }
    case 'clear-step':
      ui.selectedStep = null;
      ui.draft = null;
      render();
      break;
    case 'save-step': {
      if (!ui.draft) return;
      const body = { ...ui.draft, params: coerceParams(ui.draft) };
      const res = await api(`/api/workflows/${encodeURIComponent(ui.selectedWorkflow)}/steps/${encodeURIComponent(ds.id)}`, {
        method: 'PATCH',
        body,
      });
      if (!res.ok) return toast(res.error, 'error');
      toast('Step saved', 'ok');
      ui.draft = null;
      ui.selectedStep = null;
      await refresh();
      break;
    }
    case 'lint-workflow': {
      const res = await api(`/api/workflows/${encodeURIComponent(ds.id)}/lint`, { method: 'POST' });
      if (!res.ok) return toast(res.error, 'error');
      ui.workflowLint = { workflowId: res.workflowId, issues: res.issues || [] };
      render();
      toast(res.issues?.length ? `${res.issues.length} workflow issue(s) found.` : 'Workflow lint passed.', res.issues?.length ? 'error' : 'ok');
      break;
    }
    case 'move-step': {
      const res = await api(`/api/workflows/${encodeURIComponent(ui.selectedWorkflow)}/steps/${encodeURIComponent(ds.id)}`, {
        method: 'PATCH',
        body: { move: ds.dir },
      });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      break;
    }
    case 'duplicate-step': {
      const res = await api(`/api/workflows/${encodeURIComponent(ui.selectedWorkflow)}/steps/${encodeURIComponent(ds.id)}/duplicate`, {
        method: 'POST',
      });
      if (!res.ok) return toast(res.error, 'error');
      toast('Step duplicated', 'ok');
      await refresh();
      break;
    }
    case 'delete-step': {
      const res = await api(`/api/workflows/${encodeURIComponent(ui.selectedWorkflow)}/steps/${encodeURIComponent(ds.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) return toast(res.error, 'error');
      ui.selectedStep = null;
      ui.draft = null;
      ui.paletteAt = null;
      toast('Step deleted', 'ok');
      await refresh();
      break;
    }
    case 'rail-tab':
      ui.railTab = ds.tab;
      if (ds.tab === 'copilot') await loadChat();
      render();
      break;
    case 'live-preview':
      await changeLivePreview(ds.mode === 'stop' ? 'stop' : 'start');
      break;
    case 'annotate-live-frame': {
      // The live frame is served by path, not a capture row; annotations key
      // on the frame path so every re-open of the same frame finds its pins.
      openModal('lightbox', { capture: { id: `live-frame:${ds.path}`, path: ds.path, runId: null, caption: 'Live preview frame' } });
      ui.annotateMode = true;
      renderModal();
      break;
    }
    case 'live-watch': {
      const mode = ds.mode === 'stop' ? 'stop' : 'start';
      const res = await api('/api/live/monitor', { method: 'POST', body: { action: mode } });
      if (!res.ok) {
        ui.controlOut = res.error || 'Live watch failed to start.';
        ui.controlErr = true;
        render();
        break;
      }
      ui.controlOut = mode === 'start' ? `Live watch running every ${res.monitor.intervalMs}ms with captures ${res.monitor.capture ? 'on' : 'off'}.` : 'Live watch stopped.';
      ui.controlErr = false;
      await refresh();
      break;
    }
    case 'policy-set':
      if (!ui.policy) return;
      ui.policy[ds.key] = ds.value;
      render();
      break;
    case 'save-policy': {
      const res = await api(`/api/workflows/${encodeURIComponent(ds.id)}`, {
        method: 'PATCH',
        body: { failurePolicy: ui.policy },
      });
      if (!res.ok) return toast(res.error, 'error');
      ui.policyFor = null;
      toast('Failure rules saved', 'ok');
      await refresh();
      break;
    }
    case 'plan-generate': {
      const goal = (ui.planGoal || '').trim();
      if (!goal) return toast('Describe the goal first', 'error');
      ui.planBusy = true;
      render();
      const res = await api(`/api/workflows/${encodeURIComponent(ds.id)}/plan`, { method: 'POST', body: { goal } });
      ui.planBusy = false;
      if (!res.ok) {
        toast(res.error, 'error');
        return render();
      }
      ui.planPreview = res.steps || [];
      ui.planSource = res.source;
      ui.planNote = res.note || '';
      ui.planResearch = res.research || null;
      render();
      break;
    }
    case 'proposal-generate': {
      const goal = (ui.planGoal || '').trim();
      if (!goal) return toast('Describe the goal first', 'error');
      ui.proposalBusy = true;
      render();
      const res = await api(`/api/workflows/${encodeURIComponent(ds.id)}/propose`, { method: 'POST', body: { goal } });
      ui.proposalBusy = false;
      if (!res.ok) {
        toast(res.error, 'error');
        return render();
      }
      ui.railTab = 'copilot';
      await refresh();
      toast(res.proposal?.status === 'blocked' ? 'Proposal saved but blocked by lint' : 'Research proposal ready for approval', res.proposal?.status === 'blocked' ? 'error' : 'ok');
      break;
    }
    case 'proposal-approve': {
      const res = await api(`/api/proposals/${encodeURIComponent(ds.id)}/approve`, {
        method: 'POST',
        body: { mode: ds.mode === 'append' ? 'append' : 'replace' },
      });
      if (!res.ok) return toast(res.error, 'error');
      toast(`Proposal approved · ${ds.mode === 'append' ? 'steps appended' : 'steps replaced'}`, 'ok');
      ui.planPreview = null;
      ui.planNote = '';
      ui.planResearch = null;
      await refresh();
      break;
    }
    case 'proposal-reject': {
      const res = await api(`/api/proposals/${encodeURIComponent(ds.id)}/reject`, {
        method: 'POST',
        body: { reason: 'Rejected from the proposal inbox' },
      });
      if (!res.ok) return toast(res.error, 'error');
      toast('Proposal rejected', 'ok');
      await refresh();
      break;
    }
    case 'proposal-visual-test': {
      const res = await api(`/api/proposals/${encodeURIComponent(ds.id)}/visual-test`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      toast(`Visual tester: ${res.result?.findings?.length || 0} finding(s), ${res.result?.annotations?.length || 0} annotation(s)`, res.result?.ok ? 'ok' : 'error');
      await refresh();
      break;
    }
    case 'proposal-shadow-test': {
      ui.proposalShadowBusy = ds.id;
      render();
      let res;
      try {
        res = await api(`/api/proposals/${encodeURIComponent(ds.id)}/shadow-test`, { method: 'POST', body: {} });
      } finally {
        ui.proposalShadowBusy = null;
      }
      if (!res.ok) return toast(res.error, 'error');
      toast(`Shadow test ${res.shadowTest?.status}: ${res.shadowTest?.passed}/${res.shadowTest?.total} steps · ${res.shadowTest?.checksPassed}/${res.shadowTest?.checksTotal} checks`, res.shadowTest?.ok ? 'ok' : 'error');
      await refresh();
      break;
    }
    case 'plan-remove':
      if (ui.planPreview) {
        ui.planPreview.splice(Number(ds.index), 1);
        render();
      }
      break;
    case 'plan-discard':
      ui.planPreview = null;
      ui.planNote = '';
      ui.planResearch = null;
      render();
      break;
    case 'plan-apply': {
      if (!ui.planPreview?.length) return;
      const res = await api(`/api/workflows/${encodeURIComponent(ds.id)}/steps/bulk`, {
        method: 'POST',
        body: { steps: ui.planPreview, mode: ds.mode, goal: ui.planGoal, index: ds.mode === 'append' ? undefined : undefined },
      });
      if (!res.ok) return toast(res.error, 'error');
      toast(`${res.added} step(s) ${ds.mode === 'replace' ? 'replaced' : 'added'}`, 'ok');
      ui.planPreview = null;
      ui.planNote = '';
      ui.planResearch = null;
      ui.planGoal = '';
      await refresh();
      break;
    }
    case 'chat-send': {
      const message = (ui.chatInput || '').trim();
      if (!message) return;
      ui.chatInput = '';
      ui.chatBusy = true;
      render();
      const res = await api('/api/chat', { method: 'POST', body: { message } });
      ui.chatBusy = false;
      if (!res.ok) {
        toast(`AI unavailable: ${res.error}`, 'error');
        render();
        return;
      }
      if (res.history) {
        ui.chat = res.history;
        ui.chatLoaded = true;
      }
      if (res.memory) ui.memory = res.memory;
      render();
      break;
    }
    case 'chat-clear': {
      const res = await api('/api/history', { method: 'DELETE' });
      if (!res.ok) return toast(res.error, 'error');
      ui.chat = [];
      ui.memory = null;
      ui.chatLoaded = true;
      toast('Conversation history cleared', 'ok');
      render();
      break;
    }
    case 'dismiss-suggestion': {
      await api(`/api/suggestions/${encodeURIComponent(ds.id)}`, { method: 'DELETE' });
      await refresh();
      break;
    }
    case 'ctl': {
      const c = ui.control;
      const params = { x: Number(c.x), y: Number(c.y), text: c.text, title: c.title, amount: Number(c.amount || 3) };
      if (name === 'ctl' && ds.type === 'key') params.keys = ds.keys || '{ENTER}';
      const res = await api('/api/control', { method: 'POST', body: { type: ds.type, params } });
      ui.controlErr = !res.ok;
      ui.controlOut = res.ok ? res.output || 'done' : res.error;
      render();
      break;
    }
    case 'example-select':
      ui.selectedExample = ds.id;
      render();
      break;
    case 'example-tab':
      ui.exampleTab = ds.tab;
      render();
      break;
    case 'example-import': {
      const res = await api(`/api/examples/${encodeURIComponent(ds.id)}/import`, { method: 'POST', body: { status: ds.status } });
      if (!res.ok) return toast(res.error, 'error');
      ui.selectedWorkflow = res.workflow.id;
      ui.view = 'builder';
      ui.selectedStep = null;
      ui.draft = null;
      ui.paletteAt = null;
      await refresh();
      toast(
        `Imported “${res.workflow.name}” as ${ds.status}. ${ds.status === 'ready' ? 'Background agents may queue it.' : 'Calibrate it, then mark it Ready.'}`,
        'ok'
      );
      break;
    }
    case 'python-refresh':
      await loadPython(true);
      render();
      break;
    case 'python-new':
      ui.pyDraft = { name: '', code: '"""What this script does."""\n\n\ndef main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n' };
      openModal('pynew');
      break;
    case 'python-view': {
      const file = (ui.python || []).find((f) => f.name === ds.id);
      if (!file) return toast('File not found', 'error');
      openModal('pyview', { file });
      break;
    }
    case 'python-delete':
      openModal('confirm', {
        title: 'Delete Python file',
        message: `Delete ${ds.id} from data/python? This also removes it from the Files browser.`,
        confirmLabel: 'Delete file',
        action: { act: 'python-delete-confirm', id: ds.id },
      });
      break;
    case 'python-delete-confirm': {
      const res = await api(`/api/python/${encodeURIComponent(ds.id)}`, { method: 'DELETE' });
      closeModal();
      if (!res.ok) return toast(res.error, 'error');
      await loadPython(true);
      toast('Python file deleted', 'ok');
      render();
      break;
    }
    case 'local-model-download': {
      ui.localModelBusy = 'download';
      render();
      if (ui.modal) renderModal();
      const res = await api('/api/local-model/download', { method: 'POST', body: { id: ds.id } });
      ui.localModelBusy = '';
      toast(res.ok ? 'Backup model downloaded.' : res.error || 'Download failed', res.ok ? 'ok' : 'error');
      await refresh();
      render();
      if (ui.modal) renderModal();
      break;
    }
    case 'local-model-install': {
      ui.localModelBusy = ds.runtime || 'llamacpp';
      render();
      if (ui.modal) renderModal();
      const res = await api('/api/local-model/install', { method: 'POST', body: { runtime: ds.runtime } });
      ui.localModelBusy = '';
      toast(res.ok ? `${ds.runtime === 'ollama' ? 'Ollama' : 'llama.cpp'} installed.` : res.error || 'Install failed', res.ok ? 'ok' : 'error');
      await refresh();
      render();
      if (ui.modal) renderModal();
      break;
    }
    case 'local-model-start': {
      ui.localModelBusy = 'start';
      render();
      if (ui.modal) renderModal();
      const res = await api('/api/local-model/start', { method: 'POST', body: {} });
      ui.localModelBusy = '';
      toast(res.ok ? `Serving ${res.server?.file || 'the model'} on port ${res.server?.port || ''}.` : res.error || 'Could not start the local model', res.ok ? 'ok' : 'error');
      await refresh();
      render();
      if (ui.modal) renderModal();
      break;
    }
    case 'local-model-stop': {
      const res = await api('/api/local-model/stop', { method: 'POST', body: {} });
      toast(res.ok ? 'Local model server stopped.' : res.error || 'Could not stop the local model', res.ok ? 'ok' : 'error');
      await refresh();
      render();
      if (ui.modal) renderModal();
      break;
    }
    case 'models-refresh': {
      ui.modelsBusy = true;
      ui.modelsError = '';
      render();
      if (ui.modal) renderModal();
      const res = await loadModels(true);
      if (!res.ok) ui.modelsError = res.error || 'Could not load models';
      render();
      if (ui.modal) renderModal();
      break;
    }
    case 'nav-tools':
      ui.view = 'tools';
      render();
      break;
    case 'run-filter':
      ui.runFilter = ds.filter;
      ui.selectedRun = null;
      ui.runDetail = null;
      ui.runDetailOpen = false;
      render();
      break;
    case 'select-run':
      ui.view = 'runs';
      await loadRun(ds.id);
      break;
    case 'runs-back':
      ui.runDetailOpen = false;
      render();
      window.scrollTo({ top: 0, behavior: 'auto' });
      break;
    case 'retry-run': {
      ui.runBusy = `retry:${ds.id}`;
      render();
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/replan-retry`, { method: 'POST' });
      ui.runBusy = '';
      if (!res.ok) {
        render();
        return toast(res.error, 'error');
      }
      if (res.planning) {
        render();
        toast('Re-planning in the background; the tested plan replaces this run', 'ok');
        return followReplan(res.runId);
      }
      if (!res.retried) {
        render();
        return toast(res.reason || 'No candidate plan passed the shadow test; nothing was retried', 'error');
      }
      toast(
        res.aiRevision?.decision
          ? `AI ${res.aiRevision.decision}${res.aiRevision.prepCount ? ` with ${res.aiRevision.prepCount} prep step(s)` : ''}; retry queued`
          : 'Recovery candidate tested; retry queued',
        'ok'
      );
      ui.selectedRun = res.run.id;
      await refresh();
      await loadRun(res.run.id);
      break;
    }
    case 'apply-recovery': {
      const res = await api(`/api/recovery-packs/${encodeURIComponent(ds.id)}/apply`, {
        method: 'POST',
        body: { candidateId: ds.candidate || null },
      });
      if (!res.ok) return toast(res.error, 'error');
      toast('Recovery candidate incorporated into the workflow', 'ok');
      await refresh();
      if (ui.selectedRun) await loadRun(ui.selectedRun);
      break;
    }
    case 'retry-recovery': {
      const res = await api(`/api/recovery-packs/${encodeURIComponent(ds.id)}/retry`, {
        method: 'POST',
        body: { candidateId: ds.candidate || null },
      });
      if (!res.ok) return toast(res.error, 'error');
      toast('Recovery plan queued for an aggressive test run', 'ok');
      ui.selectedRun = res.run.id;
      await refresh();
      await loadRun(res.run.id);
      break;
    }
    case 'presenter-guide': {
      const message = String(ui.presenterInput || '').trim();
      if (!message) return toast('Tell the presenter what to adjust first', 'error');
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/presenter`, {
        method: 'POST',
        body: { message, action: 'guide' },
      });
      if (!res.ok) return toast(res.error, 'error');
      ui.presenterInput = '';
      toast('Guidance sent to the foreground presenter', 'ok');
      await refresh();
      break;
    }
    case 'presenter-cmd': {
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/presenter`, {
        method: 'POST',
        body: { action: ds.cmd || 'continue' },
      });
      if (!res.ok) return toast(res.error, 'error');
      toast(`Presenter ${ds.cmd || 'continue'} requested`, 'ok');
      await refresh();
      break;
    }
    case 'presenter-collapse':
      ui.presenterCollapsed = true;
      render();
      break;
    case 'presenter-expand':
      ui.presenterCollapsed = false;
      render();
      break;
    case 'propose-run': {
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/propose`, { method: 'POST' });
      if (!res.ok) return toast(res.error, 'error');
      toast(res.proposal?.status === 'blocked' ? 'Repair proposal saved but blocked by lint' : 'Repair proposal ready for approval', res.proposal?.status === 'blocked' ? 'error' : 'ok');
      ui.view = 'builder';
      ui.selectedWorkflow = res.proposal.workflowId;
      ui.railTab = 'copilot';
      await refresh();
      break;
    }
    case 'cancel-run': {
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/cancel`, { method: 'POST' });
      if (!res.ok) return toast(res.error, 'error');
      toast(res.run.status === 'cancelled' ? 'Run cancelled' : 'Cancellation requested', 'ok');
      await loadRun(ds.id);
      break;
    }
    case 'tray-toggle': {
      ui.trayCollapsed = !ui.trayCollapsed;
      render();
      break;
    }
    case 'tray-details': {
      ui.trayExpanded = !ui.trayExpanded;
      render();
      break;
    }
    case 'tray-dismiss': {
      ui.trayDismissed = ds.id || '';
      render();
      break;
    }
    case 'observation-review': {
      if (ui.observationReviewBusy) return;
      const proposalId = document.getElementById('observation-proposal')?.value || '';
      const query = new URLSearchParams({ simulationId: ds.id });
      if (proposalId) query.set('proposalId', proposalId);
      ui.observationReviewBusy = true;
      render();
      const res = await api(`/api/observation-review?${query}`);
      ui.observationReviewBusy = false;
      if (!res.ok) {
        ui.observationReview = null;
        render();
        return toast(res.error || 'Could not load evidence profile', 'error');
      }
      ui.observationReview = { simulationId: ds.id, result: res };
      render();
      break;
    }
    case 'observation-proposal-open': {
      ui.reviewProposalTarget = ds.id;
      ui.view = 'builder';
      ui.selectedWorkflow = ds.workflow;
      ui.selectedStep = null;
      ui.draft = null;
      ui.paletteAt = null;
      ui.runDetail = null;
      ui.railTab = 'copilot';
      await refresh();
      break;
    }
    case 'run-review': {
      const runId = ds.id;
      if (!runId || ui.reviewBusy) return;
      ui.reviewBusy = true;
      render();
      const res = await api(`/api/runs/${encodeURIComponent(runId)}/review?sort=${encodeURIComponent(ui.reviewSort)}`);
      ui.reviewBusy = false;
      if (!res.ok) {
        render();
        return toast(res.error, 'error');
      }
      ui.review = { runId, record: res.review };
      render();
      return;
    }
    case 'run-simulate': {
      const runId = ds.id;
      if (!runId || ui.simBusy) return;
      ui.simBusy = true;
      const start = await api(`/api/runs/${encodeURIComponent(runId)}/simulate`, { method: 'POST' });
      if (!start.ok) {
        ui.simBusy = false;
        return toast(start.error, 'error');
      }
      ui.sim = { runId, record: start.simulation };
      render();
      const simulationId = start.simulation.id;
      const poll = async (attempt = 0, errors = 0) => {
        if (ui.sim?.record?.id !== simulationId) return;
        const res = await api(`/api/simulations/${encodeURIComponent(simulationId)}`);
        if (!res.ok) {
          if (errors < 2) {
            setTimeout(() => poll(attempt, errors + 1), 3000);
            return;
          }
          ui.simBusy = false;
          render();
          toast(`Could not check screenshot analysis: ${res.error || 'connection error'}. Try again.`, 'error');
          return;
        }
        ui.sim = { runId, record: res.simulation };
        if (res.simulation.status === 'running') {
          render();
          if (attempt === 40) toast('Screenshot check is still running; continuing to wait.');
          if (attempt < 150) {
            setTimeout(() => poll(attempt + 1), attempt < 40 ? 1200 : 5000);
            return;
          }
          ui.simBusy = false;
          render();
          toast('Screenshot check is still running. You can start another check or refresh later.', 'error');
          return;
        }
        ui.simBusy = false;
        render();
        if (res.simulation.status === 'completed') {
          const verdict = res.simulation.summary?.verdict || 'completed';
          toast(`Screenshot check: ${verdict}`, verdict === 'disagrees' ? 'error' : 'ok');
        } else {
          toast(res.simulation.error || 'Screenshot check did not finish', 'error');
        }
      };
      setTimeout(() => poll(), 700);
      break;
    }
    case 'run-control': {
      const cmd = ds.cmd;
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/control`, { method: 'POST', body: { action: cmd } });
      if (!res.ok) return toast(res.error, 'error');
      const messages = {
        pause: 'Pause requested; the run will hold at the next step boundary.',
        resume: 'Run resumed.',
        skip: 'Skip requested; the active wait or next step will be skipped.',
        continue: 'Pause and skip flags cleared.',
        bypass: 'Run now anyway: the presence hold is skipped and the step takes focus right away.',
      };
      toast(messages[cmd] || `Run ${cmd}`, 'ok');
      await loadRun(ds.id);
      await refresh();
      break;
    }
    case 'send-note': {
      const id = ds.id || ui.presentationMission || ui.selectedMission;
      const text = String(ui.presentationNote || '').trim();
      if (!id) return toast('Pick a session first', 'error');
      if (!text) return toast('Write a note before sending it', 'error');
      const res = await api(`/api/missions/${encodeURIComponent(id)}/note`, {
        method: 'POST',
        body: { text, apply: ds.apply === '1' },
      });
      if (!res.ok) return toast(res.error, 'error');
      ui.presentationNote = '';
      toast(
        res.queued
          ? 'Note queued — the supervisor applies it before the next attempt.'
          : res.replan?.applied
          ? `Note applied: ${res.replan.summary || 'route reprogrammed'}`
          : 'Note recorded for the session.',
        'ok'
      );
      if (ui.view === 'presentation') await loadPresentation(id);
      else {
        await loadMission(id);
        await refresh();
      }
      break;
    }
    case 'decision-pause':
    case 'decision-skip': {
      const id = ui.presentationMission || ui.selectedMission;
      if (!id) return;
      const action = name === 'decision-pause' ? 'pause' : 'skip';
      const res = await api(`/api/missions/${encodeURIComponent(id)}/control`, { method: 'POST', body: { action } });
      if (!res.ok) return toast(res.error, 'error');
      toast(action === 'pause' ? 'Pause requested.' : 'Skip requested.', 'ok');
      await refresh();
      await loadPresentation(id);
      break;
    }
    case 'analyze-run': {
      ui.runBusy = `analyze:${ds.id}`;
      render();
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/analyze`, { method: 'POST' });
      ui.runBusy = '';
      if (!res.ok) {
        render();
        return toast(res.error, 'error');
      }
      await loadRun(ds.id);
      toast(`Diagnosis ready · ${res.analysis?.source === 'ai' ? 'AI' : res.analysis?.source || 'heuristic'}`, 'ok');
      document.querySelector('.analysis')?.scrollIntoView({ block: 'start', behavior: 'auto' });
      break;
    }
    case 'link-pick': {
      if (ui.linkPicking) break;
      ui.linkPicking = true;
      render();
      toast('Switch to the target app and focus the control — watching for 12 seconds…');
      const deadline = Date.now() + 12000;
      let picked = null;
      let lastError = '';
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const res = await api('/api/element-links/pick', { method: 'POST' });
        if (res.ok) {
          picked = res;
          break;
        }
        lastError = res.error || lastError;
      }
      ui.linkPicking = false;
      if (!picked) {
        render();
        return toast(lastError || 'No non-console control was focused in time', 'error');
      }
      ui.linkForm = {
        ...ui.linkForm,
        window: picked.window || ui.linkForm.window,
        name: picked.name,
        controlType: picked.controlType || '',
        label: ui.linkForm.label || picked.name,
      };
      toast(`Picked “${picked.name}” · ${picked.controlType} in ${picked.window}`, 'ok');
      render();
      break;
    }
    case 'link-add': {
      const form = ui.linkForm;
      const workflowId = form.workflowId || ui.data.workflows.find((workflow) => workflow.steps.length)?.id;
      const res = await api('/api/element-links', {
        method: 'POST',
        body: { ...form, workflowId, cooldownMs: Number(form.cooldownSeconds || 60) * 1000 },
      });
      if (!res.ok) return toast(res.error, 'error');
      ui.linkForm = { label: '', window: form.window || 'YouTube', name: '', controlType: '', workflowId, action: 'mission', mode: 'auto', goal: '', cooldownMs: 60000 };
      toast('Element link created', 'ok');
      await refresh();
      render();
      break;
    }
    case 'link-toggle': {
      const res = await api(`/api/element-links/${encodeURIComponent(ds.id)}`, { method: 'PATCH', body: { enabled: ds.enabled === '1' } });
      if (!res.ok) return toast(res.error, 'error');
      await refresh();
      render();
      break;
    }
    case 'link-scan': {
      const res = await api(`/api/element-links/${encodeURIComponent(ds.id)}/scan`, { method: 'POST' });
      if (!res.ok) return toast(res.error, 'error');
      toast(res.found ? `Present: “${res.name}” (${res.controlType}) at ${res.x},${res.y}` : `Not present: ${res.reason || 'element absent'}`, res.found ? 'ok' : 'warn');
      await refresh();
      render();
      break;
    }
    case 'link-trigger': {
      const res = await api(`/api/element-links/${encodeURIComponent(ds.id)}/trigger`, { method: 'POST' });
      if (!res.ok) return toast(res.error, 'error');
      toast(res.kind === 'mission' ? 'Mission started from the linked element' : 'Workflow run queued from the linked element', 'ok');
      await refresh();
      if (res.missionId) {
        ui.view = 'command';
        await loadMission(res.missionId);
      } else render();
      break;
    }
    case 'link-delete': {
      if (!confirm('Delete this element link?')) break;
      const res = await api(`/api/element-links/${encodeURIComponent(ds.id)}`, { method: 'DELETE' });
      if (!res.ok) return toast(res.error, 'error');
      toast('Element link deleted', 'ok');
      await refresh();
      render();
      break;
    }
    case 'forward-run': {
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/forward`, { method: 'POST', body: { start: true } });
      if (!res.ok) return toast(res.error, 'error');
      ui.view = 'command';
      toast('Forwarded to Control Center — the supervisor is reviewing and repairing the workflow.', 'ok');
      await refresh();
      await loadMission(res.mission.id);
      break;
    }
    case 'apply-suggestions': {
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/apply-suggestions`, { method: 'POST' });
      if (!res.ok) return toast(res.error, 'error');
      toast('Suggested steps appended to the workflow', 'ok');
      await refresh();
      break;
    }
    case 'recheck-run': {
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/recheck`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      const recheck = res.recheck || res.run?.recheck || {};
      toast(
        `Recheck: ${Number(recheck.resolved || 0)} passed, ${Number(recheck.unresolved || 0)} open${recheck.continued ? ' — continuing the run' : ''}`,
        Number(recheck.unresolved || 0) ? 'error' : 'ok'
      );
      await refresh();
      await loadRun(ds.id);
      break;
    }
    case 'capture-run': {
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/capture`, { method: 'POST', body: { caption: 'Reviewer capture' } });
      if (!res.ok) return toast(res.error, 'error');
      toast('Evidence captured', 'ok');
      await loadRun(ds.id);
      break;
    }
    case 'review-run': {
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/review`, {
        method: 'POST',
        body: { status: ds.status, comment: ui.reviewComment || '' },
      });
      if (!res.ok) return toast(res.error, 'error');
      toast(ds.status === 'reviewed' ? 'Run marked reviewed' : 'Review reopened', 'ok');
      await loadRun(ds.id);
      break;
    }
    case 'save-review': {
      const res = await api(`/api/runs/${encodeURIComponent(ds.id)}/review`, {
        method: 'POST',
        body: { status: 'reviewed', comment: ui.reviewComment || '' },
      });
      if (!res.ok) return toast(res.error, 'error');
      toast('Review note saved and written to the run note', 'ok');
      await loadRun(ds.id);
      break;
    }
    case 'open-capture': {
      const known = (ui.captures || []).find((c) => c.id === ds.id || c.path === ds.path);
      let capture = known || {
        path: ds.path,
        caption: ds.caption,
        simulated: ds.sim === '1',
        runId: ui.selectedRun,
        createdAt: new Date().toISOString(),
      };
      if (ds.id) {
        const res = await api(`/api/captures/${encodeURIComponent(ds.id)}`);
        if (res.ok) capture = res.capture;
      }
      openModal('lightbox', { capture });
      break;
    }
    case 'capture-filter':
      ui.captureFilter = ds.filter;
      render();
      break;
    case 'tool-tab':
      ui.toolTab = ds.tab;
      render();
      break;
    case 'tool-new':
      ui.toolDraft = { name: '', description: '', code: '' };
      openModal('tool');
      break;
    case 'tool-edit': {
      const tool = d.tools.find((t) => t.id === ds.id);
      ui.toolDraft = { name: tool.name, description: tool.description || '', code: tool.code };
      openModal('tool', { tool });
      break;
    }
    case 'tool-status': {
      const res = await api(`/api/tools/${encodeURIComponent(ds.id)}`, { method: 'PATCH', body: { status: ds.status } });
      if (!res.ok) return toast(res.error, 'error');
      toast(`Tool ${ds.status}`, 'ok');
      await refresh();
      break;
    }
    case 'tool-run': {
      const tool = d.tools.find((t) => t.id === ds.id);
      ui.toolOutput = { id: ds.id, ok: true, output: 'Running…' };
      render();
      const res = await api(`/api/tools/${encodeURIComponent(ds.id)}/run`, { method: 'POST' });
      if (!res.ok) {
        ui.toolOutput = { id: ds.id, ok: false, output: res.error };
        render();
        return;
      }
      ui.toolOutput = { id: ds.id, ok: res.result.ok, output: res.result.stdout || res.result.stderr || '(no output)' };
      toast(`${tool?.name || 'Tool'} ${res.result.ok ? 'finished' : 'failed'} in ${fmtDur(res.result.ms)}`, res.result.ok ? 'ok' : 'error');
      await refresh();
      break;
    }
    case 'tool-delete': {
      const tool = d.tools.find((t) => t.id === ds.id);
      openModal('confirm', {
        title: 'Delete tool',
        message: `Delete “${tool?.name}”? Workflow steps that reference it will fail until you pick another tool.`,
        confirmLabel: 'Delete tool',
        action: { act: 'tool-delete-confirm', id: ds.id },
      });
      break;
    }
    case 'tool-delete-confirm': {
      const res = await api(`/api/tools/${encodeURIComponent(ds.id)}`, { method: 'DELETE' });
      closeModal();
      if (!res.ok) return toast(res.error, 'error');
      toast('Tool deleted', 'ok');
      await refresh();
      break;
    }
    case 'tool-generate':
      ui.toolgenPrompt = '';
      ui.toolgenError = '';
      openModal('toolgen');
      break;
    case 'file-tab':
      ui.fileTab = ds.tab;
      if (ds.tab === 'history') await loadChat();
      if (ds.tab === 'files') await loadFiles();
      render();
      break;
    case 'select-file': {
      ui.selectedFile = ds.path;
      ui.fileText = null;
      ui.fileError = null;
      ui.fileRead = null;
      ui.fileSummary = null;
      ui.fileAppend = '';
      render();
      if (!/\.(png|svg)$/i.test(ds.path)) {
        await loadFileChunk(ds.path, 0, true);
      }
      break;
    }
    case 'file-read-more':
      if (!ui.selectedFile) return toast('Select a file first', 'error');
      await loadFileChunk(ui.selectedFile, ui.fileRead?.nextOffset || 0, false);
      break;
    case 'file-read-reset':
      if (!ui.selectedFile) return;
      await loadFileChunk(ui.selectedFile, 0, true);
      break;
    case 'file-summarize': {
      if (!ui.selectedFile) return toast('Select a file first', 'error');
      ui.fileBusy = 'summary';
      render();
      const res = await api('/api/files/summarize', { method: 'POST', body: { path: ui.selectedFile } });
      ui.fileBusy = '';
      if (!res.ok) {
        ui.fileError = res.error || 'Could not summarize the file';
        render();
        return toast(ui.fileError, 'error');
      }
      ui.fileSummary = res.document;
      render();
      toast('File summary stored in long-term memory', 'ok');
      break;
    }
    case 'file-append': {
      if (!ui.selectedFile) return toast('Select a file first', 'error');
      if (!String(ui.fileAppend || '').trim()) return toast('Write or paste a chunk first', 'error');
      ui.fileBusy = 'write';
      render();
      const res = await api('/api/files/write', {
        method: 'POST',
        body: { path: ui.selectedFile, content: ui.fileAppend, mode: 'append' },
      });
      ui.fileBusy = '';
      if (!res.ok) {
        render();
        return toast(res.error || 'Could not append to the file', 'error');
      }
      ui.fileAppend = '';
      ui.fileSummary = null;
      toast(`${res.writtenTokens || 0} tokens appended`, 'ok');
      await loadFiles(true);
      await loadFileChunk(ui.selectedFile, 0, true);
      break;
    }
    case 'file-append-clear':
      ui.fileAppend = '';
      render();
      break;
    case 'memory-summarize': {
      ui.memoryBusy = 'summarizing';
      render();
      const res = await api('/api/memory/summarize', { method: 'POST', body: { maxChunks: 6 } });
      ui.memoryBusy = '';
      if (!res.ok) {
        render();
        return toast(res.error || 'Could not summarize history', 'error');
      }
      ui.memory = res.memory || ui.memory;
      await loadChat(true);
      render();
      toast(res.created ? `${res.created} memory segment(s) created` : 'History is already summarized', 'ok');
      break;
    }
    case 'chat-refresh':
      await loadChat(true);
      render();
      break;
    case 'new-note':
      ui.noteDraft = { title: '', body: '' };
      openModal('note');
      break;
    case 'edit-note': {
      const note = await api('/api/notes');
      const found = note.ok ? note.notes.find((n) => n.id === ds.id) : null;
      if (!found) return toast('Note not found', 'error');
      ui.noteDraft = { title: found.title, body: found.body };
      openModal('note', { note: found });
      break;
    }
    case 'delete-note': {
      const res = await api(`/api/notes/${encodeURIComponent(ds.id)}`, { method: 'DELETE' });
      if (!res.ok) return toast(res.error, 'error');
      toast('Note deleted', 'ok');
      await refresh();
      break;
    }
    case 'agent-toggle': {
      const res = await api(`/api/agents/${encodeURIComponent(ds.id)}`, {
        method: 'PATCH',
        body: { enabled: ds.enabled === 'true' },
      });
      if (!res.ok) return toast(res.error, 'error');
      toast(`Agent ${ds.enabled === 'true' ? 'enabled' : 'paused'}`, 'ok');
      await refresh();
      break;
    }
    case 'agent-tick': {
      const res = await api(`/api/agents/${encodeURIComponent(ds.id)}/tick`, { method: 'POST' });
      if (!res.ok) return toast(res.error, 'error');
      const r = res.result || {};
      toast(r.started ? 'Agent queued a run' : r.triaged ? `Agent triaged ${r.triaged.length} run(s)` : `Agent idle${r.skipped ? ` — ${r.skipped}` : ''}`, 'ok');
      await refresh();
      break;
    }
    case 'mission-create': {
      const draft = missionDraft();
      if (!draft.workflowId) return toast('Pick a workflow first', 'error');
      if (!String(draft.goal || '').trim()) return toast('Describe what this mission must achieve', 'error');
      if (draft.mode === 'live') {
        openModal('confirm', {
          title: 'Launch a live mission',
          message: `The supervisor will run “${
            d.workflows.find((w) => w.id === draft.workflowId)?.name || 'the workflow'
          }” against your real desktop, up to ${draft.maxAttempts} attempt(s), capturing screenshots for cross-reference. The pointer will move and keys will be typed.`,
          confirmLabel: 'Launch live mission',
          action: { act: 'mission-create-confirm' },
        });
        return;
      }
      await createMissionRequest();
      break;
    }
    case 'mission-create-confirm':
      closeModal();
      await createMissionRequest();
      break;
    case 'shortcuts-refresh':
      await loadShortcuts(true);
      render();
      break;
    case 'shortcut-decide': {
      const res = await api(`/api/shortcuts/${encodeURIComponent(ds.id)}/decision`, {
        method: 'POST',
        body: { decision: ds.decision },
      });
      if (!res.ok) return toast(res.error, 'error');
      ui.shortcuts = res.shortcuts;
      toast(
        ds.decision === 'approve'
          ? 'Shortcut approved for the planner.'
          : ds.decision === 'never'
          ? 'Shortcut blocked from future learning.'
          : 'Shortcut rejected.',
        'ok'
      );
      render();
      break;
    }
    case 'shortcut-replay': {
      const res = await api(`/api/shortcuts/habits/${encodeURIComponent(ds.id)}/replay`, { method: 'POST' });
      if (!res.ok) return toast(res.error, 'error');
      ui.shortcuts = res.shortcuts;
      toast(`Replay started as ${res.run?.id || 'a live run'}. Refresh after it finishes.`, 'ok');
      render();
      break;
    }
    case 'shortcut-habit-state': {
      const res = await api(`/api/shortcuts/habits/${encodeURIComponent(ds.id)}/state`, {
        method: 'POST',
        body: { enabled: ds.enabled === 'true' },
      });
      if (!res.ok) return toast(res.error, 'error');
      ui.shortcuts = res.shortcuts;
      toast(res.habit.enabled ? 'Shortcut enabled.' : 'Shortcut disabled.', 'ok');
      render();
      break;
    }
    case 'shortcut-unblock': {
      const res = await api(`/api/shortcuts/blocks/${encodeURIComponent(ds.id)}/undo`, { method: 'POST' });
      if (!res.ok) return toast(res.error, 'error');
      ui.shortcuts = res.shortcuts;
      toast('Never learn undone — the candidate is back in review.', 'ok');
      render();
      break;
    }
    case 'cc-agent-filter':
      ui.missionEventFilter.agent = ds.agent;
      render();
      break;
    case 'mission-select':
      if (ui.selectedMission === ds.id) return;
      ui.missionDetail = null;
      await loadMission(ds.id);
      break;
    case 'open-presentation':
      ui.view = 'presentation';
      ui.presentation = null;
      ui.presentationMission = ds.id;
      ui.presentationWorkflow = (ui.data.missions || []).find((mission) => mission.id === ds.id)?.workflowId || ui.presentationWorkflow;
      ui.presentationDeckId = null;
      ui.presentationDeck = null;
      ui.presentationDeckResults = null;
      ui.presentationSlide = 0;
      ui.presentationAudit = null;
      await loadPresentation(ds.id);
      break;
    case 'workpoint-filter':
      ui.workpointFilter = ds.filter || 'all';
      render();
      break;
    case 'presentation-refresh':
      if (ui.presentationMission) await loadPresentation(ui.presentationMission);
      else {
        await refresh();
        render();
      }
      break;
    case 'presentation-generate': {
      const workflowId = ds.id || ui.presentationWorkflow;
      if (!workflowId) return toast('Pick a workflow first', 'error');
      ui.presentationBusy = true;
      ui.presentationError = '';
      render();
      const missionId = ui.presentationMission && ui.presentation?.id === ui.presentationMission ? ui.presentationMission : null;
      const res = await api('/api/presentations/generate', {
        method: 'POST',
        body: { workflowId, missionId, focus: ui.presentationFocus || 'auto' },
      });
      ui.presentationBusy = false;
      if (!res.ok) {
        ui.presentationError = res.error || 'Could not generate the presentation';
        render();
        return toast(ui.presentationError, 'error');
      }
      ui.data.presentations = [res.presentation, ...(ui.data.presentations || []).filter((deck) => deck.id !== res.presentation.id)];
      ui.presentationDeckId = res.presentation.id;
      ui.presentationDeck = res.presentation;
      ui.presentationDeckFailedId = null;
      ui.presentationSlide = 0;
      ui.presentationAudit = res.presentation.audit || null;
      ui.videoUrl = null;
      ui.videoDeckId = null;
      ui.presentationImageDiff = null;
      ui.presentationGraph = null;
      render();
      toast(`Verified deck created · ${res.presentation.audit?.verdict || 'review'}`, res.presentation.audit?.verdict === 'blocked' ? 'error' : 'ok');
      break;
    }
    case 'presentation-audit': {
      const workflowId = ds.id || ui.presentationWorkflow;
      if (!workflowId) return toast('Pick a workflow first', 'error');
      ui.presentationAuditBusy = true;
      ui.presentationError = '';
      render();
      const missionId = ui.presentationMission && ui.presentation?.id === ui.presentationMission ? ui.presentationMission : null;
      const res = await api('/api/presentations/audit', { method: 'POST', body: { workflowId, missionId } });
      ui.presentationAuditBusy = false;
      if (!res.ok) {
        ui.presentationError = res.error || 'Could not audit the flow';
        render();
        return toast(ui.presentationError, 'error');
      }
      ui.presentationAudit = res.audit;
      render();
      toast(`Flow audit · ${res.audit.verdict} · ${res.audit.confidence}%`, res.audit.verdict === 'blocked' ? 'error' : 'ok');
      break;
    }
    case 'presentation-reapply': {
      ui.presentationReapplyBusy = true;
      ui.presentationError = '';
      render();
      const res = await api(`/api/presentations/${encodeURIComponent(ds.id)}/reapply`, { method: 'POST', body: {} });
      ui.presentationReapplyBusy = false;
      if (!res.ok) {
        ui.presentationError = res.error || 'Could not re-test the flow';
        render();
        return toast(ui.presentationError, 'error');
      }
      ui.data.presentations = [res.deck, ...(ui.data.presentations || []).filter((deck) => deck.id !== res.deck.id)];
      ui.presentationDeck = res.deck;
      ui.presentationDeckFailedId = null;
      ui.presentationAudit = res.deck.audit;
      ui.presentationImageDiff = null;
      ui.presentationGraph = null;
      render();
      toast(res.recheck.comparison.summary, res.recheck.comparison.afterVerdict === 'blocked' ? 'error' : 'ok');
      break;
    }
    case 'presentation-propose': {
      ui.presentationProposalBusy = true;
      render();
      const res = await api(`/api/presentations/${encodeURIComponent(ds.id)}/propose`, { method: 'POST', body: {} });
      ui.presentationProposalBusy = false;
      if (!res.ok) {
        render();
        return toast(res.error || 'Could not create a planner proposal', 'error');
      }
      ui.data.presentations = [res.deck, ...(ui.data.presentations || []).filter((deck) => deck.id !== res.deck.id)];
      ui.presentationDeck = res.deck;
      ui.data.proposals = [res.proposal, ...(ui.data.proposals || []).filter((proposal) => proposal.id !== res.proposal.id)];
      render();
      toast(`Planner proposal ${res.proposal.id} created · ${res.proposal.status}`, 'ok');
      break;
    }
    case 'presentation-review': {
      const res = await api(`/api/presentations/${encodeURIComponent(ds.id)}`, {
        method: 'PATCH',
        body: { status: ds.status || 'reviewed' },
      });
      if (!res.ok) return toast(res.error || 'Could not update the review', 'error');
      ui.data.presentations = [res.presentation, ...(ui.data.presentations || []).filter((deck) => deck.id !== res.presentation.id)];
      ui.presentationDeck = res.presentation;
      render();
      toast(`Deck marked ${res.presentation.review?.status || 'reviewed'}`, 'ok');
      break;
    }
    case 'presentation-load-deck':
      await loadDeck(ds.id, { force: true });
      break;
    /* ------------------------------------------------------------ ambient */
    case 'ambient-toggle': {
      ui.ambientBusy = 'toggle';
      render();
      const res = await api('/api/ambient/settings', { method: 'POST', body: { enabled: ds.enabled === 'true' || ds.enabled === true } });
      ui.ambientBusy = '';
      if (!res.ok) return toast(res.error || 'Could not update the ambient agent', 'error');
      ui.data.ambient = res.ambient;
      render();
      toast(res.ambient.enabled ? 'Ambient agent watching' : 'Ambient agent paused', 'ok');
      break;
    }
    case 'ambient-settings-save': {
      const body = {
        sampleMs: Number(domValue('#amb-sample-ms')) || 750,
        popups: domValue('#amb-popups') || 'important',
        frameClock: document.querySelector('#amb-frame-clock')?.checked !== false,
      };
      const res = await api('/api/ambient/settings', { method: 'POST', body });
      if (!res.ok) return toast(res.error || 'Could not save ambient settings', 'error');
      ui.data.ambient = res.ambient;
      render();
      toast(`Frame clock saved · sampling every ${body.sampleMs} ms`, 'ok');
      break;
    }
    case 'ambient-sample': {
      ui.ambientBusy = 'sample';
      render();
      const res = await api('/api/ambient/tick', { method: 'POST', body: {} });
      ui.ambientBusy = '';
      if (!res.ok) return toast(res.error || 'Could not sample the desktop', 'error');
      if (res.ambient) ui.data.ambient = res.ambient;
      render();
      toast(`Sampled ${res.window?.process || 'desktop'} · ${(res.fired || []).length} rule(s) fired`, 'ok');
      break;
    }
    case 'ambient-refresh-rate': {
      ui.ambientBusy = 'rate';
      render();
      const res = await api('/api/ambient/refresh');
      ui.ambientBusy = '';
      if (!res.ok) return toast(res.error || 'Could not read the refresh rate', 'error');
      ui.data.ambient = res.ambient;
      render();
      toast(`Monitor reports ${res.hz} Hz (${res.source})`, 'ok');
      break;
    }
    case 'ambient-learn': {
      ui.ambientBusy = 'learn';
      render();
      const res = await api('/api/ambient/learn', { method: 'POST', body: {} });
      ui.ambientBusy = '';
      if (!res.ok) return toast(res.error || 'Could not review habits', 'error');
      ui.data.ambient = res.ambient;
      render();
      toast(res.proposals?.length ? `${res.proposals.length} routine(s) suggested` : 'No new routine from the recent habits', res.proposals?.length ? 'ok' : '');
      break;
    }
    case 'ambient-rule-add': {
      const body = {
        name: domValue('#amb-rule-name'),
        process: domValue('#amb-rule-process'),
        title: domValue('#amb-rule-title'),
        kind: domValue('#amb-rule-kind'),
        layout: domValue('#amb-rule-layout'),
        keys: domValue('#amb-rule-keys'),
        mode: domValue('#amb-rule-mode'),
        cooldownSeconds: Number(domValue('#amb-rule-cooldown')) || 120,
      };
      const res = await api('/api/ambient/rules', { method: 'POST', body });
      if (!res.ok) return toast(res.error || 'Could not add the rule', 'error');
      ui.data.ambient = res.ambient;
      render();
      toast(`Rule “${res.rule.name}” armed`, 'ok');
      break;
    }
    case 'ambient-rule-toggle': {
      const res = await api(`/api/ambient/rules/${encodeURIComponent(ds.id)}/toggle`, { method: 'POST', body: { enabled: ds.enabled === 'true' } });
      if (!res.ok) return toast(res.error || 'Could not update the rule', 'error');
      ui.data.ambient = res.ambient;
      render();
      break;
    }
    case 'ambient-rule-run': {
      ui.ambientBusy = ds.id;
      render();
      const res = await api(`/api/ambient/rules/${encodeURIComponent(ds.id)}/run`, { method: 'POST', body: {} });
      ui.ambientBusy = '';
      if (!res.ok) return toast(res.error || 'Could not test the rule', 'error');
      ui.data.ambient = res.ambient;
      render();
      toast(res.action ? `${res.action.ok ? 'Tested' : 'Test failed'}: ${res.action.detail}` : 'Rule tested', res.action?.ok ? 'ok' : 'error');
      break;
    }
    case 'ambient-rule-delete': {
      const res = await api(`/api/ambient/rules/${encodeURIComponent(ds.id)}`, { method: 'DELETE' });
      if (!res.ok) return toast(res.error || 'Could not delete the rule', 'error');
      ui.data.ambient = res.ambient;
      render();
      toast('Rule deleted', 'ok');
      break;
    }
    case 'ambient-preset': {
      const res = await api('/api/ambient/presets', { method: 'POST', body: { name: ds.name } });
      if (!res.ok) return toast(res.error || 'Could not apply the preset', 'error');
      ui.data.ambient = res.ambient;
      render();
      toast(`Preset applied · ${(res.rules || []).map((rule) => rule.name).join(' · ')}`, 'ok');
      break;
    }
    case 'ambient-schedule-add': {
      const body = {
        name: domValue('#amb-sch-name'),
        at: domValue('#amb-sch-at'),
        days: domValue('#amb-sch-days'),
        actionKind: domValue('#amb-sch-kind'),
        target: domValue('#amb-sch-target'),
        text: domValue('#amb-sch-text'),
      };
      const res = await api('/api/ambient/schedules', { method: 'POST', body });
      if (!res.ok) return toast(res.error || 'Could not add the schedule', 'error');
      ui.data.ambient = res.ambient;
      render();
      toast(`Schedule “${res.schedule.name}” set for ${res.schedule.at}`, 'ok');
      break;
    }
    case 'ambient-schedule-toggle': {
      const res = await api(`/api/ambient/schedules/${encodeURIComponent(ds.id)}/toggle`, { method: 'POST', body: { enabled: ds.enabled === 'true' } });
      if (!res.ok) return toast(res.error || 'Could not update the schedule', 'error');
      ui.data.ambient = res.ambient;
      render();
      break;
    }
    case 'ambient-schedule-delete': {
      const res = await api(`/api/ambient/schedules/${encodeURIComponent(ds.id)}`, { method: 'DELETE' });
      if (!res.ok) return toast(res.error || 'Could not delete the schedule', 'error');
      ui.data.ambient = res.ambient;
      render();
      toast('Schedule deleted', 'ok');
      break;
    }
    case 'ambient-proposal': {
      const res = await api(`/api/ambient/proposals/${encodeURIComponent(ds.id)}`, { method: 'POST', body: { action: ds.action || 'accept' } });
      if (!res.ok) return toast(res.error || 'Could not update the routine', 'error');
      ui.data.ambient = res.ambient;
      render();
      toast(ds.action === 'dismiss' ? 'Routine dismissed' : `Routine added${res.made?.length ? `: ${res.made.join(' · ')}` : ''}`, 'ok');
      break;
    }
    case 'ambient-read': {
      const res = await api(`/api/ambient/notifications/${encodeURIComponent(ds.id)}/read`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error || 'Could not update the notification', 'error');
      ui.data.ambient = res.ambient;
      render();
      break;
    }
    case 'ambient-read-all': {
      const res = await api('/api/ambient/notifications/read-all', { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error || 'Could not mark notifications read', 'error');
      ui.data.ambient = res.ambient;
      render();
      break;
    }
    case 'ambient-note-save': {
      const text = String(ui.ambientNote || '').trim();
      if (!text) return toast('Write the preference first', 'error');
      const res = await api('/api/ambient/notes', { method: 'POST', body: { text } });
      if (!res.ok) return toast(res.error || 'Could not save the note', 'error');
      ui.ambientNote = '';
      ui.data.ambient = res.ambient;
      render();
      toast('Preference saved', 'ok');
      break;
    }
    case 'ambient-compact': {
      const res = await api('/api/ambient/compact', { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error || 'Could not tidy ambient history', 'error');
      ui.data.ambient = res.ambient;
      render();
      toast('Ambient history tidied', 'ok');
      break;
    }
    case 'companion-scan': {
      ui.companionBusy = 'scan';
      render();
      const res = await api('/api/companion/scan', { method: 'POST', body: {} });
      ui.companionBusy = '';
      if (!res.ok) return toast(res.error || 'Companion scan failed', 'error');
      ui.companion = res.companion;
      announceCompanion(ui.companion);
      render();
      toast(`Companion scanned · ${ui.companion?.summary?.proposals || 0} proposal(s) · ${ui.companion?.summary?.patterns || 0} pattern(s)`, 'ok');
      break;
    }
    case 'companion-quick': {
      ui.companionBusy = ds.id;
      render();
      const res = await api(`/api/companion/quick-help/${encodeURIComponent(ds.id)}`, { method: 'POST', body: {} });
      ui.companionBusy = '';
      if (!res.ok) return toast(res.error || 'Quick help failed', 'error');
      ui.companion = res.companion || ui.companion;
      render();
      toast(`Companion ran: ${res.item?.label || 'quick help'}`, 'ok');
      break;
    }
    case 'companion-quick-dismiss': {
      const res = await api(`/api/companion/quick-help/${encodeURIComponent(ds.id)}/dismiss`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error || 'Could not hide that suggestion', 'error');
      ui.companion = res.companion || ui.companion;
      render();
      break;
    }
    case 'companion-proposal': {
      const res = await api(`/api/companion/proposals/${encodeURIComponent(ds.id)}`, { method: 'POST', body: { action: ds.action || 'accept' } });
      if (!res.ok) return toast(res.error || 'Could not update the proposal', 'error');
      ui.companion = res.companion || ui.companion;
      render();
      toast(ds.action === 'dismiss' ? 'Proposal dismissed' : 'Proposal accepted — it stays on your plan', 'ok');
      break;
    }
    case 'companion-continue': {
      if (ds.retry) {
        ui.view = 'runs';
        ui.selectedRun = ds.retry;
        await refresh();
        await loadRun(ds.retry);
        break;
      }
      ui.companionBusy = ds.id;
      render();
      const res = await api(`/api/companion/continuations/${encodeURIComponent(ds.id)}`, { method: 'POST', body: {} });
      ui.companionBusy = '';
      if (!res.ok) return toast(res.error || 'Could not queue a recovery retry', 'error');
      ui.companion = res.companion || ui.companion;
      ui.view = 'runs';
      ui.selectedRun = res.run.id;
      await refresh();
      await loadRun(res.run.id);
      toast('Companion queued a recovery retry from the tested recovery plan', 'ok');
      break;
    }
    case 'companion-read': {
      const res = await api(`/api/companion/notifications/${encodeURIComponent(ds.id)}/read`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error || 'Could not update the notification', 'error');
      ui.companion = res.companion || ui.companion;
      render();
      break;
    }
    case 'companion-read-all': {
      const res = await api('/api/companion/notifications/read-all', { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error || 'Could not mark notifications read', 'error');
      ui.companion = res.companion || ui.companion;
      render();
      break;
    }
    case 'companion-note-save': {
      const text = String(ui.companionNote || '').trim();
      if (!text) return toast('Write a note first', 'error');
      const res = await api('/api/companion/notes', { method: 'POST', body: { text } });
      if (!res.ok) return toast(res.error || 'Could not save the note', 'error');
      ui.companionNote = '';
      ui.companion = res.companion || ui.companion;
      toast('Companion note saved', 'ok');
      render();
      break;
    }
    case 'companion-notify-permission': {
      if (typeof Notification === 'undefined') return toast('This browser does not expose desktop notifications.', 'error');
      const permission = await Notification.requestPermission();
      toast(permission === 'granted' ? 'Desktop companion alerts enabled' : 'Desktop alerts were not granted', permission === 'granted' ? 'ok' : 'error');
      break;
    }
    case 'continuity-scan': {
      ui.continuityBusy = 'scan';
      render();
      const res = await api('/api/continuity/scan', { method: 'POST', body: {} });
      ui.continuityBusy = '';
      if (!res.ok) return toast(res.error || 'Continuity scan failed', 'error');
      ui.continuity = res.continuity || ui.continuity;
      if (ui.data) ui.data.continuity = ui.continuity;
      render();
      toast(`Continuity · ${ui.continuity?.summary?.lastStatus || 'observed'} · ${ui.continuity?.summary?.windowState || 'window unknown'}`, 'ok');
      break;
    }
    case 'continuity-ai': {
      ui.continuityBusy = 'ai';
      render();
      const latest = (ui.continuity?.verdicts || [])[0] || ui.continuity?.active || null;
      const res = await api('/api/continuity/ai-review', { method: 'POST', body: { runId: latest?.runId || null } });
      ui.continuityBusy = '';
      if (!res.ok) return toast(res.error || 'AI continuity review failed', 'error');
      ui.continuity = res.continuity || ui.continuity;
      if (ui.data) ui.data.continuity = ui.continuity;
      render();
      toast(`AI continuity: ${res.ai?.decision || 'reviewed'} · ${Math.round((res.ai?.confidence || 0) * 100)}%`, 'ok');
      break;
    }
    case 'continuity-prepare': {
      ui.continuityBusy = ds.id;
      render();
      const res = await api(`/api/continuity/suggestions/${encodeURIComponent(ds.id)}/prepare`, { method: 'POST', body: {} });
      ui.continuityBusy = '';
      if (!res.ok) return toast(res.error || 'Could not prepare the draft', 'error');
      ui.continuity = res.continuity || ui.continuity;
      if (ui.data) ui.data.continuity = ui.continuity;
      ui.view = 'builder';
      ui.selectedWorkflow = res.workflow.id;
      ui.selectedStep = null;
      ui.draft = null;
      ui.paletteAt = null;
      await refresh();
      toast(`Prepared draft “${res.workflow.name}” — review before running`, 'ok');
      break;
    }
    case 'continuity-dismiss': {
      const res = await api(`/api/continuity/suggestions/${encodeURIComponent(ds.id)}/dismiss`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error || 'Could not dismiss the suggestion', 'error');
      ui.continuity = res.continuity || ui.continuity;
      if (ui.data) ui.data.continuity = ui.continuity;
      render();
      break;
    }
    case 'continuity-continue': {
      if (ds.retry) {
        ui.view = 'runs';
        ui.selectedRun = ds.retry;
        await refresh();
        await loadRun(ds.retry);
        break;
      }
      ui.continuityBusy = ds.id;
      render();
      const res = await api(`/api/continuity/continuations/${encodeURIComponent(ds.id)}`, { method: 'POST', body: {} });
      ui.continuityBusy = '';
      if (!res.ok) {
        render();
        return toast(res.error || 'Could not continue the run', 'error');
      }
      if (res.requiresApproval) {
        ui.continuityReview = res;
        ui.continuity = res.continuity || ui.continuity;
        if (ui.data) ui.data.continuity = ui.continuity;
        render();
        toast(res.candidates?.some((candidate) => candidate.test?.ok) ? 'Recovery candidate ready — review before approving' : 'No tested recovery candidate is ready', res.candidates?.some((candidate) => candidate.test?.ok) ? 'ok' : 'error');
        break;
      }
      ui.continuity = res.continuity || ui.continuity;
      if (ui.data) ui.data.continuity = ui.continuity;
      ui.view = 'runs';
      ui.selectedRun = res.run.id;
      await refresh();
      await loadRun(res.run.id);
      toast('Continuity queued a tested recovery retry', 'ok');
      break;
    }
    case 'continuity-approve': {
      if (!ui.continuityReview?.runId || !ds.candidate) return toast('Choose a tested recovery candidate first', 'error');
      ui.continuityBusy = ds.id;
      render();
      const res = await api(`/api/continuity/continuations/${encodeURIComponent(ui.continuityReview.runId)}`, {
        method: 'POST',
        body: { confirm: true, candidateId: ds.candidate },
      });
      ui.continuityBusy = '';
      if (!res.ok) {
        render();
        return toast(res.error || 'Could not approve the recovery retry', 'error');
      }
      ui.continuityReview = null;
      ui.continuity = res.continuity || ui.continuity;
      if (ui.data) ui.data.continuity = ui.continuity;
      ui.view = 'runs';
      ui.selectedRun = res.run.id;
      await refresh();
      await loadRun(res.run.id);
      toast('Approved one tested recovery retry', 'ok');
      break;
    }
    case 'continuity-review-clear': {
      ui.continuityReview = null;
      render();
      break;
    }
    case 'continuity-replan': {
      if (!ds.id) return toast('No recovery pack to replan', 'error');
      ui.continuityBusy = ds.id;
      render();
      const res = await api(`/api/recovery-packs/${encodeURIComponent(ds.id)}/replan`, { method: 'POST', body: {} });
      ui.continuityBusy = '';
      if (!res.ok) {
        render();
        return toast(res.error || 'Could not retry recovery planning', 'error');
      }
      ui.continuityReview = res;
      ui.continuity = res.continuity || ui.continuity;
      if (ui.data) ui.data.continuity = ui.continuity;
      render();
      toast(res.candidates?.some((candidate) => candidate.test?.ok) ? 'Replanned; a tested candidate is ready for approval' : 'Replanning finished without a tested candidate', res.candidates?.some((candidate) => candidate.test?.ok) ? 'ok' : 'error');
      break;
    }
    case 'presentation-watch': {
      ui.presentationWatchBusy = true;
      render();
      const res = await api(`/api/presentations/${encodeURIComponent(ds.id)}/watch`, { method: 'POST', body: {} });
      ui.presentationWatchBusy = false;
      if (!res.ok) {
        render();
        return toast(res.error || 'Deck agent failed', 'error');
      }
      if (res.presentation) ui.presentationDeck = res.presentation;
      render();
      toast(`Deck agent reviewed ${res.observed?.length || 0} deck(s)`, 'ok');
      break;
    }
    case 'presentation-budget-reset': {
      ui.presentationControlBusy = true;
      render();
      const res = await api(`/api/workflows/${encodeURIComponent(ds.id)}/retry-budget`, { method: 'POST', body: { action: 'reset' } });
      ui.presentationControlBusy = false;
      if (!res.ok) {
        render();
        return toast(res.error || 'Could not reset the retry budget', 'error');
      }
      if (ui.presentationDeck) ui.presentationDeck.retryBudget = res.retryBudget;
      ui.data.presentations = (ui.data.presentations || []).map((deck) => deck.workflowId === ds.id ? { ...deck, retryBudget: res.retryBudget } : deck);
      render();
      toast('Shared retry budget reset', 'ok');
      break;
    }
    case 'presentation-control': {
      ui.presentationControlBusy = true;
      render();
      const res = await api(`/api/presentations/${encodeURIComponent(ds.id)}/control`, {
        method: 'POST',
        body: { action: ds.control || 'pause' },
      });
      ui.presentationControlBusy = false;
      if (!res.ok) {
        render();
        return toast(res.error || 'Could not change retry control', 'error');
      }
      ui.presentationDeck = res.presentation;
      ui.presentationAudit = res.presentation.audit || null;
      render();
      toast(`Retry control: ${ds.control || 'updated'}`, 'ok');
      break;
    }
    case 'presentation-diff': {
      const deck = (ui.presentationDeck?.id === ds.id ? ui.presentationDeck : null) || (ui.data.presentations || []).find((item) => item.id === ds.id);
      if (!deck?.rechecks?.[0]) return toast('Run a fresh re-test first', 'error');
      ui.presentationDiffBusy = true;
      render();
      try {
        ui.presentationImageDiff = await computeImageDiff(deck);
      } catch (err) {
        ui.presentationDiffBusy = false;
        render();
        return toast(err.message || 'Could not compare the captures', 'error');
      }
      ui.presentationDiffBusy = false;
      render();
      toast(`Visual diff · ${ui.presentationImageDiff.pct}% pixels changed`, 'ok');
      break;
    }
    case 'presentation-graph': {
      const deck = (ui.presentationDeck?.id === ds.id ? ui.presentationDeck : null) || (ui.data.presentations || []).find((item) => item.id === ds.id);
      ui.presentationGraphBusy = true;
      render();
      const res = await api(`/api/presentations/graph?workflowId=${encodeURIComponent(deck?.workflowId || ui.presentationWorkflow || '')}`);
      ui.presentationGraphBusy = false;
      if (!res.ok) {
        render();
        return toast(res.error || 'Could not load the lineage graph', 'error');
      }
      ui.presentationGraph = res;
      render();
      break;
    }
    case 'presentation-deck':
      ui.presentationDeckId = ds.id;
      ui.presentationDeck = null;
      ui.presentationDeckFailedId = null;
      ui.presentationSlide = 0;
      ui.presentationAudit = null;
      ui.presentationImageDiff = null;
      ui.presentationGraph = null;
      ui.videoError = '';
      render();
      await loadDeck(ds.id);
      break;
    case 'presentation-slide': {
      const deck =
        (ui.presentationDeck?.id === ui.presentationDeckId ? ui.presentationDeck : null) ||
        (ui.data.presentations || []).find((item) => item.id === ui.presentationDeckId);
      if (!deck?.slides?.length) return;
      const current = Math.max(0, Math.min(deck.slides.length - 1, ui.presentationSlide || 0));
      ui.presentationSlide = ds.index != null ? Number(ds.index) : Math.max(0, Math.min(deck.slides.length - 1, current + Number(ds.delta || 0)));
      render();
      break;
    }
    case 'presentation-video': {
      const deck =
        (ui.presentationDeck?.id === ds.id ? ui.presentationDeck : null) ||
        (ui.data.presentations || []).find((item) => item.id === ds.id) ||
        (ui.data.presentations || []).find((item) => item.id === ui.presentationDeckId);
      if (!deck) return toast('Generate a deck first', 'error');
      await renderDeckVideo(deck);
      break;
    }
    case 'presentation-open-captures':
      ui.view = 'captures';
      await loadCaptures();
      render();
      break;
    case 'presentation-to-command':
      ui.view = 'command';
      ui.selectedMission = ds.id || ui.presentationMission;
      if (ui.selectedMission) await loadMission(ui.selectedMission);
      render();
      break;
    case 'presentation-capture': {
      const p = ui.presentation;
      if (!p) return;
      const res = await api('/api/captures', {
        method: 'POST',
        body: { caption: `Presentation check · ${p.workflowName}`, mode: p.mode === 'live' ? 'live' : 'dry', missionId: p.id, workflowId: p.workflowId, workflowName: p.workflowName },
      });
      if (!res.ok) return toast(res.error, 'error');
      toast(res.capture?.simulated ? 'Simulated desktop capture saved' : 'Desktop capture saved', 'ok');
      await loadPresentation(p.id);
      break;
    }
    case 'presentation-analyze': {
      if (!ds.run) return toast('No run to analyze', 'error');
      toast('Asking the model for a fix…', 'ok');
      const res = await api(`/api/runs/${encodeURIComponent(ds.run)}/analyze`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      const p = ui.presentation;
      if (p) p.analysis = res.analysis;
      render();
      toast('AI analysis ready', 'ok');
      break;
    }
    case 'presentation-redesign': {
      const id = ui.presentationMission || ui.selectedMission;
      if (!id) return;
      toast('Asking the model to redesign the workflow…', 'ok');
      const res = await api(`/api/missions/${encodeURIComponent(id)}/replan`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      toast(res.result?.applied ? `AI inserted ${res.result.steps?.length || 0} step(s)` : 'AI reviewed the plan; no steps inserted', 'ok');
      await loadPresentation(id);
      break;
    }
    case 'presentation-apply-ai': {
      if (!ds.run) return toast('No run for these steps', 'error');
      const res = await api(`/api/runs/${encodeURIComponent(ds.run)}/apply-suggestions`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      toast('AI steps applied to the workflow', 'ok');
      await loadPresentation(ui.presentationMission || ui.selectedMission);
      break;
    }
    case 'presentation-auto': {
      const id = ui.presentationMission || ui.selectedMission;
      if (!id) return;
      const res = await api(`/api/missions/${encodeURIComponent(id)}/auto`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      if (!res.acted) return toast(res.reason || 'Auto-act is not eligible', 'error');
      const nextId = res.mission?.id || id;
      ui.presentationMission = nextId;
      ui.selectedMission = nextId;
      await refresh();
      await loadPresentation(nextId);
      toast('Habit auto-act applied', 'ok');
      break;
    }
    case 'decision-form':
      ui.decisionForm = ds.form;
      ui.decisionDraft = {
        instruction: '',
        goal: ui.presentation?.goal || '',
        workflowId: ui.presentation?.workflowId || '',
      };
      render();
      break;
    case 'decision-continue':
      await missionDecision('continue');
      break;
    case 'decision-retry':
      await missionDecision('retry');
      break;
    case 'decision-retry-alt':
      await missionDecision('retry-alt');
      break;
    case 'decision-alt-goal':
      await missionDecision('alt-goal');
      break;
    case 'decision-alt-workflow':
      await missionDecision('alt-workflow');
      break;
    case 'decision-stop':
      await missionDecision('stop');
      break;
    case 'decision-ask':
      await missionDecision('ask', { instruction: ui.decisionDraft?.instruction || 'Please choose the next route.' });
      break;
    case 'decision-check': {
      const id = ui.presentationMission || ui.selectedMission;
      if (!id) return;
      const res = await api(`/api/missions/${encodeURIComponent(id)}/check`, { method: 'POST', body: {} });
      if (!res.ok) return toast(res.error, 'error');
      toast('Checkpoint captured — visual confirmation updated', 'ok');
      await loadPresentation(id);
      break;
    }
    case 'decision-queue-option': {
      const option = ds.option;
      if (option === 'alt-goal') {
        ui.decisionForm = 'goal';
        ui.decisionDraft = { ...ui.decisionDraft, goal: ui.presentation?.goal || '' };
        render();
        return;
      }
      await missionDecision(option);
      break;
    }
    case 'mission-input-extract': {
      const text = String(ui.missionInput || '').trim();
      if (!text) return toast('Write the finding or instruction first', 'error');
      ui.missionInputBusy = true;
      render();
      const res = await api(`/api/missions/${encodeURIComponent(ds.id)}/input`, {
        method: 'POST',
        body: { text },
      });
      ui.missionInputBusy = false;
      if (!res.ok) {
        toast(res.error || 'Could not extract steps', 'error');
        await refresh();
        return;
      }
      const added = Number(res.extraction?.applied || 0);
      ui.missionInput = '';
      if (res.testMission?.id) {
        toast(`${added} step block(s) added — test mission ${res.testMission.id} launched.`, 'ok');
        await refresh();
        await loadMission(res.testMission.id);
      } else {
        toast(added ? `${added} step block(s) added — the next attempt will test them.` : 'No concrete step change was found.', added ? 'ok' : 'error');
        await refresh();
        await loadMission(ds.id);
      }
      break;
    }
    case 'escalate-backlog': {
      const res = await api('/api/control-center/escalate', {
        method: 'POST',
        body: { limit: Number(ds.limit) || 3 },
      });
      if (!res.ok) return toast(res.error, 'error');
      const started = res.result?.started?.length || 0;
      const skipped = res.result?.skipped?.length || 0;
      toast(
        started
          ? `Started ${started} mission(s)${skipped ? ` · ${skipped} skipped` : ''}`
          : res.result?.skipped?.[0]?.reason || 'Nothing to escalate',
        started ? 'ok' : 'error'
      );
      await refresh();
      break;
    }
    case 'mission-action': {
      const id = ds.id;
      const cmd = ds.cmd;
      if (cmd === 'cancel') {
        openModal('confirm', {
          title: 'Cancel mission',
          message: 'The current run is stopped, the supervisor records the cancellation and the final reviewer closes the mission. Evidence stays in the run history.',
          confirmLabel: 'Cancel mission',
          action: { act: 'mission-action', id, cmd: 'cancel-now' },
        });
        return;
      }
      if (cmd === 'skip' || cmd === 'continue') {
        ui.missionBusy = cmd === 'skip' ? 'requesting a step skip' : 'clearing the pause';
        render();
        const res = await api(`/api/missions/${encodeURIComponent(id)}/control`, { method: 'POST', body: { action: cmd } });
        ui.missionBusy = '';
        if (!res.ok) {
          toast(res.error, 'error');
          await refresh();
          return;
        }
        toast(cmd === 'skip' ? 'Skip requested; the active wait or next step will be skipped.' : 'Run continued.', 'ok');
        await loadMission(id);
        await refresh();
        return;
      }
      const action = cmd === 'cancel-now' ? 'cancel' : cmd;
      ui.missionBusy = `${action === 'check' ? 'capturing a checkpoint' : action === 'replan' ? 'researching a replan' : action + 'ing'}…`;
      render();
      const res = await api(`/api/missions/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      ui.missionBusy = '';
      if (!res.ok) {
        toast(res.error, 'error');
        await refresh();
        return;
      }
      toast(
        action === 'check'
          ? 'Checkpoint captured and cross-referenced.'
          : action === 'replan'
          ? 'Planner returned a replan — see the replan list.'
          : action === 'retry'
          ? 'New mission launched from this one.'
          : `Mission ${action}.`,
        'ok'
      );
      await loadMission(id);
      await refresh();
      break;
    }
    case 'mission-open-run':
      ui.view = 'runs';
      await loadRun(ds.id);
      break;
    case 'open-knack':
      ui.view = 'examples';
      ui.exampleTab = 'knack';
      await loadKnack(true);
      render();
      break;
    case 'tool-new':
      ui.toolDraft = { name: '', description: '', code: '' };
      openModal('tool');
      break;
    case 'save-settings': {
      const settings = ui.settingsDraft || {};
      const body = {
        baseUrl: settings.baseUrl,
        chatPath: settings.chatPath,
        endpoint: settings.endpoint,
        model: settings.model,
        apiStyle: settings.apiStyle === 'openai' ? 'openai' : 'ollama',
        dryRun: settings.dryRun === true || settings.dryRun === 'true',
        agentTickMs: Number(settings.agentTickMsSeconds || 5) * 1000,
        missionCheckIntervalMs: Number(settings.missionCheckIntervalSeconds || 5) * 1000,
        replanModel: settings.replanModel || '',
        visualTesterUrl: settings.visualTesterUrl || '',
        visualTesterEnabled: settings.visualTesterEnabled !== false,
        visualTesterTimeoutMs: Number(settings.visualTesterTimeoutMs || 25000),
        visionEnabled: settings.visionEnabled === true,
        autoActEnabled: settings.autoActEnabled === true,
        autoActThreshold: Number(settings.autoActThreshold || 80),
        autoForwardFailures: settings.autoForwardFailures === true,
        autoEscalateMinFailures: Number(settings.autoEscalateMinFailures || 2),
        autoEscalateDailyCap: Number(settings.autoEscalateDailyCap ?? 3),
        autoProposeFailures: settings.autoProposeFailures === true,
        autoRecoverFailures: settings.autoRecoverFailures !== false,
        recoveryMaxAttempts: Number(settings.recoveryMaxAttempts || 2),
        replanMedia: settings.replanMedia !== false,
        presenceEnabled: settings.presenceEnabled !== false,
        presenceHoldMs: Number(settings.presenceHoldSeconds || 10) * 1000,
        presenceMaxDeferMs: Number(settings.presenceMaxDeferSeconds || 60) * 1000,
        presenterSettleMs: Number(settings.presenterSettleMs ?? 2000),
        presenterInputPolicy: ['auto', 'wait', 'stop'].includes(settings.presenterInputPolicy) ? settings.presenterInputPolicy : 'auto',
        presenterAutoContinueMs: Number(settings.presenterAutoContinueSeconds || 15) * 1000,
        companionEnabled: settings.companionEnabled !== false,
        companionLearning: settings.companionLearning !== false,
        companionNotifications: settings.companionNotifications !== false,
        companionSystemScan: settings.companionSystemScan !== false,
        companionPopupPolicy: ['off', 'important', 'all'].includes(settings.companionPopupPolicy) ? settings.companionPopupPolicy : 'important',
        continuityEnabled: settings.continuityEnabled !== false,
        continuityAutoContinue: settings.continuityAutoContinue !== false,
        continuityFrameWatch: settings.continuityFrameWatch !== false,
        continuityFrameMs: Number(settings.continuityFrameMs || 5000),
        continuityAiReview: settings.continuityAiReview === true,
        continuityVisionReadiness: settings.continuityVisionReadiness === true,
        autoNotes: settings.autoNotes !== false,
        aiSuggestions: settings.aiSuggestions !== false,
        requireToolApproval: settings.requireToolApproval !== false,
        autoPull: settings.autoPull === true,
        autoSyncIntervalMs: Number(settings.autoSyncIntervalMs || 10000),
        stepThink: {
          enabled: settings.stepThinkEnabled !== false,
          liveLink: settings.stepThinkLiveLink !== false,
          modelAssist: settings.stepThinkModelAssist !== false,
          autoApply: settings.stepThinkAutoApply !== false,
          maxChoices: Number(settings.stepThinkMaxChoices ?? settings.stepThink?.maxChoices ?? 7),
          pixels: Number(settings.stepThinkPixels ?? settings.stepThink?.pixels ?? 48),
          elements: Number(settings.stepThinkElements ?? settings.stepThink?.elements ?? 25),
          previewIntervalMs: Number(settings.stepThinkPreviewMs ?? settings.stepThink?.previewIntervalMs ?? 2000),
          mirrorIntervalMs: Number(settings.stepThinkMirrorMs ?? settings.stepThink?.mirrorIntervalMs ?? 4000),
          sideBySide: settings.stepThinkSideBySide === true,
          readOnce: settings.stepThinkReadOnce !== false,
          higherThinking: settings.stepThinkHigherThinking === true,
          overseer: settings.stepThinkOverseer === true,
          keepRunning: settings.stepThinkKeepRunning === true,
          monitorIntervalMs: Number(settings.stepThinkMonitorMs ?? settings.stepThink?.monitorIntervalMs ?? 3000),
          maxStepFailures: Number(settings.stepThinkMaxStepFailures ?? settings.stepThink?.maxStepFailures ?? 3),
          maxReplans: Number(settings.stepThinkMaxReplans ?? settings.stepThink?.maxReplans ?? 2),
        },
        recheck: {
          enabled: settings.recheckEnabled !== false,
          continueAfter: settings.recheckContinueAfter === true,
          prepMs: Number(settings.recheckPrepMs ?? settings.recheck?.prepMs ?? 4000),
          maxAttempts: Number(settings.recheckMaxAttempts ?? settings.recheck?.maxAttempts ?? 3),
          intervalMs: Number(settings.recheckIntervalMs ?? settings.recheck?.intervalMs ?? 3000),
          maxPendingMs: Number(settings.recheckMaxPendingMs ?? settings.recheck?.maxPendingMs ?? 45000),
        },
      };
      const res = await api('/api/settings', { method: 'PATCH', body });
      if (!res.ok) return toast(res.error, 'error');
      closeModal();
      ui.settingsDraft = null;
      toast('Settings saved', 'ok');
      await refresh();
      loadHealth();
      break;
    }
    case 'modal-close':
      closeModal();
      break;
    default:
      break;
  }
}

function coerceParams(draft) {
  const out = {};
  for (const field of FIELDS[draft.type] || []) {
    let value = draft.params?.[field.key];
    if (field.type === 'number') {
      if (value === '' || value == null) continue;
      const n = Number(value);
      if (Number.isFinite(n)) out[field.key] = n;
      continue;
    }
    if (value === undefined || value === null) continue;
    out[field.key] = value;
  }
  // keep any params the schema does not know about, so nothing is silently dropped
  for (const [k, v] of Object.entries(draft.params || {})) if (!(k in out)) out[k] = v;
  return out;
}

async function queueRun(id, mode) {
  mode = mode || (ui.data?.settings?.dryRun ? 'dry' : 'live');
  if (mode === 'live') {
    const check = await api('/api/live/check', { method: 'POST', body: {} });
    if (!check.ok || !check.available) {
      if (check.platform) ui.data.platform = check.platform;
      render();
      return toast(`Live check failed: ${check.reason || check.error || 'desktop executor is unavailable'}`, 'error');
    }
  }
  // A double click used to queue two runs and the second one could fail, which
  // read as "the button does not work". One run per click, always.
  if (ui.runStarting) return toast('A run is already being queued…', 'info');
  ui.runStarting = true;
  try {
    const res = await api(`/api/workflows/${encodeURIComponent(id)}/runs`, {
      method: 'POST',
      body: { mode, trigger: 'manual' },
    });
    if (!res.ok) return toast(res.error || 'The run could not be queued', 'error');
    if (res.liveFallback) {
      // The live backend refused (usually a hosted preview reporting the wrong
      // platform); the run proceeds simulated and the mismatch is logged for the fixer.
      toast(`Live was refused (${String(res.liveFallback).slice(0, 80)}) — the run is going ahead simulated. Logged to must-check.`, 'error');
    } else {
    const holdReason = ui.data?.settings?.presenceEnabled !== false && mode === 'live';
    toast(
      mode === 'live'
        ? holdReason
          ? 'Live run queued — it starts now and waits for the desktop to go quiet before it takes focus.'
          : 'Live run queued — watch the desktop.'
        : 'Simulated run queued in the background.',
      'ok'
    );
    }
    ui.view = 'runs';
    ui.selectedRun = res.run.id;
    ui.runFilter = 'all';
    await refresh();
    await loadRun(res.run.id);
  } finally {
    ui.runStarting = false;
  }
}

/* ------------------------------------------------------------------ events */
document.addEventListener('error', (event) => {
  if (!event.target.matches?.('[data-preview-image]') || !ui.preview.active) return;
  if (ui.preview.detail) ui.preview.detail.imagePath = null;
  ui.preview.message = 'The preview screenshot could not be loaded. Retrying while preview is active.';
  updatePreviewCard();
}, true);

/* Drag-to-draw annotation boxes: in annotate mode, a drag over the capture
   draws a rectangle and asks what it marks; a plain click still drops a pin. */
let annotateDraw = null;
document.addEventListener('mousedown', (event) => {
  if (!ui.annotateMode || !event.target.matches?.('#annotate-stage img')) return;
  const rect = event.target.getBoundingClientRect();
  annotateDraw = {
    image: event.target,
    startX: (event.clientX - rect.left) / rect.width,
    startY: (event.clientY - rect.top) / rect.height,
    endX: null,
    endY: null,
    box: null,
  };
  event.preventDefault();
});
document.addEventListener('mousemove', (event) => {
  if (!annotateDraw) return;
  const rect = annotateDraw.image.getBoundingClientRect();
  annotateDraw.endX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  annotateDraw.endY = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  let ghost = document.getElementById('annotate-ghost');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = 'annotate-ghost';
    ghost.style.cssText = 'position:absolute;border:2px dashed #7c5cff;background:rgba(124,92,255,.12);border-radius:4px;pointer-events:none';
    annotateDraw.image.parentElement.appendChild(ghost);
  }
  const left = Math.min(annotateDraw.startX, annotateDraw.endX);
  const top = Math.min(annotateDraw.startY, annotateDraw.endY);
  const w = Math.abs(annotateDraw.endX - annotateDraw.startX);
  const h = Math.abs(annotateDraw.endY - annotateDraw.startY);
  ghost.style.left = `${left * 100}%`;
  ghost.style.top = `${top * 100}%`;
  ghost.style.width = `${w * 100}%`;
  ghost.style.height = `${h * 100}%`;
});
document.addEventListener('mouseup', async (event) => {
  if (!annotateDraw) return;
  const draw = annotateDraw;
  annotateDraw = null;
  document.getElementById('annotate-ghost')?.remove();
  if (draw.endX === null) return; // a click without movement: the pin handler takes it
  const w = Math.abs(draw.endX - draw.startX);
  const h = Math.abs(draw.endY - draw.startY);
  if (w < 0.03 || h < 0.03) return; // too small to be deliberate: treat as a click
  ui.annotateDragged = true;
  setTimeout(() => { ui.annotateDragged = false; }, 250); // the click event fires after mouseup
  const capture = ui.modal?.payload?.capture;
  if (!capture?.id) return;
  const text = window.prompt('What does this region mark?') || '';
  if (!text) return;
  const res = await api('/api/annotations', {
    method: 'POST',
    body: {
      ref: { captureId: capture.id, runId: capture.runId || null },
      kind: 'box',
      x: Math.min(draw.startX, draw.endX),
      y: Math.min(draw.startY, draw.endY),
      w,
      h,
      text,
      by: 'operator',
      color: '#7c5cff',
    },
  });
  if (!res.ok) return toast(res.error, 'error');
  const list = await api(`/api/annotations?captureId=${encodeURIComponent(capture.id)}`);
  ui.captureAnnotations = list.ok ? list.annotations || [] : [];
  renderModal();
  toast('Box annotation added.', 'ok');
});

document.addEventListener('click', (event) => {
  if (event.target.hasAttribute?.('data-modal-backdrop')) return closeModal();
  if (event.target.hasAttribute?.('data-lightbox-backdrop')) return closeModal();
  const nav = event.target.closest('[data-nav]');
  if (nav) {
    noteUiAction(`nav:${nav.dataset.nav}`);
    ui.view = nav.dataset.nav;
    if (ui.view === 'runs') ui.runDetailOpen = false;
    if (ui.view === 'captures') loadCaptures();
    if (ui.view === 'files') {
      if (ui.fileTab === 'history') loadChat();
      loadFiles().then(render);
    }
    if (ui.view === 'examples') loadExamples().then(render);
    if (ui.view === 'shortcuts') loadShortcuts().then(render);
    if (ui.view === 'memory') loadWorkflowMemory(true).then(render);
    if (ui.view === 'companion') loadCompanion({ scan: !ui.companion || !(ui.companion.quickHelp || []).length }).then(render);
    if (ui.view === 'continuity') loadContinuity().then(render);
    if (ui.view === 'python') loadPython().then(render);
    if (ui.view === 'command' && !ui.selectedMission && ui.data?.missions?.length) {
      loadMission(ui.data.missions[0].id);
    }
    if (ui.view === 'presentation') {
      const id = ui.presentationMission || ui.selectedMission || ui.data?.missions?.[0]?.id;
      if (id) loadPresentation(id);
    }
    render();
    if (ui.view === 'runs') refresh();
    return;
  }
  const modalAction = event.target.closest('[data-mact]');
  if (modalAction) {
    const act = modalAction.dataset.mact;
    if (act === 'close') return closeModal();
    if (act === 'confirm') {
      const action = ui.modal?.payload?.action;
      closeModal();
      if (action) runAction(action.act, action);
      return;
    }
    if (act === 'save-tool') {
      const draft = ui.toolDraft;
      if (!draft?.code?.trim()) return toast('Script body is required', 'error');
      const id = modalAction.dataset.id;
      const req = id
        ? api(`/api/tools/${encodeURIComponent(id)}`, { method: 'PATCH', body: draft })
        : api('/api/tools', { method: 'POST', body: draft });
      req.then(async (res) => {
        if (!res.ok) return toast(res.error, 'error');
        closeModal();
        ui.toolDraft = null;
        toast(id ? 'Tool saved' : 'Tool created as draft — approve it to run.', 'ok');
        await refresh();
      });
      return;
    }
    if (act === 'generate-tool') {
      const prompt = (ui.toolgenPrompt || '').trim();
      if (!prompt) return toast('Describe the helper first', 'error');
      ui.toolgenBusy = true;
      ui.toolgenError = '';
      renderModal();
      api('/api/tools/generate', { method: 'POST', body: { prompt } }).then(async (res) => {
        ui.toolgenBusy = false;
        if (!res.ok) {
          ui.toolgenError = res.error;
          return renderModal();
        }
        closeModal();
        ui.toolgenPrompt = '';
        toast(`AI created “${res.tool.name}” as a draft. Review the script, then approve.`, 'ok');
        await refresh();
      });
      return;
    }
    if (act === 'save-python') {
      const draft = ui.pyDraft;
      if (!draft?.name?.trim()) return toast('File name is required', 'error');
      api('/api/python', { method: 'POST', body: draft }).then(async (res) => {
        if (!res.ok) return toast(res.error, 'error');
        closeModal();
        ui.pyDraft = null;
        await loadPython(true);
        ui.view = 'python';
        toast('Python file saved to data/python', 'ok');
        render();
      });
      return;
    }
    if (act === 'save-note') {
      const draft = ui.noteDraft;
      if (!draft?.title?.trim()) return toast('Give the note a title', 'error');
      const id = modalAction.dataset.id;
      const req = id
        ? api(`/api/notes/${encodeURIComponent(id)}`, { method: 'PATCH', body: draft })
        : api('/api/notes', { method: 'POST', body: draft });
      req.then(async (res) => {
        if (!res.ok) return toast(res.error, 'error');
        closeModal();
        ui.noteDraft = null;
        toast('Note saved', 'ok');
        await refresh();
      });
      return;
    }
    if (act === 'toggle-annotate') {
      const capture = ui.modal?.payload?.capture;
      ui.annotateMode = !ui.annotateMode;
      ui.captureAnnotations = [];
      if (ui.annotateMode && capture) {
        api(`/api/annotations?captureId=${encodeURIComponent(capture.id || '')}`).then(async (res) => {
          if (res.ok) {
            ui.captureAnnotations = res.annotations || [];
            renderModal();
          }
        });
      }
      renderModal();
      return;
    }
    if (ui.annotateMode && event.target.matches?.('#annotate-stage img')) {
      if (ui.annotateDragged) { ui.annotateDragged = false; return; } // a drag just drew a box
      const capture = ui.modal?.payload?.capture;
      if (!capture?.id) return toast('This screenshot has no saved capture id', 'error');
      const rect = event.target.getBoundingClientRect();
      const x = Math.round(((event.clientX - rect.left) / rect.width) * 1000) / 1000;
      const y = Math.round(((event.clientY - rect.top) / rect.height) * 1000) / 1000;
      const text = window.prompt('What does this spot mean? (leave empty for a bare pin)') || '';
      api('/api/annotations', { method: 'POST', body: { ref: { captureId: capture.id, runId: capture.runId || null }, kind: 'pin', x, y, text, by: 'operator', color: '#e5484d' } }).then(async (res) => {
        if (!res.ok) return toast(res.error, 'error');
        const list = await api(`/api/annotations?captureId=${encodeURIComponent(capture.id)}`);
        ui.captureAnnotations = list.ok ? list.annotations || [] : [];
        renderModal();
      });
      return;
    }
    if (act === 'capture-add-mark') {
      const capture = ui.modal?.payload?.capture;
      if (!capture?.id) return toast('This screenshot has no saved capture id', 'error');
      const label = String(document.querySelector('#capture-mark-label')?.value || '').trim();
      const x = Number(document.querySelector('#capture-mark-x')?.value);
      const y = Number(document.querySelector('#capture-mark-y')?.value);
      if (!label) return toast('Give the mark a label', 'error');
      if (!Number.isFinite(x) || !Number.isFinite(y)) return toast('X and Y must be percentages', 'error');
      const marks = [...(capture.marks || []), { label, x, y }];
      api(`/api/captures/${encodeURIComponent(capture.id)}`, { method: 'PATCH', body: { marks } }).then(async (res) => {
        if (!res.ok) return toast(res.error, 'error');
        if (ui.modal?.payload?.capture) ui.modal.payload.capture = res.capture;
        renderModal();
        await loadCaptures();
        toast('Screenshot mark added', 'ok');
      });
      return;
    }
    if (act === 'capture-clear-marks') {
      const capture = ui.modal?.payload?.capture;
      if (!capture?.id) return toast('This screenshot has no saved capture id', 'error');
      api(`/api/captures/${encodeURIComponent(capture.id)}`, { method: 'PATCH', body: { marks: [] } }).then(async (res) => {
        if (!res.ok) return toast(res.error, 'error');
        if (ui.modal?.payload?.capture) ui.modal.payload.capture = res.capture;
        renderModal();
        await loadCaptures();
        toast('Screenshot marks cleared', 'ok');
      });
      return;
    }
    if (act === 'admin-login') {
      const draft = ui.authDraft || {};
      api('/api/auth/login', { method: 'POST', body: { username: draft.username, password: draft.password } }).then(async (res) => {
        if (!res.ok) return toast(res.error || 'Sign-in failed', 'error');
        ui.authDraft = { username: draft.username, password: '', current: '', next: '' };
        closeModal();
        await loadAuth();
        toast(`Signed in as ${res.admin.username}`, 'ok');
        refresh();
      });
      return;
    }
    if (act === 'admin-logout') {
      api('/api/auth/logout', { method: 'POST' }).then(async () => {
        closeModal();
        await loadAuth();
        toast('Admin signed out', 'ok');
        render();
      });
      return;
    }
    if (act === 'admin-password') {
      const draft = ui.authDraft || {};
      api('/api/auth/password', { method: 'POST', body: { current: draft.current, next: draft.next } }).then(async (res) => {
        if (!res.ok) return toast(res.error, 'error');
        ui.authDraft = { ...draft, current: '', next: '' };
        closeModal();
        await loadAuth();
        toast('Admin password updated', 'ok');
      });
      return;
    }
    if (act === 'save-settings') {
      ui.settingsDraft = { ...(ui.settingsDraft || {}) };
      return runAction('save-settings');
    }
    if (act === 'open-run') {
      const id = modalAction.dataset.id;
      closeModal();
      ui.view = 'runs';
      loadRun(id);
      return;
    }
    if (act === 'delete-capture') {
      const id = modalAction.dataset.id;
      const path = modalAction.dataset.path;
      api(`/api/captures/${encodeURIComponent(id || path)}`, { method: 'DELETE' }).then(async (res) => {
        closeModal();
        if (!res.ok) return toast(res.error, 'error');
        toast('Capture deleted', 'ok');
        await loadCaptures();
        await refresh();
        if (ui.view === 'runs' && ui.selectedRun) await loadRun(ui.selectedRun);
      });
      return;
    }
    return;
  }
  const target = event.target.closest('[data-act]');
  if (!target) return;
  const act = target.dataset.act;
  if (act === 'select-step' && event.target.closest('.step-actions')) return;
  noteUiAction(act);
  runAction(act, target.dataset, target);
});

document.addEventListener('change', (event) => {
  const el = event.target;
  const scope = el.dataset.scope;
  if (!scope) return;
  const key = el.dataset.key;
  const value = el.type === 'checkbox' ? el.checked : el.value;

  if (scope === 'target-os') {
    el.disabled = true;
    api('/api/settings', { method: 'PATCH', body: { targetPlatform: value } }).then(async (res) => {
      el.disabled = false;
      if (!res.ok) {
        el.value = ui.data?.settings?.targetPlatform || 'win32';
        toast(res.error || 'Could not update planning OS', 'error');
        return;
      }
      if (ui.data?.settings) ui.data.settings.targetPlatform = value;
      toast(`AI planning target set to ${{ win32: 'Windows 11', linux: 'Linux/X11', darwin: 'macOS', android: 'Android' }[value] || 'Windows 11'}`, 'ok');
      await refresh();
    });
    return;
  }
  if (scope === 'review-sort') {
    ui.reviewSort = value;
    const runId = el.dataset.id;
    if (ui.review?.runId !== runId) return;
    api(`/api/runs/${encodeURIComponent(runId)}/review?sort=${encodeURIComponent(value)}`).then((res) => {
      if (!res.ok || ui.review?.runId !== runId) return;
      ui.review = { runId, record: res.review };
      render();
    });
    return;
  }
  if (scope === 'observation-proposal') {
    ui.observationProposal = { simulationId: el.dataset.id, proposalId: value };
    ui.observationReview = null;
    render();
    return;
  }
  if (scope === 'linkform') {
    ui.linkForm[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    return;
  }
  if (scope === 'memory') {
    ui.memoryWorkflow = value;
    loadWorkflowMemory(true).then(render);
    return;
  }
  if (scope === 'wf') {
    const body = key === 'patternTagsCsv' ? { patternTags: String(value).split(',') } : { [key]: value };
    api(`/api/workflows/${encodeURIComponent(el.dataset.id)}`, { method: 'PATCH', body }).then((res) => {
      if (!res.ok) return toast(res.error, 'error');
      refresh();
    });
    return;
  }
  if (scope === 'drafttype') {
    if (!ui.draft) return;
    ui.draft.type = value;
    ui.draft.params = { ...(DEFAULTS[value] || {}) };
    ui.draft.name = TYPE_META[value]?.label || value;
    render();
    return;
  }
  if (scope === 'draft') {
    if (!ui.draft) return;
    if (key === 'timeoutMs') ui.draft.timeoutMs = Number(value);
    else if (key === 'optional') ui.draft.optional = Boolean(value);
    else if (key === 'name') ui.draft.name = value;
    else if (key === 'condition') ui.draft.condition = value || null;
    else ui.draft.params = { ...ui.draft.params, [key]: value };
    return;
  }
  if (scope === 'policy') {
    if (!ui.policy) return;
    ui.policy[key] = el.type === 'checkbox' ? Boolean(value) : el.type === 'number' ? Number(value) : value;
    if (key === 'onFailure') render();
    return;
  }
  if (scope === 'control') {
    ui.control[key] = value;
    return;
  }
  if (scope === 'presentation') {
    if (key === 'workflowId') {
      ui.presentationWorkflow = value;
      ui.presentation = null;
      ui.presentationMission = null;
      ui.presentationDeckId = null;
      ui.presentationDeck = null;
      ui.presentationDeckFailedId = null;
      ui.presentationDeckResults = null;
      ui.presentationDeckQuery = '';
      ui.presentationSlide = 0;
      ui.presentationAudit = null;
      ui.presentationImageDiff = null;
      ui.presentationGraph = null;
      const next = (ui.data.missions || []).find((mission) => mission.workflowId === value);
      if (next) loadPresentation(next.id);
      else render();
      return;
    }
    if (key === 'missionId') {
      loadPresentation(value);
      return;
    }
    if (key === 'focus') {
      ui.presentationFocus = value;
      return;
    }
    if (key === 'deckQuery') {
      ui.presentationDeckQuery = value;
      if (!String(value || '').trim()) {
        ui.presentationDeckResults = null;
        render();
        return;
      }
      const workflowId = ui.presentationWorkflow || '';
      api(`/api/presentations/search?q=${encodeURIComponent(value)}&workflowId=${encodeURIComponent(workflowId)}&limit=20`).then((res) => {
        if (!res.ok) return toast(res.error || 'Deck search failed', 'error');
        ui.presentationDeckResults = res.presentations || [];
        render();
      });
      return;
    }
    if (key === 'deckClass') {
      ui.presentationDeckClass = value;
      render();
      return;
    }
    ui.decisionDraft = { ...(ui.decisionDraft || {}), [key]: value };
    return;
  }
  if (scope === 'presentationnote') {
    ui.presentationNote = value;
    return;
  }
  if (scope === 'presenter') {
    ui.presenterInput = value;
    return;
  }
  if (scope === 'settings') {
    if (!ui.settingsDraft) ui.settingsDraft = { ...ui.data.settings };
    if (key === 'dryRun') ui.settingsDraft.dryRun = value === 'true';
    else if (key === 'agentTickMsSeconds') ui.settingsDraft.agentTickMsSeconds = Number(value);
    else if (el.type === 'checkbox') ui.settingsDraft[key] = Boolean(value);
    else ui.settingsDraft[key] = value;
    return;
  }
  if (scope === 'agent') {
    const body = {};
    if (key === 'intervalMinutes') body.intervalMs = Math.max(1, Number(value)) * 60000;
    else if (key === 'stopOnFailure') body.stopOnFailure = Boolean(value);
    else body[key] = value;
    api(`/api/agents/${encodeURIComponent(el.dataset.id)}`, { method: 'PATCH', body }).then(async (res) => {
      if (!res.ok) return toast(res.error, 'error');
      toast('Agent updated', 'ok');
      await refresh();
    });
    return;
  }
  if (scope === 'mission') {
    updateMissionDraft(el);
    return;
  }
  if (scope === 'auth') {
    ui.authDraft = { ...(ui.authDraft || {}), [key]: value };
    return;
  }
  if (scope === 'command') {
    ui.commandDraft = { ...(ui.commandDraft || {}), [key]: value };
    return;
  }
  if (scope === 'cc-events') {
    ui.missionEventFilter[key] = value;
    render();
    return;
  }
  if (scope === 'cc-sessions') {
    ui.missionSessionFilter[key] = value;
    render();
    return;
  }
  if (scope === 'review') {
    ui.reviewComment = value;
    return;
  }
  if (scope === 'tool') {
    if (!ui.toolDraft) ui.toolDraft = {};
    ui.toolDraft[key] = value;
    return;
  }
  if (scope === 'toolgen') {
    ui.toolgenPrompt = value;
    return;
  }
  if (scope === 'note') {
    if (!ui.noteDraft) ui.noteDraft = {};
    ui.noteDraft[key] = value;
    return;
  }
});

document.addEventListener('input', (event) => {
  const el = event.target;
  const scope = el.dataset.scope;
  if (!scope) return;
  const key = el.dataset.key;
  if (scope === 'linkform') {
    ui.linkForm[key] = el.type === 'number' ? Number(el.value) : el.value;
    return;
  }
  if (scope === 'plan') ui.planGoal = el.value;
  else if (scope === 'missioninput') ui.missionInput = el.value;
  else if (scope === 'chat') ui.chatInput = el.value;
  else if (scope === 'review') ui.reviewComment = el.value;
  else if (scope === 'toolgen') ui.toolgenPrompt = el.value;
  else if (scope === 'note' && ui.noteDraft) ui.noteDraft[key] = el.value;
  else if (scope === 'tool' && ui.toolDraft) ui.toolDraft[key] = el.value;
  else if (scope === 'control') ui.control[key] = el.value;
  else if (scope === 'mission') updateMissionDraft(el);
  else if (scope === 'auth') ui.authDraft = { ...(ui.authDraft || {}), [key]: el.value };
  else if (scope === 'command') ui.commandDraft = { ...(ui.commandDraft || {}), [key]: el.value };
  else if (scope === 'presentationnote') ui.presentationNote = el.value;
  else if (scope === 'presenter') ui.presenterInput = el.value;
  else if (scope === 'companion') ui.companionNote = el.value;
  else if (scope === 'fileappend') ui.fileAppend = el.value;
  else if (scope === 'settings' && ui.settingsDraft) {
    if (key === 'endpoint' || key === 'model' || key === 'baseUrl' || key === 'chatPath') ui.settingsDraft[key] = el.value;
  } else if (scope === 'ambient') {
    ui.ambientNote = el.value;
  } else if (scope === 'pynew' && ui.pyDraft) {
    ui.pyDraft[key] = el.value;
  } else if (scope === 'draft' && ui.draft) {
    if (key === 'name') ui.draft.name = el.value;
    else ui.draft.params = { ...ui.draft.params, [key]: el.value };
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && ui.modal) closeModal();
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    if (event.target.dataset.scope === 'chat') runAction('chat-send', {});
  }
});

window.addEventListener('error', (event) => reportUiError(event.error?.message || event.message || 'script error'));
window.addEventListener('unhandledrejection', (event) => reportUiError(event.reason?.message || String(event.reason || 'unhandled promise rejection')));

/* ------------------------------------------------------------------ boot */
async function boot() {
  ui.captures = [];
  render();
  // A click is only lost when a re-render replaces the button under the pointer, so
  // the poll waits for the pointer and keyboard to go quiet before rebuilding.
  let lastInteractionAt = 0;
  document.addEventListener?.('pointerdown', () => { lastInteractionAt = Date.now(); }, true);
  document.addEventListener?.('keydown', () => { lastInteractionAt = Date.now(); }, true);
  // Optional startup requests must not hold the primary console view hostage.
  loadAuth();
  loadHealth();
  const renderAfterLoad = () => {
    const focused = document.activeElement;
    if (ui.data && !ui.modal && !(focused && /INPUT|TEXTAREA|SELECT/.test(focused.tagName))) render();
  };
  loadCaptures().then(renderAfterLoad);
  loadChat().then(renderAfterLoad);
  const pollState = async () => {
    try {
      const focused = document.activeElement;
      const typing = focused && /INPUT|TEXTAREA|SELECT/.test(focused.tagName);
      // Every refresh rebuilds the view, so a poll that lands between mousedown and
      // click swallows the click. Give the pointer and keyboard a moment first; this
      // is why buttons used to work only some of the time.
      const interacting = Date.now() - lastInteractionAt < 700;
      if (!ui.modal && !typing && !interacting) {
        await refresh();
      }
    } catch (err) {
      console.error('State refresh failed:', err);
    } finally {
      // Schedule only after the previous refresh settles, even on failure.
      const counts = ui.data?.counts || {};
      const busy = Number(counts.activeRuns || 0) + Number(counts.missionsActive || 0);
      const delay = document.hidden ? 8000 : busy ? 500 : 2000;
      setTimeout(pollState, delay);
    }
  };
  pollState();
  setInterval(loadHealth, 60000);
  setInterval(async () => {
    if (!ui.data?.live?.running) return;
    const card = document.getElementById('live-watch-card');
    if (!card) return;
    const res = await api('/api/live/monitor');
    if (!res.ok || !res.monitor) return;
    ui.data.live = res.monitor;
    ui.data.liveSuggestions = (res.monitor.events || [])[0]?.suggestions || [];
    const fresh = document.getElementById('live-watch-card');
    if (fresh) fresh.outerHTML = renderLiveWatch();
  }, 1500);
}

boot();

SYNC_CHANNEL?.addEventListener('message', (event) => {
  if (!event.data || event.data.tab === TAB_ID || event.data.type !== 'state') return;
  const focused = document.activeElement;
  if (focused && /INPUT|TEXTAREA|SELECT/.test(focused.tagName)) return;
  refresh({ fromSync: true });
});

window.addEventListener('storage', (event) => {
  if (event.key !== 'sightline-state-sync' || !event.newValue) return;
  try {
    const message = JSON.parse(event.newValue);
    if (message.tab !== TAB_ID) refresh({ fromSync: true });
  } catch {}
});
