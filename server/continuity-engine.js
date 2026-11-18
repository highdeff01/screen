import fs from 'node:fs';
import path from 'node:path';
import { db, persist, uid, now, logActivity, ROOT, DATA } from './store.js';
import { executeStep, inspectWindowState, captureScreenSignature } from './automation.js';
import { diffSignatures } from './visual.js';
import { inferRequestText, workflowGoal } from './planner.js';
import { chat, listModels, parseJsonLoose } from './llm.js';
import { findRecoveryPack } from './run-recovery.js';

const MAX_VERDICTS = 50;
const MAX_SUGGESTIONS = 30;
const MAX_CONTINUATIONS = 30;
const MAX_EVENTS = 80;
const MAX_CHECKS = 30;
let captureInFlight = false;

function clip(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function norm(value) {
  return clip(value, 1000).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function emptyState() {
  return {
    version: 1,
    lastTickAt: null,
    scans: 0,
    active: null,
    window: null,
    frame: null,
    lastCaptureAt: null,
    frameSignature: null,
    frameHistory: [],
    verdicts: [],
    suggestions: [],
    continuations: [],
    events: [],
  };
}

export function ensureContinuity() {
  const d = db();
  const base = emptyState();
  if (!d.continuity || typeof d.continuity !== 'object') d.continuity = base;
  for (const key of ['verdicts', 'suggestions', 'continuations', 'events']) {
    if (!Array.isArray(d.continuity[key])) d.continuity[key] = [];
  }
  if (!Array.isArray(d.continuity.frameHistory)) d.continuity.frameHistory = [];
  d.continuity.version = 1;
  if (!Number.isFinite(Number(d.continuity.scans))) d.continuity.scans = 0;
  d.continuity.verdicts = d.continuity.verdicts.slice(0, MAX_VERDICTS);
  d.continuity.suggestions = d.continuity.suggestions.slice(0, MAX_SUGGESTIONS);
  const seenRuns = new Set();
  d.continuity.continuations = [...d.continuity.continuations]
    .sort((a, b) => String(b.updatedAt || b.at || '').localeCompare(String(a.updatedAt || a.at || '')))
    .filter((entry) => {
      const key = entry.runId || entry.id;
      if (!key || seenRuns.has(key)) return false;
      seenRuns.add(key);
      return true;
    })
    .slice(0, MAX_CONTINUATIONS);
  d.continuity.events = d.continuity.events.slice(0, MAX_EVENTS);
  return d.continuity;
}

function event(kind, message, extra = {}) {
  const state = ensureContinuity();
  state.events.unshift({ id: uid('cev'), at: now(), kind, message: clip(message, 400), ...extra });
  state.events = state.events.slice(0, MAX_EVENTS);
}

function rememberFrame(file) {
  if (!file) return;
  const state = ensureContinuity();
  const relative = String(file).split(path.sep).join('/');
  state.frameHistory = [relative, ...state.frameHistory.filter((entry) => entry !== relative)].slice(0, 8);
  for (const stale of state.frameHistory.slice(6)) {
    const absolute = resolveContinuityFramePath(stale);
    if (!absolute) continue;
    const inside = path.relative(DATA, absolute);
    if (inside.startsWith('..') || path.isAbsolute(inside)) continue;
    try {
      fs.unlinkSync(absolute);
    } catch {}
  }
}

function enabled() {
  const settings = db().settings || {};
  return settings.continuityEnabled !== false;
}

function findWorkflow(run) {
  return (db().workflows || []).find((workflow) => workflow.id === run?.workflowId) || null;
}

function findRun(id) {
  return (db().runs || []).find((run) => run.id === id) || null;
}

function stepById(workflow, id) {
  return (workflow?.steps || []).find((step) => step.id === id) || null;
}

function check(key, label, status, detail, evidence = null) {
  return { key, label, status, detail: clip(detail, 700), evidence };
}

const readinessInFlight = new Set();
const READINESS_TTL_MS = 30000;

/**
 * Verdicts are per run, per step, per awaited params. The frame is deliberately
 * not in the key: every capture has a new path, which would defeat the cache
 * and restart a check on every tick.
 */
export function readinessCacheKey({ runId = '', step = null } = {}) {
  let params = '';
  try {
    params = JSON.stringify(step?.params || {});
  } catch {
    params = '';
  }
  return `${runId}|${step?.id || ''}|${params}`;
}

function latestEvidence(run) {
  const evidence = Array.isArray(run?.evidence) ? run.evidence : [];
  return [...evidence].reverse().find((item) => item?.kind === 'screenshot' && item.path) || null;
}

/** Resolve an evidence path recorded relative to data/ (falling back to the project root). */
export function resolveContinuityFramePath(framePath) {
  if (!framePath) return null;
  const candidates = path.isAbsolute(framePath)
    ? [framePath]
    : [path.join(DATA, framePath), path.join(ROOT, framePath)];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/** One desktop frame per shared interval, and only while a run is waiting. */
export function shouldCaptureFrame({ state = null, settings = {}, waiting = false, capture = true, at = Date.now() } = {}) {
  if (!capture || !waiting || settings.continuityFrameWatch === false) return false;
  const gap = Math.max(1000, num(settings.continuityFrameMs, 5000));
  const last = Date.parse(state?.lastCaptureAt || state?.frame?.at || 0) || 0;
  return at - last >= gap;
}

export function parseReadiness(reply) {
  const parsed = parseJsonLoose(typeof reply === 'string' ? reply : reply?.content) || {};
  const confidence = Number(parsed.confidence);
  return {
    ready: parsed.ready === true ? true : parsed.ready === false ? false : null,
    evidence: clip(parsed.evidence, 300),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
  };
}

/**
 * Ask the model whether a waiting condition is visible in a frame.
 * Only a confident `true` may advance a run; anything else stays visible as inspect.
 */
export async function visionReadiness({ step, image = null, ask = null, minConfidence = 0.6 } = {}) {
  const condition = [step?.name, step?.params?.kind, step?.params?.value].filter(Boolean).join(' · ');
  if (!condition) return { ready: null, evidence: 'no condition to check', confidence: 0 };
  const call = ask || chat;
  const reply = await call(
    [
      {
        role: 'system',
        content:
          'You check whether a waiting condition is visible in a screenshot. Answer JSON only: {"ready":true|false|null,"evidence":"what in the image proves it","confidence":0.0}. Use null when the image cannot show it.',
      },
      { role: 'user', content: `Condition: ${condition}` },
    ],
    { format: 'json', kind: 'continuity-readiness', timeoutMs: 30000, maxTokens: 200, images: image ? [image] : [] }
  );
  const result = parseReadiness(reply?.content ?? reply);
  return result.ready === true && result.confidence < minConfidence
    ? { ...result, ready: null, evidence: `low confidence (${result.confidence}): ${result.evidence}` }
    : result;
}

function readinessOf(step, triggers = []) {
  if (!step) return 'none';
  if (step.type === 'wait') return 'duration';
  const own = triggers.find((entry) => entry.stepId === step.id);
  if (!own || typeof own.ready !== 'boolean') return 'unknown';
  return own.ready ? 'ready' : 'not_ready';
}

/** The active step owns the trigger; an earlier passed trigger must not advance a later wait. */
export function continuationDecision({
  waiting = false,
  step = null,
  triggers = [],
  blocking = 0,
  frameMoved = false,
  windowState = null,
  status = 'review',
  waitedMs = null,
  knownReady = null,
} = {}) {
  if (!waiting) return status === 'needs_fix' ? 'inspect' : 'observe';
  if (windowState && ['closed', 'hidden'].includes(windowState.state)) return 'hold';
  if (blocking) return 'inspect';
  const own = triggers.find((entry) => entry.stepId === step?.id);
  const known = own && typeof own.ready === 'boolean';
  const elapsed = Number.isFinite(waitedMs) ? waitedMs : null;
  if (step?.type === 'wait') {
    // A fixed wait ends when its own duration elapses. Waiting for frame
    // movement is only a hint: a static screen would hold it open forever.
    const budget = num(step.params?.ms, 0);
    if (elapsed != null && budget && elapsed >= budget) return 'advance';
    return frameMoved ? 'advance' : 'wait';
  }
  // A confident model check is evidence the trigger cannot produce itself.
  if (knownReady === true) return 'advance';
  // Readiness we cannot observe (file, clipboard, process) is never satisfied by
  // pixels changing: surface it for review instead of waiting on a static screen.
  if (!known) return 'inspect';
  const timeout = num(own.timeoutMs ?? step?.params?.timeoutMs, 0);
  if (own.ready !== true && elapsed != null && timeout && elapsed >= timeout) return 'inspect';
  return own.ready === true ? 'advance' : 'wait';
}

function targetFor({ run, workflow, step } = {}) {
  const presenter = db().presenter || {};
  const app = presenter.app || {};
  const p = step?.params || {};
  const target = workflow?.target || {};
  const workflowApp = (workflow?.steps || []).find((entry) => ['launchApp', 'focusWindow', 'waitFor'].includes(entry.type)) || null;
  const wp = workflowApp?.params || {};
  const hint = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const base = path.basename(raw).replace(/\.exe$/i, '').trim();
    return base && base !== raw ? base : raw;
  };
  const workflowTitle = hint(wp.window || wp.title || (workflowApp?.type === 'waitFor' && wp.kind === 'window' ? wp.value : '') || wp.target || wp.app || '');
  const workflowProcess = hint(wp.process || wp.app || wp.target || '');
  const title = clip(p.window || p.title || target.title || workflowTitle || app.title || app.name || app.target || '', 160);
  const processName = clip(p.process || p.app || target.process || workflowProcess || app.process || app.name || app.target || '', 120);
  return {
    title,
    process: processName,
  };
}

function inferredTargetFromWorkflow(workflow) {
  const raw = workflowGoal(workflow);
  const quoted = raw.match(/\b(?:open|launch|start|use)\s+(?:the\s+)?["“']([^"”']+)["”']/i);
  if (quoted) return { title: quoted[1].trim(), process: '' };
  const plain = raw.match(/\b(?:open|launch|start|use)\s+(?:the\s+)?([a-z][\w .+#-]{1,36}?)(?=\s+(?:and|then|than|to|for|with)\b|[,.;]|$)/i);
  return plain ? { title: plain[1].trim(), process: plain[1].trim() } : { title: '', process: '' };
}

function recentSameFailures(run, workflow) {
  const signature = run?.failureSignature || run?.error || '';
  return (db().runs || [])
    .filter((entry) => entry.id !== run?.id && entry.workflowId === (workflow?.id || run?.workflowId))
    .filter((entry) => entry.status === 'failed')
    .filter((entry) => {
      if (signature) return entry.failureSignature === signature || norm(entry.error) === norm(signature);
      return true;
    })
    .slice(0, 3);
}

export function windowReason(windowState, { run = null, workflow = null } = {}) {
  const state = windowState?.state || 'unknown';
  const foreground = windowState?.foreground
    ? `${windowState.foreground.process || 'app'}${windowState.foreground.title ? ` — ${windowState.foreground.title}` : ''}`
    : 'another window';
  const prior = recentSameFailures(run, workflow);
  const history = prior.length
    ? ` This failed ${prior.length} time(s) before with the same signature.`
    : '';
  if (state === 'foreground') return `The target window has focus.${history}`;
  if (state === 'background') {
    return `The target is running but ${foreground} has focus. Focus the existing window; relaunching would create a second instance.${history}`;
  }
  if (state === 'minimized') {
    return `The target exists but is minimized. Restore the existing window before retrying; a relaunch is unnecessary.${history}`;
  }
  if (state === 'hidden') {
    return `The process is running without a visible window (tray or background start). Try restore/hotkey first; relaunch only if no window appears.${history}`;
  }
  if (state === 'closed') {
    return `No matching window or process was found. The app was probably closed or crashed; open it before replaying the workflow.${history}`;
  }
  return 'Window state could not be read. Verify the target manually before continuing.';
}

function urlChecks(step, goal, checks) {
  const p = step?.params || {};
  const raw = p.urlVar ? '' : String(p.url || '').trim();
  if (!raw) return;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    checks.push(check(`link:${step.id}`, 'Link is a valid URL', 'fail', `“${clip(raw, 180)}” is not an absolute URL.`, { stepId: step.id }));
    return;
  }
  const problem = [];
  if (!['http:', 'https:'].includes(parsed.protocol)) problem.push(`unsupported protocol ${parsed.protocol}`);
  if (/(^|\.)example\.(com|org|net)$/i.test(parsed.hostname) && !/example\.(com|org|net)/i.test(goal)) {
    problem.push('placeholder domain');
  }
  if (!parsed.hostname.includes('.')) problem.push('host has no public suffix');
  checks.push(
    check(
      `link:${step.id}`,
      'Link is a usable destination',
      problem.length ? 'fail' : 'pass',
      problem.length ? `${parsed.href} — ${problem.join(', ')}` : parsed.href,
      { stepId: step.id }
    )
  );
  const docs = (db().memory?.docs || []).map((doc) => `${doc.title || ''} ${doc.text || ''} ${doc.url || ''}`).join(' ');
  if (docs && !docs.toLowerCase().includes(parsed.hostname.toLowerCase())) {
    checks.push(
      check(
        `link-research:${step.id}`,
        'Link is corroborated by research',
        'warn',
        `Research memory has no reference to ${parsed.hostname}; verify the destination before a live run.`,
        { stepId: step.id }
      )
    );
  }
}

function coordinateCheck(step, checks) {
  const p = step?.params || {};
  const x = num(p.x, NaN);
  const y = num(p.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    checks.push(check(`coord:${step.id}`, 'Coordinate is present', 'fail', 'Coordinate step has no numeric x/y.', { stepId: step.id }));
    return;
  }
  const screen = db().presenter?.screen || {};
  const width = num(screen.width, 0);
  const height = num(screen.height, 0);
  if (width > 0 && height > 0 && (x < 0 || y < 0 || x >= width || y >= height)) {
    checks.push(
      check(`coord:${step.id}`, 'Coordinate is on screen', 'fail', `${x},${y} is outside ${width}×${height}.`, { stepId: step.id })
    );
  }
  const label = String(step.name || '')
    .replace(/^(click|press|tap|move pointer to|move to)\s+/i, '')
    .replace(/\s+(button|link|field|box|icon)$/i, '')
    .trim();
  const memory = (db().positionMemory || []).filter((entry) => {
    if (!entry.normalized || !width || !height) return false;
    const nx = x / width;
    const ny = y / height;
    return Math.hypot(entry.normalized.x - nx, entry.normalized.y - ny) < 0.08;
  });
  if (!memory.length) {
    checks.push(
      check(
        `coord-memory:${step.id}`,
        'Coordinate has a learned fallback',
        'warn',
        `No nearby learned position for ${x},${y}; drift would have no safe fallback.`,
        { stepId: step.id }
      )
    );
  }
  const usefulLabel = label && label.length >= 3 && label.length <= 60 && !/^\d+$/.test(label);
  checks.push(
    check(
      `coord-fallback:${step.id}`,
      'Coordinate has an element fallback',
      usefulLabel || memory.length ? 'pass' : 'warn',
      usefulLabel
        ? `Can retry by element name “${label}” instead of repeating the pixel.`
        : memory.length
          ? `${memory.length} similar learned position(s) can anchor the retry.`
          : 'Add a readable control name or verify the target with AI vision before retrying.',
      { stepId: step.id, label, nearby: memory.slice(0, 2).map((entry) => ({ x: entry.x, y: entry.y, ok: entry.ok })) }
    )
  );
}

function genericInputText(value) {
  const text = norm(value);
  if (!text) return true;
  return (
    /^(?:the|a|an)?\s*(?:question|answer|text|message|prompt|input|request|content|details?|same|above)\b/.test(text) ||
    /\bwhen it is not already present\b/.test(text) ||
    /\b(?:only if|if needed|as needed)\b/.test(text)
  );
}

function desiredInputText(run, workflow, currentText = '') {
  const goal = workflowGoal(workflow, run);
  const current = norm(currentText);
  if (current.length >= 5 && norm(goal).includes(current)) return null;
  const fromGoal = inferRequestText(goal);
  if (fromGoal && !genericInputText(fromGoal)) return { text: fromGoal, source: 'goal' };
  const summaries = db().memory?.conversation?.summaries || [];
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    const found = inferRequestText(summaries[index]?.text || '');
    if (found && !genericInputText(found)) return { text: found, source: 'conversation' };
  }
  return null;
}

function patchForInput(step, desired, source) {
  if (!desired?.text || !step?.params?.text || step.params.textVar) return null;
  if (norm(step.params.text) === norm(desired.text)) return null;
  const current = String(step.params.text || '');
  const conversational = /\b(ask|question|prompt|message|reply|answer|chat)\b/i.test(String(step.name || '')) || current.includes('?');
  if (!conversational) return null;
  return {
    key: `text:${step.id}`,
    kind: 'text-update',
    title: 'Use the current wording',
    detail: `Step “${step.name}” still types “${clip(step.params.text, 160)}”, but the ${source} now says “${clip(desired.text, 220)}”. Keep the reply on topic instead of replaying stale copy.`,
    stepId: step.id,
    proposedText: desired.text,
    safe: true,
  };
}

function changeFromPatch(patch, workflow) {
  if (patch.kind === 'text-update') {
    return workflow.steps.map((step) =>
      step.id === patch.stepId && step.type === 'type' ? { ...step, params: { ...step.params, text: patch.proposedText } } : step
    );
  }
  return null;
}

export function analyzeContinuity({ run = null, workflow = null, windowState = null, frame = null } = {}) {
  const wf = workflow || findWorkflow(run);
  const goal = workflowGoal(wf, run);
  const checks = [];
  const patches = [];
  const triggers = [];
  const steps = wf?.steps || run?.steps || [];
  const presenter = db().presenter || {};

  if (!wf) checks.push(check('workflow', 'Workflow is available', 'fail', 'No workflow was found for this run.'));
  if (run?.dryRun) checks.push(check('mode', 'Run mode', 'warn', 'This was a dry run; practical screen behaviour was simulated.'));
  if (windowState?.state && !['foreground', 'unknown'].includes(windowState.state)) {
    checks.push(
      check(
        'window',
        'Target window is ready',
        windowState.state === 'background' || windowState.state === 'minimized' ? 'warn' : 'fail',
        windowReason(windowState, { run, workflow: wf })
      )
    );
  }

  let focusSeen = false;
  let postOpen = false;
  let desired = null;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const p = step.params || {};
    if (step.type === 'focusWindow' || (step.type === 'expect' && p.kind === 'foreground')) focusSeen = true;
    if (['launchApp', 'openUrl'].includes(step.type)) postOpen = true;
    if (['wait', 'waitFor', 'expect'].includes(step.type)) postOpen = false;
    if (['type', 'key', 'clipboard', 'clickElement'].includes(step.type) && postOpen) {
      checks.push(
        check(
          `post-open:${step.id}`,
          'Input waits for readiness',
          'warn',
          `“${step.name}” runs immediately after ${steps[index - 1]?.name || 'an open step'}; add a waitFor/focus guard so it does not type into the wrong window.`,
          { stepId: step.id }
        )
      );
    }
    if (step.type === 'type' && !focusSeen) {
      checks.push(
        check(
          `focus:${step.id}`,
          'Typing has a focus guard',
          'warn',
          `No focusWindow/foreground check precedes “${step.name}”.`,
          { stepId: step.id }
        )
      );
    }
    if (step.type === 'type') {
      if (!desired) desired = desiredInputText(run, wf, step.params?.text || '');
      const patch = patchForInput(step, desired, desired?.source || 'goal');
      if (patch) {
        patches.push(patch);
        checks.push(check(`text:${step.id}`, 'Input wording is current', 'warn', patch.detail, { stepId: step.id, proposedText: patch.proposedText }));
      }
    }
    if (step.type === 'openUrl') urlChecks(step, goal, checks);
    if (['click', 'doubleClick', 'rightClick', 'move'].includes(step.type)) coordinateCheck(step, checks);
    if (step.type === 'writeTextFile') {
      const safeOverwrite = p.overwrite === false || p.overwrite === 'false';
      checks.push(
        check(
          `overwrite:${step.id}`,
          'File write will not overwrite silently',
          safeOverwrite ? 'pass' : 'warn',
          safeOverwrite ? `${p.filename || p.path || 'file'} uses overwrite:false.` : `${p.filename || p.path || 'file'} may overwrite an existing file.`,
          { stepId: step.id }
        )
      );
    }
    if (step.type === 'wait') {
      const ms = num(p.ms, 0);
      const hasFrame = Boolean(steps[index + 1] && ['screenshot', 'verifyScreen', 'expect', 'aiExtract'].includes(steps[index + 1].type));
      if (ms >= 4000 && !hasFrame) {
        checks.push(
          check(
            `blind-wait:${step.id}`,
            'Long wait is frame-checked',
            'warn',
            `${ms} ms blind wait has no following frame/verification; continuity sampling will capture it instead of assuming the wait succeeded.`,
            { stepId: step.id }
          )
        );
      }
    }
    if (step.type === 'waitFor' || step.type === 'expect') {
      triggers.push({
        stepId: step.id,
        stepName: step.name,
        kind: p.kind || 'window',
        value: p.value || '',
        mode: p.mode || 'present',
        timeoutMs: num(p.timeoutMs, 30000),
      });
      if (p.kind === 'window' && p.value) {
        const target = { title: p.value, process: '' };
        const match = windowState?.matches?.find((entry) =>
          norm(entry.title).includes(norm(target.title)) || norm(entry.process) === norm(target.title)
        );
        triggers[triggers.length - 1].ready = windowState ? Boolean(match) : null;
        triggers[triggers.length - 1].observed = match || null;
      }
    }
  }

  const evidence = Array.isArray(run?.evidence) ? run.evidence : [];
  const screenshotEvidence = evidence.filter((item) => item?.kind === 'screenshot');
  if (run?.status === 'passed') {
    checks.push(
      check(
        'response',
        'Response has practical evidence',
        screenshotEvidence.length || evidence.length ? 'pass' : 'warn',
        evidence.length
          ? `${evidence.length} evidence item(s), ${screenshotEvidence.length} screenshot(s).`
          : 'The run passed without screenshots or verification evidence.'
      )
    );
    if (!steps.some((step) => ['expect', 'verifyScreen', 'aiExtract'].includes(step.type))) {
      checks.push(check('verify', 'Outcome was verified', 'warn', 'No expectation, screen verification, or AI extraction step proves the response appeared.'));
    }
  }
  if (run?.status === 'failed') {
    const failed = (run.steps || []).find((step) => step.status === 'failed');
    checks.push(
      check(
        'failure',
        'Failure has a recovery path',
        wf?.steps?.length ? 'warn' : 'fail',
        failed ? `“${failed.name}” failed: ${clip(failed.error || run.error || 'unknown error', 280)}` : clip(run.error || 'Run failed.', 280),
        { stepId: failed?.id || null }
      )
    );
  }

  if (frame) {
    const frameCheck = check(
      'frame',
      'Latest frame is available',
      frame.path ? 'pass' : 'warn',
      frame.path ? `${frame.path}${frame.changedPct != null ? ` · ${Math.round(frame.changedPct * 100)}% changed` : ''}` : 'No frame could be captured.',
      frame
    );
    checks.push(frameCheck);
  }

  const failedCount = checks.filter((item) => item.status === 'fail').length;
  const warnCount = checks.filter((item) => item.status === 'warn').length;
  const score = Math.max(0, Math.min(100, 100 - failedCount * 28 - warnCount * 7));
  const status = failedCount ? 'needs_fix' : warnCount ? 'review' : 'ready';
  const changes = patches.map((patch) => ({ ...patch }));
  let proposedSteps = null;
  for (const patch of patches) {
    const next = changeFromPatch(patch, wf || { steps });
    if (next) proposedSteps = next;
  }
  const suggestedWorkflow = proposedSteps
    ? {
        id: uid('csw'),
        name: `Suggested: ${clip(wf?.name || run?.workflowName || 'Continue run', 90)}`,
        description: `${clip(goal, 500)} — continuity revised inputs: ${patches.map((patch) => patch.title).join('; ')}`,
        steps: proposedSteps,
        changes: patches,
        sourceRunId: run?.id || null,
      }
    : null;

  const continuation = {
    ready: Boolean(
      wf?.steps?.length &&
        ['failed', 'needs_review', 'partial', 'waiting'].includes(run?.status || '') &&
        !['closed', 'hidden'].includes(windowState?.state || 'unknown')
    ),
    blockedReason:
      windowState?.state === 'closed'
        ? 'Open the application, then continue.'
        : windowState?.state === 'hidden'
          ? 'Restore a visible window before continuing.'
          : wf?.steps?.length
            ? ''
            : 'No workflow steps to continue.',
    reason:
      status === 'ready'
        ? 'Checks agree the current workflow can continue.'
        : `Continuity found ${failedCount} blocking and ${warnCount} review item(s).`,
    suggestedWorkflow: Boolean(suggestedWorkflow),
  };

  return {
    at: now(),
    runId: run?.id || null,
    workflowId: wf?.id || null,
    status,
    score,
    checks: checks.slice(0, MAX_CHECKS),
    triggers: triggers.slice(0, 12),
    continuation,
    suggestedWorkflow,
    patches,
    window: windowState,
    frame,
    summary:
      status === 'ready'
        ? 'Response path, triggers, links, coordinates, and current wording are consistent.'
        : `${failedCount} blocking · ${warnCount} review. ${windowState?.state ? windowReason(windowState, { run, workflow: wf }) : ''}`,
  };
}

function pushSuggestion(suggestedWorkflow, review) {
  if (!suggestedWorkflow) return null;
  const state = ensureContinuity();
  const existing = state.suggestions.find((entry) => entry.sourceRunId === suggestedWorkflow.sourceRunId && entry.status === 'open');
  const row = {
    id: existing?.id || uid('csug'),
    at: now(),
    sourceRunId: suggestedWorkflow.sourceRunId,
    workflowId: review.workflowId,
    title: suggestedWorkflow.name,
    detail: suggestedWorkflow.description,
    changes: suggestedWorkflow.changes,
    steps: suggestedWorkflow.steps,
    status: 'open',
    preparedWorkflowId: existing?.preparedWorkflowId || null,
  };
  if (existing) Object.assign(existing, row);
  else state.suggestions.unshift(row);
  state.suggestions = state.suggestions.slice(0, MAX_SUGGESTIONS);
  return row;
}

async function captureFrame({ run, workflow, live = true, signature = true } = {}) {
  if (!live) {
    return { path: null, simulated: true, at: now(), runId: run?.id || null, note: 'Dry run: no desktop frame captured.' };
  }
  let delta = null;
  if (signature) {
    try {
      const before = ensureContinuity().frameSignature || null;
      const next = await captureScreenSignature();
      if (before && next) delta = diffSignatures(before, next);
      if (next) ensureContinuity().frameSignature = next;
    } catch {}
  }
  try {
    const step = {
      id: uid('frame'),
      type: 'screenshot',
      name: 'Continuity frame',
      params: { caption: 'Continuity verifier frame' },
      timeoutMs: 20000,
    };
    const result = await executeStep(step, {
      live: true,
      runId: run?.id || null,
      run: run || { id: 'continuity' },
      workflow: workflow || null,
      stage: 'continuity',
      variables: run?.variables || {},
    });
    const evidence = (result?.evidence || []).find((item) => item?.kind === 'screenshot') || null;
    if (evidence?.path) {
      rememberFrame(evidence.path);
      return {
        path: evidence.path,
        runId: run?.id || null,
        at: now(),
        changedPct: delta?.changedPct ?? null,
        changedCells: delta?.changedCells ?? null,
        identical: delta?.identical ?? null,
      };
    }
  } catch (err) {
    return { path: null, at: now(), runId: run?.id || null, error: clip(err.message, 300) };
  }
  return { path: null, at: now(), runId: run?.id || null };
}

export async function reviewRunContinuity(run, { capture = false, inspectWindow = true } = {}) {
  if (!run) return null;
  const workflow = findWorkflow(run);
  const step = stepById(workflow, run.currentStepId) || (run.steps || []).find((entry) => entry.status === 'running') || null;
  const target = targetFor({ run, workflow, step });
  const fallbackTarget = target.title || target.process ? target : inferredTargetFromWorkflow(workflow);
  let windowState = null;
  if (inspectWindow && !run.dryRun && (fallbackTarget.title || fallbackTarget.process)) {
    try {
      windowState = await inspectWindowState(fallbackTarget);
    } catch (err) {
      windowState = { state: 'unknown', error: clip(err.message, 200), ...fallbackTarget };
    }
  }
  let frame = latestEvidence(run);
  if (capture && !frame) frame = await captureFrame({ run, workflow, live: !run.dryRun });
  const review = analyzeContinuity({ run, workflow, windowState, frame });
  const state = ensureContinuity();
  state.scans += 1;
  state.lastTickAt = now();
  state.window = windowState;
  state.frame = frame || state.frame;
  state.verdicts.unshift(review);
  state.verdicts = state.verdicts.slice(0, MAX_VERDICTS);
  const suggestion = pushSuggestion(review.suggestedWorkflow, review);
  if (!suggestion) {
    for (const entry of state.suggestions) {
      if (entry.sourceRunId === run.id && entry.status === 'open') {
        entry.status = 'dismissed';
        entry.dismissedAt = now();
        entry.detail = `${entry.detail} · superseded by a cleaner review`;
      }
    }
  }
  const continuation = {
    id: uid('ccont'),
    at: now(),
    runId: run.id,
    workflowId: workflow?.id || null,
    runStatus: run.status,
    status: review.continuation.ready ? 'ready' : 'blocked',
    ready: review.continuation.ready,
    reason: review.continuation.reason,
    blockedReason: review.continuation.blockedReason,
    suggestedWorkflowId: suggestion?.id || null,
  };
  state.continuations = [continuation, ...state.continuations.filter((entry) => entry.runId !== run.id)].slice(0, MAX_CONTINUATIONS);
  event(
    'review',
    `${run.workflowName || workflow?.name || 'Run'} · ${review.status} · ${review.score}%${windowState?.state ? ` · ${windowState.state}` : ''}`,
    { runId: run.id, score: review.score, status: review.status }
  );
  run.continuity = {
    at: review.at,
    status: review.status,
    score: review.score,
    window: windowState?.state || null,
    continuation: review.continuation,
    ...(workflow ? {} : { note: 'No workflow is linked to this run; reviewed once and marked stale.' }),
  };
  if (state.active?.runId === run.id) state.active = null;
  persist();
  if (
    db().settings?.continuityAiReview === true &&
    !run.dryRun &&
    ['failed', 'needs_review'].includes(run.status) &&
    !run.continuityAiReviewAt
  ) {
    run.continuityAiReviewAt = now();
    persist();
    setTimeout(() => {
      aiReviewContinuity(run.id).catch((err) => event('ai', `Automatic AI review failed: ${err.message}`, { runId: run.id }));
    }, 50).unref?.();
  }
  return { ...review, suggestion };
}

export async function tickContinuity({ capture = true, readinessAsk = null } = {}) {
  if (!enabled()) return { ok: false, disabled: true };
  const state = ensureContinuity();
  const settings = db().settings || {};
  const runs = (db().runs || []).filter((run) => !run.shadow);
  const activeRuns = runs.filter((run) => ['running', 'queued'].includes(run.status));
  const waitingStep = (run) => {
    const workflow = findWorkflow(run);
    const step = stepById(workflow, run.currentStepId) || (run.steps || []).find((entry) => entry.status === 'running') || null;
    return ['wait', 'waitFor', 'expect'].includes(step?.type) ? step : null;
  };
  const active =
    activeRuns.find((run) => waitingStep(run)) ||
    [...activeRuns].sort((a, b) => String(b.startedAt || b.createdAt || '').localeCompare(String(a.startedAt || a.createdAt || '')))[0] ||
    null;
  if (active) {
    const workflow = findWorkflow(active);
    const step = stepById(workflow, active.currentStepId) || (active.steps || []).find((entry) => entry.status === 'running') || null;
    const target = targetFor({ run: active, workflow, step }) || {};
    const fallbackTarget = target.title || target.process ? target : inferredTargetFromWorkflow(workflow);
    const waiting = Boolean(step && ['wait', 'waitFor', 'expect'].includes(step.type));
    const runningStep = (active.steps || []).find((entry) => entry.status === 'running') || step;
    const startedMs = Date.parse(runningStep?.startedAt || step?.startedAt || '');
    const waitedMs = Number.isFinite(startedMs) ? Date.now() - startedMs : null;
    let windowState = null;
    if (!active.dryRun && (fallbackTarget.title || fallbackTarget.process)) {
      try {
        windowState = await inspectWindowState(fallbackTarget);
      } catch (err) {
        windowState = { state: 'unknown', error: clip(err.message, 200), ...fallbackTarget };
      }
    }
    let frame = state.frame?.runId === active.id ? state.frame : latestEvidence(active);
    if (!active.dryRun && shouldCaptureFrame({ state, settings, waiting, capture }) && !captureInFlight) {
      captureInFlight = true;
      state.lastCaptureAt = now();
      try {
        frame = await captureFrame({ run: active, workflow, live: true });
      } finally {
        captureInFlight = false;
      }
    }
    const review = analyzeContinuity({ run: active, workflow, windowState, frame });
    const blocking = review.checks.filter((entry) => entry.status === 'fail').length;
    const frameMoved = frame?.changedPct != null && frame.changedPct > 0.02;
    let readiness = readinessOf(step, review.triggers);
    let readinessNote = '';
    if (readiness === 'unknown' && settings.continuityVisionReadiness === true && frame?.path) {
      // A file/clipboard trigger cannot be observed, but the screen can sometimes
      // answer it. The model runs off the tick: this read uses the last verdict and
      // a slow reply only lands on a later tick.
      const key = readinessCacheKey({ runId: active.id, step });
      const cached = state.readinessCache?.[key];
      const age = cached ? Date.now() - Date.parse(cached.at || 0) : Infinity;
      if (cached && age < READINESS_TTL_MS) {
        readiness = cached.readiness;
        readinessNote = cached.evidence || '';
      } else if (!readinessInFlight.has(key)) {
        const abs = resolveContinuityFramePath(frame.path);
        if (abs) {
          readinessInFlight.add(key);
          visionReadiness({
            step,
            image: fs.readFileSync(abs).toString('base64'),
            ask: readinessAsk || undefined,
          })
            .then((verdict) => {
              const live = ensureContinuity();
              const cache = { ...(live.readinessCache || {}) };
              cache[key] = {
                at: now(),
                readiness:
                  verdict.ready === true ? 'model_ready' : verdict.ready === false ? 'model_not_ready' : 'unknown',
                evidence: verdict.evidence || '',
                confidence: verdict.confidence,
              };
              live.readinessCache = Object.fromEntries(Object.entries(cache).slice(-40));
              persist();
            })
            .catch((err) => event('continuity', `Readiness check failed: ${clip(err.message, 160)}`))
            .finally(() => readinessInFlight.delete(key));
        }
      }
    }
    state.active = {
      at: now(),
      runId: active.id,
      workflowId: workflow?.id || null,
      workflowName: workflow?.name || active.workflowName,
      stepId: step?.id || null,
      stepName: step?.name || '',
      waiting,
      window: windowState,
      frame,
      status: review.status,
      score: review.score,
      checks: review.checks,
      triggers: review.triggers,
      readiness,
      readinessNote,
      waitedMs,
      decision: continuationDecision({
        waiting,
        step,
        triggers: review.triggers,
        blocking,
        frameMoved,
        windowState,
        status: review.status,
        waitedMs,
        knownReady: readiness === 'model_ready' ? true : null,
      }),
    };
    state.window = windowState;
    if (frame?.path) state.frame = frame;
    state.scans += 1;
    state.lastTickAt = now();
    state.verdicts.unshift(review);
    state.verdicts = state.verdicts.slice(0, MAX_VERDICTS);
    if (review.continuation.ready && waiting) {
      state.continuations = [
        {
          id: uid('ccont'),
          at: now(),
          runId: active.id,
          workflowId: workflow?.id || null,
          runStatus: active.status,
          status: 'ready',
          ready: true,
          reason: review.continuation.reason,
          blockedReason: review.continuation.blockedReason,
          suggestedWorkflowId: null,
        },
        ...state.continuations.filter((entry) => entry.runId !== active.id),
      ].slice(0, MAX_CONTINUATIONS);
    }
    persist();
    return { ok: true, active: state.active, review };
  }

  const latest = runs.find((run) => ['failed', 'needs_review'].includes(run.status) && !run.continuity);
  if (latest) {
    state.active = null;
    return { ok: true, review: await reviewRunContinuity(latest, { capture: false }) };
  }
  state.active = null;
  state.lastTickAt = now();
  persist();
  return { ok: true, active: null };
}

export function continuityState() {
  const state = ensureContinuity();
  const open = state.suggestions.filter((entry) => entry.status === 'open');
  const continuations = canonicalContinuations(state);
  const visible = continuations.slice(0, 12);
  const ready = visible.filter((entry) => entry.ready && entry.status === 'ready');
  return {
    enabled: enabled(),
    lastTickAt: state.lastTickAt,
    scans: state.scans,
    active: state.active,
    window: state.window,
    frame: state.frame,
    verdicts: state.verdicts.slice(0, 12),
    suggestions: state.suggestions.slice(0, 12),
    continuations: visible,
    events: state.events.slice(0, 20),
    summary: {
      openSuggestions: open.length,
      readyContinuations: ready.length,
      lastStatus: state.verdicts[0]?.status || 'idle',
      lastScore: state.verdicts[0]?.score ?? null,
      windowState: state.window?.state || state.active?.window?.state || 'unknown',
    },
  };
}

/** Command Center counts must be derived from the same canonical, visible queue. */
export function continuityCounts(view = continuityState()) {
  const continuations = Array.isArray(view?.continuations) ? view.continuations : [];
  const suggestions = Array.isArray(view?.suggestions) ? view.suggestions : [];
  return {
    continuitySuggestions: suggestions.filter((entry) => entry.status === 'open').length,
    continuityReady: continuations.filter((entry) => entry.ready && entry.status === 'ready').length,
  };
}

export function prepareSuggestedWorkflow(id) {
  const state = ensureContinuity();
  const suggestion = state.suggestions.find((entry) => entry.id === id);
  if (!suggestion) throw new Error('Continuity suggestion not found.');
  if (suggestion.preparedWorkflowId) {
    const existing = (db().workflows || []).find((workflow) => workflow.id === suggestion.preparedWorkflowId);
    if (existing) return existing;
  }
  const source = (db().workflows || []).find((workflow) => workflow.id === suggestion.workflowId);
  const requestedName = String(suggestion.title || 'Continuity draft').replace(/^Suggested:\s*/i, '').trim();
  const workflow = {
    id: uid('wf'),
    name: clip(requestedName || 'Continuity draft', 90),
    description: clip(suggestion.detail, 900),
    status: 'draft',
    createdAt: now(),
    updatedAt: now(),
    target: source?.target || null,
    patternTags: ['continuity', ...(source?.patternTags || [])].filter(Boolean).slice(0, 8),
    steps: (suggestion.steps || []).map((step) => ({ ...step, id: step.id || uid('stp') })),
    runHistory: [],
    sourceRunId: suggestion.sourceRunId || null,
  };
  db().workflows.unshift(workflow);
  suggestion.preparedWorkflowId = workflow.id;
  suggestion.preparedAt = now();
  event('draft', `Prepared draft “${workflow.name}” from continuity checks.`, { workflowId: workflow.id, suggestionId: suggestion.id });
  logActivity('continuity', `Prepared draft workflow “${workflow.name}”`, { workflowId: workflow.id });
  persist();
  return workflow;
}

export function dismissSuggestion(id) {
  const suggestion = ensureContinuity().suggestions.find((entry) => entry.id === id);
  if (!suggestion) throw new Error('Continuity suggestion not found.');
  suggestion.status = 'dismissed';
  suggestion.dismissedAt = now();
  persist();
  return suggestion;
}

export function continuationForRun(runId) {
  return ensureContinuity().continuations.find((entry) => entry.runId === runId) || null;
}

export function canonicalContinuations(state = ensureContinuity()) {
  const runs = new Map((db().runs || []).map((run) => [run.id, run]));
  const verdicts = new Map();
  for (const verdict of state.verdicts || []) {
    if (verdict.runId && !verdicts.has(verdict.runId)) verdicts.set(verdict.runId, verdict);
  }
  const byRun = new Map();
  for (const entry of state.continuations || []) {
    if (!entry.runId || byRun.has(entry.runId)) continue;
    byRun.set(entry.runId, { ...entry });
  }
  return [...byRun.values()]
    .map((entry) => {
      const run = runs.get(entry.runId);
      const verdict = verdicts.get(entry.runId);
      let status = entry.status;
      let ready = Boolean(entry.ready);
      let reason = entry.reason || '';
      let blockedReason = entry.blockedReason || '';
      if (!run) {
        status = 'stale';
        ready = false;
        blockedReason = 'The run no longer exists.';
      } else if (!['failed', 'needs_review', 'cancelled'].includes(run.status)) {
        status = run.status === 'passed' ? 'resolved' : 'stale';
        ready = false;
        blockedReason = `The run is ${run.status}; there is nothing to continue.`;
      } else if (status === 'retrying') {
        const retry = entry.retryRunId ? runs.get(entry.retryRunId) : null;
        if (!retry) {
          status = 'stale';
          ready = false;
          blockedReason = 'The retry run no longer exists.';
        } else if (!['running', 'queued'].includes(retry.status)) {
          status = retry.status === 'failed' ? 'blocked' : 'resolved';
          ready = false;
          blockedReason = `The retry run is ${retry.status}.`;
        }
      } else if (verdict?.continuation) {
        ready = Boolean(verdict.continuation.ready);
        status = ready ? 'ready' : 'blocked';
        reason = verdict.continuation.reason || reason;
        blockedReason = verdict.continuation.blockedReason || '';
      }
      // A run is not ready to approve until a recovery candidate exists and
      // passed its shadow test. Window readiness alone is only review input.
      if (ready) {
        const linkedPack = run?.recoveryPackId ? findRecoveryPack(run.recoveryPackId) : null;
        // A pack that produced this run is retry history, not a new candidate.
        const pack = linkedPack?.retryRunId === run.id ? null : linkedPack;
        if (!pack) {
          ready = false;
          status = 'review';
          blockedReason = 'No tested recovery candidate is prepared yet; review this run first.';
        } else if (!(pack.candidates || []).some((candidate) => candidate.test?.ok)) {
          ready = false;
          status = 'blocked';
          blockedReason = `Recovery pack ${pack.id} has no tested candidate; repair or replan it before approving.`;
        }
      }
      if (ready && verdict?.window && ['closed', 'hidden'].includes(verdict.window.state)) {
        ready = false;
        status = 'blocked';
        blockedReason = verdict.window.state === 'closed' ? 'Open the application, then continue.' : 'Restore a visible window, then continue.';
      }
      return { ...entry, status, ready, reason, blockedReason };
    })
    .sort(
      (a, b) =>
        Number(Boolean(b.ready)) - Number(Boolean(a.ready)) ||
        String(b.updatedAt || b.at || '').localeCompare(String(a.updatedAt || a.at || ''))
    );
}

export function markContinuityContinuation(runId, patch = {}) {
  const state = ensureContinuity();
  let entry = state.continuations.find((row) => row.runId === runId);
  if (!entry) return null;
  entry = { ...entry, ...patch, updatedAt: now() };
  state.continuations = state.continuations.map((row) => (row.runId === runId ? entry : row));
  persist();
  return entry;
}

export async function aiReviewContinuity(runId = null) {
  const state = ensureContinuity();
  const run = (runId ? findRun(runId) : null) || (db().runs || []).find((entry) => entry.id === state.verdicts[0]?.runId) || null;
  if (!run) throw new Error('No run is available for continuity review.');
  const workflow = findWorkflow(run);
  const review = state.verdicts.find((entry) => entry.runId === run.id) || (await reviewRunContinuity(run, { capture: false }));
  const target = targetFor({ run, workflow, step: stepById(workflow, run.currentStepId) });
  const fallbackTarget = target.title || target.process ? target : inferredTargetFromWorkflow(workflow);
  let windowState = state.window;
  if (!windowState && !run.dryRun && (fallbackTarget.title || fallbackTarget.process)) {
    try {
      windowState = await inspectWindowState(fallbackTarget);
    } catch {}
  }
  const frame = latestEvidence(run) || state.frame;
  let images = [];
  if (frame?.path) {
    try {
      const abs = resolveContinuityFramePath(frame.path);
      if (abs) images = [fs.readFileSync(abs).toString('base64')];
    } catch {}
  }
  let vision = false;
  if (images.length) {
    try {
      const listed = await listModels();
      const models = Array.isArray(listed?.models) ? listed.models : [];
      const selected = models.find((model) => model.name === db().settings?.model);
      vision = Boolean(selected?.vision || selected?.capabilities?.includes?.('vision'));
    } catch {}
  }
  const context = {
    goal: workflowGoal(workflow, run),
    run: { id: run.id, status: run.status, error: run.error || null, steps: (run.steps || []).map((step) => ({ name: step.name, type: step.type, status: step.status, error: step.error || null })) },
    checks: review.checks,
    triggers: review.triggers,
    window: windowState,
    conversation: (db().memory?.conversation?.summaries || []).slice(-3).map((entry) => entry.text),
    workflow: workflow ? { name: workflow.name, description: workflow.description, steps: (workflow.steps || []).map((step) => ({ name: step.name, type: step.type, params: step.params })) } : null,
  };
  const reply = await chat(
    [
      {
        role: 'system',
        content:
          'You are Sightline continuity common sense. Decide whether the workflow should continue, wait, be fixed, or stop. Verify that responses are practical, triggers match real steps, links are credible, coordinate drift has a fallback, and typed text follows the current conversation. Return JSON only: {"decision":"continue|wait|fix|stop","summary":"...","trigger":"...","updatedText":"...","fallback":"...","confidence":0.0}.',
      },
      { role: 'user', content: JSON.stringify(context).slice(0, 14000) },
    ],
    { format: 'json', kind: 'continuity', timeoutMs: 60000, maxTokens: 600, images: vision ? images : [] }
  );
  const parsed = parseJsonLoose(reply.content) || {};
  const ai = {
    at: now(),
    decision: ['continue', 'wait', 'fix', 'stop'].includes(parsed.decision) ? parsed.decision : 'wait',
    summary: clip(parsed.summary, 700),
    trigger: clip(parsed.trigger, 300),
    updatedText: clip(parsed.updatedText, 800),
    fallback: clip(parsed.fallback, 500),
    confidence: Math.max(0, Math.min(1, num(parsed.confidence, 0.5))),
    vision,
  };
  review.ai = ai;
  const entry = state.verdicts.find((row) => row.runId === run.id);
  if (entry) entry.ai = ai;
  if (ai.updatedText) {
    const suggestion = state.suggestions.find((row) => row.sourceRunId === run.id && row.status === 'open');
    if (suggestion) {
      suggestion.detail = `${suggestion.detail} AI wording: ${ai.updatedText}`.slice(0, 1200);
      suggestion.aiText = ai.updatedText;
    }
  }
  event('ai', `${ai.decision} · ${ai.summary || 'No summary'}`, { runId: run.id, confidence: ai.confidence, vision });
  persist();
  return { ok: true, ai, review };
}
