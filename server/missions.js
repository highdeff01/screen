import fs from 'node:fs';
import path from 'node:path';
import { db, persist, uid, now, DATA, NOTES, logActivity, slug, writeFileDurable } from './store.js';
import { executeStep } from './automation.js';
import { createRun, findRun, cancelRun, controlRun } from './engine.js';
import { chat, parseJsonLoose, listModels } from './llm.js';
import { normalizeStep, addSuggestion, writeRunNote } from './planner.js';
import { queueShortcutCandidates, recordShortcutOutcomes } from './shortcuts.js';

const ACTIVE_STATUSES = ['queued', 'planning', 'running', 'verifying', 'reviewing', 'replanning'];
const ACTIVE = new Map();
const MAX_EVENTS = 400;
const MAX_CHECKS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min));

export function findMission(id) {
  const mission = db().missions.find((entry) => entry.id === id) || null;
  if (mission) ensureMissionShape(mission);
  return mission;
}

function ensureMissionShape(mission) {
  const conditions = mission.conditions || (mission.conditions = {});
  if (conditions.observeEnabled === undefined) conditions.observeEnabled = true;
  if (conditions.autoApplyObserved === undefined) conditions.autoApplyObserved = true;
  if (conditions.observeEverySteps === undefined) conditions.observeEverySteps = 2;
  if (conditions.extractUserInput === undefined) conditions.extractUserInput = true;
  if (conditions.autoApplyUserInput === undefined) conditions.autoApplyUserInput = true;
  if (conditions.autoTestExtracted === undefined) conditions.autoTestExtracted = true;
  if (!Array.isArray(mission.ledger)) mission.ledger = [];
  if (!Array.isArray(mission.refinements)) mission.refinements = [];
  if (!Array.isArray(mission.userInputs)) mission.userInputs = [];
  if (!mission.observer) {
    mission.observer = {
      status: 'idle',
      lastAt: null,
      confidence: 0,
      summary: 'Observer has not reviewed this mission yet.',
      position: null,
      observed: '',
      nextRealStep: '',
      decision: 'continue',
      screenshot: null,
    };
  }
  if (!mission.observer.applied && mission.refinements?.length) {
    mission.observer.applied = mission.refinements.length;
  }
  mission.pipeline = mission.pipeline || [];
  if (!mission.pipeline.some((entry) => entry.role === 'observer')) {
    mission.pipeline.splice(2, 0, {
      role: 'observer',
      name: 'Observer / drifter',
      status: 'idle',
      task: 'Watches screenshots and the step ledger, then inserts missed in-between steps',
      subAgents: [
        { name: 'Screen observer', status: 'idle' },
        { name: 'Step drifter', status: 'idle' },
        { name: 'Missed-step hunter', status: 'idle' },
      ],
    });
  }
  if (!mission.pipeline.some((entry) => entry.role === 'input-extractor')) {
    mission.pipeline.splice(1, 0, {
      role: 'input-extractor',
      name: 'User input extractor',
      status: 'idle',
      task: 'Turns operator notes into testable workflow steps',
      subAgents: [
        { name: 'Intent parser', status: 'idle' },
        { name: 'Step writer', status: 'idle' },
      ],
    });
  }
  return mission;
}

export function missionSummary(mission) {
  return {
    id: mission.id,
    goal: mission.goal,
    workflowId: mission.workflowId,
    workflowName: mission.workflowName,
    mode: mission.mode,
    status: mission.status,
    stage: mission.stage,
    paused: Boolean(mission.paused),
    attempts: mission.attempts,
    maxAttempts: mission.maxAttempts,
    lastRunId: mission.lastRunId,
    verdict: mission.verification?.verdict || null,
    confidence: mission.verification?.confidence ?? null,
    learnedPattern: mission.learnedPattern ? mission.learnedPattern.signature : null,
    createdAt: mission.createdAt,
    startedAt: mission.startedAt,
    endedAt: mission.endedAt,
    eventCount: mission.events.length,
    checkCount: mission.checks.length,
    ledgerCount: (mission.ledger || []).length,
    refinementCount: (mission.refinements || []).length,
    userInputCount: (mission.userInputs || []).length,
    observer: mission.observer
      ? {
          status: mission.observer.status,
          confidence: mission.observer.confidence,
          decision: mission.observer.decision,
          position: mission.observer.position,
          lastAt: mission.observer.lastAt,
        }
      : null,
  };
}

export function listMissions() {
  return db().missions.map(missionSummary);
}

function logEvent(mission, agent, kind, message, extra = {}) {
  mission.events.unshift({ id: uid('evt'), at: now(), agent, kind, message, ...extra });
  if (mission.events.length > MAX_EVENTS) mission.events.length = MAX_EVENTS;
  persist();
}

function setAgent(mission, role, status, task, output) {
  const agent = mission.pipeline.find((entry) => entry.role === role);
  if (!agent) return;
  agent.status = status;
  if (task !== undefined) agent.task = task;
  if (output !== undefined) agent.output = String(output).slice(0, 600);
  persist();
}

function setSub(mission, role, subName, status) {
  const agent = mission.pipeline.find((entry) => entry.role === role);
  const sub = agent?.subAgents?.find((entry) => entry.name === subName);
  if (sub) sub.status = status;
  persist();
}

function errorSignature(run) {
  if (!run) return null;
  const failed = (run.steps || []).find((step) => step.status === 'failed');
  if (!failed) return null;
  return `${failed.type}:${String(failed.error || 'failed').replace(/\d+/g, '#').slice(0, 140)}`;
}

function findPattern(signature) {
  return db().patterns.find((pattern) => pattern.signature === signature) || null;
}

function rememberPattern(mission) {
  for (const replan of mission.replans) {
    if (!replan.signature || !replan.steps?.length) continue;
    let pattern = findPattern(replan.signature);
    if (!pattern) {
      pattern = {
        id: uid('pat'),
        signature: replan.signature,
        fixSteps: replan.steps,
        wins: 0,
        uses: 0,
        createdAt: now(),
        lastAt: null,
      };
      db().patterns.push(pattern);
      db().patterns = db().patterns.slice(-60);
    }
    pattern.fixSteps = replan.steps;
    pattern.wins = (pattern.wins || 0) + 1;
    pattern.lastAt = now();
  }
  persist();
}

export function createMission(options = {}) {
  const workflow = db().workflows.find((entry) => entry.id === options.workflowId);
  if (!workflow) throw new Error('Workflow not found');
  const settings = db().settings;
  const conditions = options.conditions || {};
  const mode = options.mode === 'live' ? 'live' : 'dry';
  const maxAttempts = clamp(conditions.maxAttempts ?? 2, 1, 4);
  const mission = {
    id: uid('msn'),
    goal: String(options.goal || '').trim() || workflow.description || workflow.name,
    context: String(options.context || '').slice(0, 4000),
    workflowId: workflow.id,
    workflowName: workflow.name,
    mode,
    trigger: options.trigger || 'manual',
    status: 'queued',
    stage: 'intake',
    attempts: 0,
    maxAttempts,
    paused: false,
    cancelRequested: false,
    conditions: {
      requireVerification: conditions.requireVerification !== false,
      autoReplan: conditions.autoReplan !== false,
      autoApplyReplan: conditions.autoApplyReplan !== false,
      useLearnedPatterns: conditions.useLearnedPatterns !== false,
      stopOnFailure: Boolean(conditions.stopOnFailure),
      vision: Boolean(conditions.vision),
      autoReadyOnPass: Boolean(conditions.autoReadyOnPass),
      checkIntervalMs: clamp(conditions.checkIntervalMs ?? settings.missionCheckIntervalMs ?? 5000, 1000, 60000),
      stallMs: clamp(conditions.stallMs ?? 120000, 15000, 900000),
      observeEnabled: conditions.observeEnabled !== false,
      autoApplyObserved: conditions.autoApplyObserved !== false,
      observeEverySteps: clamp(conditions.observeEverySteps ?? 2, 1, 10),
      extractUserInput: conditions.extractUserInput !== false,
      autoApplyUserInput: conditions.autoApplyUserInput !== false,
      autoTestExtracted: conditions.autoTestExtracted !== false,
      newChat: typeof conditions.newChat === 'boolean' ? conditions.newChat : null,
    },
    frame: {
      goal: String(options.goal || '').trim() || workflow.name,
      expectation: '',
      baselinePath: null,
      notes: [],
    },
    pipeline: [
      {
        role: 'supervisor',
        name: 'Supervisor',
        status: 'idle',
        task: 'Holds the frame and links the sub-agents',
        subAgents: [
          { name: 'Research', status: 'idle' },
          { name: 'Cross-reference', status: 'idle' },
        ],
      },
      {
        role: 'input-extractor',
        name: 'User input extractor',
        status: 'idle',
        task: 'Turns operator notes into testable workflow steps',
        subAgents: [
          { name: 'Intent parser', status: 'idle' },
          { name: 'Step writer', status: 'idle' },
        ],
      },
      {
        role: 'planner',
        name: 'Planner / researcher',
        status: 'idle',
        task: 'Refines intent into steps and replans',
        subAgents: [{ name: 'Step builder', status: 'idle' }],
      },
      {
        role: 'observer',
        name: 'Observer / drifter',
        status: 'idle',
        task: 'Watches screenshots and the step ledger, then inserts missed in-between steps',
        subAgents: [
          { name: 'Screen observer', status: 'idle' },
          { name: 'Step drifter', status: 'idle' },
          { name: 'Missed-step hunter', status: 'idle' },
        ],
      },
      {
        role: 'executor-a',
        name: 'Executor A',
        status: 'idle',
        task: 'Primary run dispatch',
        subAgents: [{ name: 'Input driver', status: 'idle' }],
      },
      {
        role: 'executor-b',
        name: 'Executor B',
        status: 'idle',
        task: 'Repair run dispatch',
        subAgents: [{ name: 'Retry driver', status: 'idle' }],
      },
      {
        role: 'verifier',
        name: 'Verifier',
        status: 'idle',
        task: 'Compares evidence with the goal',
        subAgents: [{ name: 'Evidence check', status: 'idle' }],
      },
      {
        role: 'reviewer',
        name: 'Final reviewer',
        status: 'idle',
        task: 'Updates notes, workflow and suggestions',
        subAgents: [{ name: 'Notes', status: 'idle' }],
      },
    ],
    references: [],
    events: [],
    runs: [],
    checks: [],
    replans: [],
    ledger: [],
    refinements: [],
    userInputs: [],
    observer: {
      status: 'idle',
      lastAt: null,
      confidence: 0,
      summary: 'Observer waiting for the first evidence frame.',
      position: null,
      observed: '',
      nextRealStep: '',
      decision: 'continue',
      screenshot: null,
    },
    commands: [],
    verification: null,
    review: null,
    learnedPattern: null,
    lastRunId: null,
    startedAt: null,
    endedAt: null,
    createdAt: now(),
  };
  db().missions.unshift(mission);
  db().missions = db().missions.slice(0, 40);
  persist();
  logEvent(mission, 'supervisor', 'start', `Mission accepted for “${workflow.name}”.`);
  logActivity('mission', `Mission created: ${workflow.name}`, { missionId: mission.id });
  return mission;
}

export function startMission(id) {
  const mission = findMission(id);
  if (!mission) throw new Error('Mission not found');
  if (ACTIVE.has(id)) return mission;
  if (!ACTIVE_STATUSES.includes(mission.status)) throw new Error('Mission is already finished');
  mission.cancelRequested = false;
  persist();
  const task = runMission(id)
    .catch((err) => {
      const current = findMission(id);
      if (!current) return;
      current.status = 'failed';
      current.stage = 'error';
      current.endedAt = now();
      logEvent(current, 'supervisor', 'error', `Mission crashed: ${err.message}`);
      logActivity('mission', `Mission failed: ${err.message}`, { missionId: id });
    })
    .finally(() => ACTIVE.delete(id));
  ACTIVE.set(id, task);
  return mission;
}

async function waitWhilePaused(mission) {
  let waited = 0;
  while (mission.paused && !mission.cancelRequested && waited < 600000) {
    await sleep(1000);
    waited += 1000;
  }
  return !mission.cancelRequested;
}

async function capture(mission, kind, caption, run = null) {
  const step = {
    id: uid('ev'),
    type: 'screenshot',
    name: caption,
    params: { caption },
    timeoutMs: 20000,
  };
  try {
    const result = await executeStep(step, {
      live: mission.mode === 'live',
      runId: run?.id || mission.lastRunId || null,
      run: run || { id: mission.id },
      workflow: null,
      getTool: () => null,
    });
    const item = result.evidence?.[0];
    if (!item) return null;
    const reference = {
      id: uid('ref'),
      kind,
      caption,
      path: item.path,
      simulated: Boolean(item.simulated),
      width: item.width || null,
      height: item.height || null,
      at: now(),
    };
    mission.references.push(reference);
    if (mission.references.length > 30) mission.references = mission.references.slice(-30);
    persist();
    return reference;
  } catch (err) {
    logEvent(mission, 'supervisor', 'error', `Capture failed: ${err.message}`);
    return null;
  }
}

async function visionPayload(mission, run) {
  if (!mission.conditions.vision) return {};
  if (!db().settings.visionEnabled) {
    logEvent(mission, 'verifier', 'decision', 'Vision check requested but vision is disabled in settings.');
    return {};
  }
  const settings = db().settings;
  const models = await listModels();
  const info = models.ok ? models.models.find((model) => model.name === settings.model) : null;
  if (!info || !info.capabilities?.includes('vision')) {
    logEvent(mission, 'verifier', 'decision', `Model ${settings.model} has no vision capability; verifying from logs instead.`);
    return {};
  }
  const candidates = [...(run?.evidence || []), ...mission.references]
    .filter((item) => item.path?.endsWith('.png') && !item.simulated)
    .reverse();
  const latest = candidates[0];
  if (!latest) return {};
  try {
    const buffer = fs.readFileSync(path.join(DATA, latest.path));
    if (buffer.length > 1800000) return {};
    logEvent(mission, 'verifier', 'action', `Attached ${latest.path} to the verification prompt.`, { path: latest.path });
    return { images: [buffer.toString('base64')], path: latest.path };
  } catch {
    return {};
  }
}

function workflowStepsText(workflow, run = null) {
  return workflow.steps
    .map((step, index) => {
      const runtime = run?.steps?.[index];
      const status = runtime ? ` {${runtime.status}}` : '';
      return `${index + 1}. [${step.type}] ${step.name}${status} ${JSON.stringify(step.params)}`;
    })
    .join('\n');
}

function validRefinementStep(step, existingTypes) {
  if (!step || !step.type) return false;
  const p = step.params || {};
  if (['launchApp', 'openUrl', 'focusWindow'].includes(step.type) && existingTypes.has(step.type)) return false;
  if (step.type === 'launchApp' && !String(p.target || '').trim()) return false;
  if (step.type === 'openUrl' && !String(p.url || p.urlVar || '').trim()) return false;
  if (step.type === 'focusWindow' && !String(p.title || p.windowName || p.process || '').trim()) return false;
  if (['move', 'click', 'doubleClick', 'rightClick'].includes(step.type) && (!Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y)))) return false;
  if (step.type === 'type' && !String(p.text || '').trim()) return false;
  if (step.type === 'key' && !(Array.isArray(p.keys) ? p.keys.length : String(p.keys || '').trim())) return false;
  if (step.type === 'waitFor' && !String(p.value || p.title || p.process || '').trim()) return false;
  return true;
}

function stepRefKey(step) {
  const type = String(step.type || '');
  const p = step.params || {};
  const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  const target = norm(p.target || p.app || p.application || p.path).replace(/\.exe$/i, '');
  if (type === 'launchApp') return `${type}|${target}`;
  if (type === 'openUrl') return `${type}|${norm(p.url || p.urlVar).replace(/\/+$/, '')}`;
  if (type === 'focusWindow') return `${type}|${norm(p.title || p.windowName || p.value || p.process).replace(/\.exe$/i, '')}`;
  if (type === 'type') return `${type}|${norm(p.text || p.value)}`;
  if (type === 'key') return `${type}|${norm(p.keys)}`;
  if (type === 'clickElement') return `${type}|${norm(p.name || p.element)}`;
  if (['click', 'move', 'doubleClick', 'rightClick'].includes(type)) {
    return `${type}|${Number(p.x) || 0},${Number(p.y) || 0}`;
  }
  if (type === 'wait') return `${type}|${Number(p.ms) || 1000}`;
  if (type === 'waitFor') return `${type}|${norm(p.kind)}|${norm(p.value || p.title || p.process).replace(/\.exe$/i, '')}`;
  return `${type}|${JSON.stringify(p)}`;
}

function normalizeProposalSteps(proposal) {
  const rows = [];
  if (Array.isArray(proposal?.missing)) {
    for (const item of proposal.missing) {
      const rawSteps = Array.isArray(item.steps) ? item.steps : [item];
      const after = Number(item.afterStep ?? item.afterIndex ?? item.step ?? 0);
      const index = Number.isFinite(after) ? after - 1 : 0;
      rows.push({
        action: 'insertAfter',
        index,
        steps: rawSteps,
        reason: String(item.reason || proposal?.summary || 'Missed in-between step').slice(0, 500),
      });
    }
  }
  if (Array.isArray(proposal?.refinements)) {
    for (const item of proposal.refinements) {
      let index = Number(item.index ?? item.stepIndex);
      if (!Number.isFinite(index)) index = Number(item.step ?? item.stepNumber) - 1;
      if (!Number.isFinite(index)) index = 0;
      rows.push({
        action: ['insertBefore', 'insertAfter', 'replace', 'split'].includes(item.action) ? item.action : 'insertBefore',
        index,
        steps: Array.isArray(item.steps) ? item.steps : [],
        reason: String(item.reason || proposal?.summary || 'Observed refinement').slice(0, 500),
      });
    }
  }
  return rows;
}

function normalizeRefinements(proposal, workflow) {
  const out = [];
  let budget = 8;
  for (const row of normalizeProposalSteps(proposal)) {
    if (budget <= 0) break;
    const steps = [];
    for (const raw of row.steps) {
      if (budget <= 0) break;
      const step = normalizeStep(raw, out.length);
      if (!step) continue;
      steps.push(step);
      budget--;
    }
    if (!steps.length) continue;
    const length = workflow.steps.length;
    const rawIndex = Number.isFinite(Number(row.index)) ? Number(row.index) : 0;
    const index =
      row.action === 'insertAfter'
        ? Math.max(-1, Math.min(Math.max(0, length - 1), rawIndex))
        : Math.max(0, Math.min(Math.max(0, length - 1), rawIndex));
    out.push({ ...row, index, steps });
  }
  return out;
}

function applyRefinements(mission, proposals, source = 'observer', meta = {}) {
  const workflow = db().workflows.find((entry) => entry.id === mission.workflowId);
  if (!workflow || !Array.isArray(proposals) || !proposals.length) return { applied: 0, entries: [] };
  const ordered = [...proposals].sort((a, b) => b.index - a.index);
  const entries = [];
  for (const proposal of ordered) {
    const length = workflow.steps.length;
    const at = proposal.action === 'insertAfter' ? clamp(proposal.index + 1, 0, length) : clamp(proposal.index, 0, length);
    const remove = proposal.action === 'replace' || proposal.action === 'split' ? 1 : 0;
    const existingKeys = new Set(workflow.steps.map(stepRefKey));
    const existingTypes = new Set(workflow.steps.map((step) => step.type));
    const existingNames = new Set(workflow.steps.map((step) => `${step.type}|${String(step.name || '').trim().toLowerCase()}`));
    const seenNames = new Set();
    const maxSteps = proposal.action === 'replace' || proposal.action === 'split' ? 4 : 2;
    if ((proposal.steps || []).length > maxSteps) continue;
    const steps = (proposal.steps || []).filter((step) => {
      if (!step || existingKeys.has(stepRefKey(step)) || !validRefinementStep(step, existingTypes)) return false;
      const nameKey = `${step.type}|${String(step.name || '').trim().toLowerCase()}`;
      if (existingNames.has(nameKey) || seenNames.has(nameKey)) return false;
      seenNames.add(nameKey);
      return true;
    });
    if (!steps.length) continue;
    if (at >= workflow.steps.length && steps.every((step) => step.type === 'wait')) continue;
    if (at === 0 && ['launchApp', 'openUrl'].includes(workflow.steps[0]?.type) && steps.every((step) => step.type === 'wait')) continue;
    if (remove && at >= workflow.steps.length) continue;
    workflow.steps.splice(at, remove, ...steps);
    const entry = {
      id: uid('ref'),
      at: now(),
      source,
      trigger: meta.trigger || 'observer',
      action: proposal.action,
      index: at,
      reason: proposal.reason || '',
      confidence: meta.confidence ?? null,
      position: meta.position || null,
      screenshot: meta.screenshot || null,
      steps: steps.map((step) => ({ id: step.id, type: step.type, name: step.name, params: step.params })),
    };
    mission.refinements.unshift(entry);
    entries.push(entry);
  }
  if (entries.length) {
    mission.refinements = mission.refinements.slice(0, 120);
    workflow.updatedAt = now();
    logEvent(
      mission,
      source === 'user-input' ? 'input-extractor' : 'observer',
      'refinement',
      `${source === 'user-input' ? 'Operator input' : 'Observer'} inserted ${entries.length} refinement(s): ${entries
        .map((entry) => entry.reason)
        .filter(Boolean)
        .join(' · ')
        .slice(0, 260)}`,
      { steps: entries.reduce((total, entry) => total + entry.steps.length, 0) }
    );
  }
  persist();
  return { applied: entries.length, entries };
}

function heuristicObserverProposal(mission, run) {
  const workflow = db().workflows.find((entry) => entry.id === mission.workflowId);
  if (!workflow) return { summary: 'Workflow is missing.', confidence: 0, missing: [], refinements: [] };
  const missing = [];
  for (let index = 0; index < workflow.steps.length; index++) {
    const step = workflow.steps[index];
    const previous = workflow.steps[index - 1];
    const next = workflow.steps[index + 1];
    if (['click', 'doubleClick', 'rightClick'].includes(step.type) && step.params?.x !== undefined && step.params?.y !== undefined) {
      const alreadyMoved = previous?.type === 'move' && Number(previous.params?.x) === Number(step.params.x) && Number(previous.params?.y) === Number(step.params.y);
      if (!alreadyMoved) {
        missing.push({
          afterStep: index,
          type: 'move',
          name: `Move pointer to ${step.params.x}, ${step.params.y}`,
          params: { x: step.params.x, y: step.params.y },
          reason: 'A coordinate action is two observable actions: move first, then click.',
        });
      }
    }
    if (['launchApp', 'openUrl'].includes(step.type) && next && !['wait', 'waitFor', 'focusWindow', 'screenshot', 'expect', 'verifyScreen'].includes(next.type)) {
      missing.push({
        afterStep: index + 1,
        type: next.type === 'openUrl' ? 'wait' : 'waitFor',
        name: 'Let the app or page become interactive',
        params:
          next.type === 'openUrl'
            ? { ms: 1200 }
            : {
                kind: 'window',
                value: String(step.params?.title || step.params?.target || '')
                  .replace(/^.*[\\/]/, '')
                  .replace(/\.exe$/i, ''),
                mode: 'present',
                timeoutMs: 12000,
                intervalMs: 500,
              },
        reason: 'The evidence has to show the window/page is ready before the next action.',
      });
    }
    if (step.type === 'clickElement' && next?.type === 'type') {
      missing.push({
        afterStep: index + 1,
        type: 'wait',
        name: 'Wait for the field to accept input',
        params: { ms: 350 },
        reason: 'Clicking and typing are separate observed states; do not assume focus landed.',
      });
    }
  }
  const passed = run?.steps?.filter((step) => step.status === 'passed').length || 0;
  const total = workflow.steps.length;
  const current = run?.steps?.find((step) => step.status === 'running') || run?.steps?.[Math.min(passed, Math.max(0, total - 1))];
  const next = run?.steps?.find((step) => step.status === 'pending');
  return {
    position: {
      stepIndex: Math.max(0, passed - 1),
      stepNumber: Math.min(total, Math.max(1, passed)),
      phase: run?.status || mission.status,
      current: current?.name || 'between steps',
      nextRealStep: next?.name || 'none',
      visible: 'inferred from the ledger; no vision model available',
    },
    observed: `${passed}/${total} steps have passed; the next real step is “${next?.name || 'none'}”.`,
    nextRealStep: next?.name || 'none',
    decision: run?.status === 'failed' ? 'retry' : 'continue',
    confidence: missing.length ? 0.55 : 0.35,
    summary: missing.length ? `${missing.length} in-between step(s) proposed from the ledger heuristics.` : 'No clear gap in the ledger.',
    missing,
    refinements: [],
  };
}

function observerScreenshotPaths(mission, run, fresh = null) {
  const candidates = [
    ...(fresh ? [fresh] : []),
    ...(run?.evidence || []).slice().reverse(),
    ...(mission.references || []).slice().reverse(),
  ];
  const seen = new Set();
  const out = [];
  for (const item of candidates) {
    if (!item?.path || !String(item.path).endsWith('.png')) continue;
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item);
    if (out.length >= 2) break;
  }
  return out;
}

async function observerImages(mission, run, fresh) {
  const paths = observerScreenshotPaths(mission, run, fresh);
  if (!paths.length) return { paths: [], images: [] };
  const images = [];
  for (const item of paths) {
    try {
      const buffer = fs.readFileSync(path.join(DATA, item.path));
      if (buffer.length > 1800000) continue;
      images.push(buffer.toString('base64'));
    } catch {
      // A missing or oversized frame is skipped; the ledger still drives the observation.
    }
  }
  return { paths: paths.map((item) => item.path), images };
}

function observerHistory(mission, run) {
  const workflow = db().workflows.find((entry) => entry.id === mission.workflowId);
  const types = new Set((workflow?.steps || []).map((step) => step.type));
  const mapRun = (entry) => ({
    id: entry.id,
    workflow: entry.workflowName,
    status: entry.status,
    failed: (entry.steps || []).find((step) => step.status === 'failed')?.name || null,
    error: (entry.steps || []).find((step) => step.status === 'failed')?.error || null,
    ledger: (entry.ledger || []).slice(-4).map((item) => `${item.seq}. ${item.name} → ${item.status}${item.next ? ` · next: ${item.next.name}` : ''}`),
  });
  const sameWorkflow = db()
    .runs.filter((entry) => entry.workflowId === mission.workflowId && entry.id !== run?.id)
    .slice(0, 6)
    .map(mapRun);
  const similarAttempts = db()
    .runs.filter((entry) => entry.workflowId !== mission.workflowId && entry.id !== run?.id)
    .map((entry) => ({ entry, overlap: (entry.steps || []).filter((step) => types.has(step.type)).length }))
    .filter((item) => item.overlap >= 2)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 3)
    .map((item) => ({ ...mapRun(item.entry), overlap: item.overlap }));
  return {
    sameWorkflow,
    similarAttempts,
    learnedPatterns: db().patterns.slice(0, 4).map((pattern) => ({ signature: pattern.signature, wins: pattern.wins, steps: pattern.fixSteps?.length || 0 })),
  };
}

export async function observeMission(mission, run, trigger = 'progress') {
  ensureMissionShape(mission);
  if (!mission.conditions?.observeEnabled || mission.observerRunning) {
    return { skipped: mission.observerRunning ? 'observer already running' : 'observer disabled' };
  }
  mission.observerRunning = true;
  mission.observer.status = 'working';
  setAgent(mission, 'observer', 'working', `Observing evidence (${trigger})`);
  setSub(mission, 'observer', 'Screen observer', 'working');
  setSub(mission, 'observer', 'Step drifter', 'working');
  try {
    const fresh = await capture(mission, 'observation', `Observer evidence (${trigger})`, run);
    const workflow = db().workflows.find((entry) => entry.id === mission.workflowId);
    if (!workflow) throw new Error('Workflow was deleted while observing');
    setSub(mission, 'observer', 'Missed-step hunter', 'working');
    const shots = await observerImages(mission, run, fresh);
    const models = await listModels();
    const settings = db().settings;
    const preferred = settings.observerModel || settings.replanModel || settings.model;
    let model = preferred;
    let vision = false;
    if (models.ok) {
      const info = models.models.find((entry) => entry.name === preferred);
      vision = Boolean(info?.capabilities?.includes('vision'));
      if (!vision) {
        const fallback = models.models.find((entry) => entry.capabilities?.includes('vision'));
        if (fallback) {
          model = fallback.name;
          vision = true;
        }
      }
    }
    const ledger = (run?.ledger || []).slice(-14);
    const inputs = (mission.userInputs || []).slice(0, 6);
    const context = [
      `Goal: ${mission.goal}`,
      mission.context ? `Forwarded context: ${mission.context}` : '',
      `Mode: ${mission.mode}`,
      `Trigger: ${trigger}`,
      `Attempt: ${mission.attempts}/${mission.maxAttempts}; run: ${run?.status || 'none'} ${run?.id || ''}`,
      `Current ledger position: ${JSON.stringify(run?.position || mission.observer?.position || null)}`,
      `Workflow statuses (1-based):\n${workflowStepsText(workflow, run)}`,
      `Recent ledger:\n${
        ledger.map((item) => `${item.seq}. [${item.status}] ${item.type} “${item.name}”${item.error ? ` ERROR ${item.error}` : ''} → next: ${item.next?.name || 'none'}`).join('\n') || 'none'
      }`,
      `Recent per-step visual audits (changed % of a downsampled screen signature):\n${
        (run?.steps || [])
          .filter((step) => step.visual)
          .slice(-8)
          .map((step) => `- ${step.name}: ${step.visual.changedPct}% changed${step.visual.noVisibleChange ? ' (no visible change)' : ''}${step.audit?.message ? ` — ${step.audit.message}` : ''}`)
          .join('\n') || 'none'
      }`,
      `Operator findings already extracted:\n${inputs.map((item) => `- ${item.text}${item.summary ? ` => ${item.summary}` : ''}`).join('\n') || 'none'}`,
      `Agent notes and checks:\n${
        (mission.events || [])
          .filter((event) => ['note', 'decision', 'verification', 'refinement'].includes(event.kind))
          .slice(0, 6)
          .map((event) => `- ${event.agent}: ${event.message}`)
          .join('\n') || 'none'
      }`,
      `Verification / review: ${JSON.stringify({ verification: mission.verification || null, review: mission.review || null })}`,
      `Prior, similar and pattern history:\n${JSON.stringify(observerHistory(mission, run), null, 2)}`,
      `Potential: consider what could go wrong next and whether a fallback step is needed before declaring the workflow coherent.`,
      `Evidence frames selected (chronological): ${shots.paths.join(', ') || 'none'}`,
      `Vision attached: ${vision && shots.images.length ? 'yes' : 'no'}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const reply = await chat(
      [
        {
          role: 'system',
          content:
            'You are the always-on observer and drifter for a Windows UI-automation mission. ' +
            'You inspect the selected screenshot sequence and the step ledger instead of trusting familiarity or assumptions. ' +
            'Reply as JSON only: {"position":{"stepIndex":0,"stepNumber":1,"phase":"...","current":"...","nextRealStep":"...","visible":"..."},"observed":"what the evidence actually shows","nextExpected":"...","potential":"what could go wrong next","missing":[{"afterStep":1,"type":"move","name":"...","params":{},"reason":"..."}],"refinements":[{"action":"insertBefore|insertAfter|replace|split","step":1,"steps":[...],"reason":"..."}],"decision":"continue|retry|pause|done","confidence":0.0,"summary":"..."}. ' +
            'Allowed step types are launchApp, openUrl, focusWindow, move, click, doubleClick, rightClick, drag, scroll, type, key, clipboard, aiExtract, wait, waitFor, screenshot, verifyScreen, verifyPlayback, mediaHold, expect, playMedia, closeWindow, runTool, note, writeNote, readNote, copyLink, downloadMedia, saveImage, writeTextFile, recordVideo, watchVideo, installApp, testApp. ' +
            'Break coarse actions into the real intermediate actions. Moving the mouse and clicking are two separate steps; launching/focusing an app, waiting for it to be ready, clicking the field and typing are separate observable steps. ' +
            'Trust the ledger statuses: a passed step has passed, and a passed run has passed. Never claim a failure, empty clipboard or skipped step that the ledger marks passed. ' +
            'If the run passed, use decision done and return empty missing/refinements. Only insert a step when the screenshot order or ledger shows a missing state between two steps. Never invent a coordinate, label or URL that is not supported by the evidence or workflow. Prefer waitFor/focusWindow over fixed waits. Max 8 proposed steps. ' +
            'Use the per-step visual audits: a step with no visible change may need a wait, a foreground re-focus, an assertion, or a different control. Do not change a step that visibly worked. ' +
            'If the workflow is already coherent, return empty missing/refinements. Keep observed and summary under 80 words.',
        },
        { role: 'user', content: context },
      ],
      {
        format: 'json',
        kind: 'mission-observer',
        timeoutMs: 90000,
        temperature: 0.15,
        model: model || undefined,
        ...(vision && shots.images.length ? { images: shots.images } : {}),
      }
    );
    let proposal = reply.ok ? parseJsonLoose(reply.content) : null;
    let source = 'ai';
    if (!proposal || (!Array.isArray(proposal.missing) && !Array.isArray(proposal.refinements))) {
      proposal = heuristicObserverProposal(mission, run);
      source = 'heuristic';
      logEvent(
        mission,
        'observer',
        'decision',
        reply.ok ? 'Model returned no usable observation; using the evidence-ledger heuristic.' : `Observer model unavailable (${reply.error}); using the evidence-ledger heuristic.`
      );
    } else {
      const heuristic = heuristicObserverProposal(mission, run);
      proposal.missing = [...(Array.isArray(proposal.missing) ? proposal.missing : []), ...(heuristic.missing || [])];
      proposal.refinements = [...(Array.isArray(proposal.refinements) ? proposal.refinements : []), ...(heuristic.refinements || [])];
      if (!proposal.position && heuristic.position) proposal.position = heuristic.position;
    }
    const confidence = clamp(proposal.confidence ?? 0.5, 0, 1);
    const refinements = normalizeRefinements(proposal, workflow);
    const safeMoment = run?.status !== 'running' || trigger === 'stall' || trigger === 'failure' || trigger === 'run-end';
    const runPassed = run?.status === 'passed';
    const shouldApply = mission.conditions.autoApplyObserved && !runPassed && refinements.length > 0 && confidence >= 0.45 && safeMoment;
    const applied = shouldApply
      ? applyRefinements(mission, refinements, source, {
          trigger,
          confidence,
          position: proposal.position || run?.position || null,
          screenshot: fresh?.path || shots.paths[0] || null,
        })
      : { applied: 0, entries: [] };
    const observedPosition = { ...(proposal.position || run?.position || null) };
    if (observedPosition && workflow) {
      observedPosition.total = workflow.steps.length;
      const inserted = applied.entries[0]?.steps?.[0];
      if (inserted) observedPosition.next = { id: inserted.id, type: inserted.type, name: inserted.name, params: inserted.params, status: 'pending' };
    }
    const appliedTotal = Number(mission.observer?.applied || 0) + Number(applied.applied || 0);
    mission.observer = {
      status: 'idle',
      lastAt: now(),
      source,
      trigger,
      confidence,
      decision: runPassed ? 'done' : ['continue', 'retry', 'pause', 'done'].includes(proposal.decision) ? proposal.decision : 'continue',
      summary: runPassed
        ? 'Run passed; the ledger shows every step completed successfully.'
        : String(proposal.summary || proposal.observed || '').slice(0, 900),
      observed: String(proposal.observed || '').slice(0, 900),
      nextExpected: runPassed ? '' : String(proposal.nextExpected || '').slice(0, 500),
      potential: String(proposal.potential || '').slice(0, 500),
      nextRealStep: String(observedPosition?.next?.name || proposal.position?.nextRealStep || proposal.nextRealStep || '').slice(0, 300),
      position: observedPosition || null,
      screenshot: fresh?.path || shots.paths[0] || null,
      applied: appliedTotal,
      model: model || null,
      vision: Boolean(vision && shots.images.length),
    };
    mission.ledger.unshift({
      id: uid('led'),
      at: now(),
      source,
      trigger,
      confidence,
      decision: mission.observer.decision,
      position: mission.observer.position,
      observed: mission.observer.observed,
      nextRealStep: mission.observer.nextRealStep,
      summary: mission.observer.summary,
      screenshot: mission.observer.screenshot,
      proposed: refinements.map((entry) => ({ action: entry.action, index: entry.index, reason: entry.reason, steps: entry.steps.map((step) => `${step.type}: ${step.name}`) })),
      applied: applied.entries.map((entry) => ({ action: entry.action, index: entry.index, reason: entry.reason, steps: entry.steps.length })),
    });
    mission.ledger = mission.ledger.slice(0, 160);
    setSub(mission, 'observer', 'Screen observer', 'idle');
    setSub(mission, 'observer', 'Step drifter', 'idle');
    setSub(mission, 'observer', 'Missed-step hunter', 'idle');
    setAgent(
      mission,
      'observer',
      'idle',
      applied.applied ? `${applied.applied} refinement(s) applied` : 'No safe refinement',
      mission.observer.summary
    );
    logEvent(
      mission,
      'observer',
      applied.applied ? 'refinement' : 'observation',
      `${source === 'ai' ? 'Observer' : 'Heuristic observer'} at ${mission.observer.position?.stepNumber || '?'}/${
        workflow.steps.length
      }: ${mission.observer.summary || 'no change'}${applied.applied ? ` · ${applied.applied} refinement(s) applied` : ''}`,
      { path: mission.observer.screenshot }
    );
    persist();
    return { mission, observed: true, source, confidence, applied: applied.applied, refinements: applied.entries.length, position: mission.observer.position };
  } catch (err) {
    mission.observer = { ...(mission.observer || {}), status: 'error', lastAt: now(), summary: `Observer failed: ${err.message}` };
    setAgent(mission, 'observer', 'error', 'Observation failed', err.message);
    logEvent(mission, 'observer', 'error', `Observation failed: ${err.message}`);
    return { mission, error: err.message };
  } finally {
    mission.observerRunning = false;
    if (mission.observer?.status === 'working') mission.observer.status = 'idle';
    for (const name of ['Screen observer', 'Step drifter', 'Missed-step hunter']) setSub(mission, 'observer', name, 'idle');
    if (mission.pipeline.find((entry) => entry.role === 'observer')?.status === 'working') {
      setAgent(mission, 'observer', 'idle');
    }
    persist();
  }
}

function explicitStepsFromNote(text) {
  const note = String(text);
  const steps = [];
  const move = note.match(/(?:move|cursor|pointer|mouse)[^.\n]*?(\d{2,4})\s*[, ]\s*(\d{2,4})/i);
  if (move) {
    steps.push({ type: 'move', name: `Move pointer to ${move[1]}, ${move[2]}`, params: { x: Number(move[1]), y: Number(move[2]) } });
  }
  const click = note.match(/click[^.\n]*?(\d{2,4})\s*[, ]\s*(\d{2,4})/i);
  if (click && !move) {
    steps.push({ type: 'click', name: `Click at ${click[1]}, ${click[2]}`, params: { x: Number(click[1]), y: Number(click[2]) } });
  }
  const wait = note.match(/wait[^.\n]*?(\d+)\s*ms/i);
  if (wait) steps.push({ type: 'wait', name: `Wait ${wait[1]}ms`, params: { ms: Number(wait[1]) } });
  const key = note.match(/press\s+([a-z0-9+]+)/i);
  if (key) steps.push({ type: 'key', name: `Press ${key[1]}`, params: { keys: key[1] } });
  const typed = note.match(/type\s+["“]([^"”]+)["”]/i);
  if (typed) steps.push({ type: 'type', name: `Type ${typed[1]}`, params: { text: typed[1] } });
  return steps;
}

function inferTargetStep(text, workflow) {
  if (!workflow?.steps?.length) return null;
  const lower = String(text).toLowerCase();
  const wantsBeforeType = lower.includes('before typing');
  const wantsBeforeClick = lower.includes('before clicking');
  if (!wantsBeforeType && !wantsBeforeClick) return null;
  const index = workflow.steps.findIndex((step) =>
    wantsBeforeType ? step.type === 'type' : ['click', 'clickElement'].includes(step.type)
  );
  return index >= 0 ? index + 1 : null;
}

export async function extractUserInput(mission, note, run = null) {
  ensureMissionShape(mission);
  const text = String(note || '').trim().slice(0, 2000);
  if (!text) throw new Error('Write an operator note before extracting steps.');
  setAgent(mission, 'input-extractor', 'working', 'Parsing the operator note');
  setSub(mission, 'input-extractor', 'Intent parser', 'working');
  const workflow = db().workflows.find((entry) => entry.id === mission.workflowId);
  const reply = await chat(
    [
      {
        role: 'system',
        content:
          'You extract concrete, testable UI-automation steps from an operator note. Reply as JSON only: ' +
          '{"intent":"...","findings":["..."],"targetStep":1,"steps":[...],"missing":[{"afterStep":1,"type":"move","name":"...","params":{},"reason":"..."}],"confidence":0.0,"summary":"..."}. ' +
          'Allowed step types are launchApp, openUrl, focusWindow, move, click, doubleClick, rightClick, drag, scroll, type, key, clipboard, aiExtract, wait, waitFor, screenshot, verifyScreen, verifyPlayback, mediaHold, expect, playMedia, closeWindow, runTool, note, writeNote, readNote, copyLink, downloadMedia, saveImage, writeTextFile, recordVideo, watchVideo, installApp, testApp. ' +
          'Turn vague guidance into observable actions: move and click are separate steps; app launch/focus/wait/click/type are separate steps. Preserve the operator’s real finding, do not substitute a different app, and use the exact labels, keys, coordinates or text they provide. Return steps: [] when the note has no actionable instruction. Max 8 steps.',
      },
      {
        role: 'user',
        content: `Mission goal: ${mission.goal}\nWorkflow (1-based):\n${
          workflow ? workflowStepsText(workflow, run) : 'workflow missing'
        }\nRecent ledger:\n${
          (run?.ledger || []).slice(-8).map((item) => `${item.seq}. ${item.name} -> ${item.status}${item.error ? ` (${item.error})` : ''}`).join('\n') || 'none'
        }\nOperator note:\n${text}`,
      },
    ],
    { format: 'json', kind: 'mission-user-input', timeoutMs: 90000, temperature: 0.2, model: db().settings.replanModel || undefined }
  );
  let parsed = reply.ok ? parseJsonLoose(reply.content) : null;
  if (!parsed || (!Array.isArray(parsed.steps) && !Array.isArray(parsed.missing))) {
    parsed = { intent: text, findings: [text], targetStep: null, steps: [], missing: [], confidence: 0.2, summary: 'No model extraction available.' };
  }
  const explicit = explicitStepsFromNote(text);
  if (explicit.length) {
    parsed.steps = explicit;
    parsed.missing = [];
    parsed.targetStep = inferTargetStep(text, workflow) || parsed.targetStep;
    parsed.confidence = Math.max(0.7, Number(parsed.confidence) || 0);
    parsed.summary = `Extracted ${explicit.length} explicit step(s) from the operator note.`;
  }
  const target = Number(parsed.targetStep);
  const proposal = normalizeRefinements(
    {
      summary: parsed.summary || parsed.intent || text,
      refinements:
        Array.isArray(parsed.steps) && parsed.steps.length
          ? [
              {
                action: Number.isFinite(target) && target > 0 ? 'insertBefore' : 'insertAfter',
                index: Number.isFinite(target) && target > 0 ? target - 1 : Math.max(0, (workflow?.steps.length || 1) - 1),
                steps: parsed.steps,
                reason: parsed.summary || parsed.intent || 'Operator finding',
              },
            ]
          : [],
      missing: parsed.missing || [],
    },
    workflow || { steps: [] }
  );
  const confidence = clamp(parsed.confidence ?? 0.5, 0, 1);
  const applied =
    mission.conditions?.autoApplyUserInput && proposal.length
      ? applyRefinements(mission, proposal, 'user-input', { trigger: 'operator-note', confidence, position: run?.position || null })
      : { applied: 0, entries: [] };
  const record = {
    id: uid('uin'),
    at: now(),
    text,
    by: 'operator',
    intent: String(parsed.intent || '').slice(0, 900),
    findings: Array.isArray(parsed.findings) ? parsed.findings.map(String).slice(0, 8) : [],
    summary: String(parsed.summary || '').slice(0, 900),
    confidence,
    proposed: proposal.map((item) => ({ action: item.action, index: item.index, reason: item.reason, steps: item.steps.map((step) => `${step.type}: ${step.name}`) })),
    applied: applied.entries.map((item) => ({ action: item.action, index: item.index, steps: item.steps.length })),
    source: reply.ok ? 'ai' : 'fallback',
    tested: false,
  };
  mission.userInputs.unshift(record);
  mission.userInputs = mission.userInputs.slice(0, 60);
  mission.ledger.unshift({
    id: uid('led'),
    at: now(),
    source: 'user-input',
    trigger: 'operator-note',
    confidence,
    decision: applied.applied ? 'applied' : 'observed',
    position: run?.position || null,
    observed: record.intent || text,
    nextRealStep: proposal[0]?.steps?.[0]?.name || '',
    summary: record.summary || text,
    screenshot: null,
    proposed: record.proposed,
    applied: record.applied,
  });
  mission.ledger = mission.ledger.slice(0, 160);
  setSub(mission, 'input-extractor', 'Intent parser', 'idle');
  setSub(mission, 'input-extractor', 'Step writer', 'idle');
  setAgent(
    mission,
    'input-extractor',
    'idle',
    applied.applied ? `${applied.applied} extracted step block(s) sent to the planner` : 'No actionable steps found',
    record.summary
  );
  logEvent(
    mission,
    'input-extractor',
    applied.applied ? 'refinement' : 'decision',
    applied.applied
      ? `Operator input extracted into ${applied.entries.reduce((total, item) => total + item.steps.length, 0)} step(s) and queued for the next test: ${record.summary}`
      : `Operator input reviewed; no concrete step change: ${record.summary}`
  );
  persist();
  return { mission, record, applied: applied.applied, entries: applied.entries };
}

export async function observeActiveMissions(agent = {}) {
  const interval = Math.max(20000, Number(agent.intervalMs) || 60000);
  const active = db().missions.filter((mission) => {
    if (!ACTIVE_STATUSES.includes(mission.status)) return false;
    ensureMissionShape(mission);
    if (!mission.conditions?.observeEnabled) return false;
    const last = mission.observer?.lastAt ? new Date(mission.observer.lastAt).getTime() : 0;
    return Date.now() - last >= interval;
  });
  const observed = [];
  for (const mission of active.slice(0, 2)) {
    const run = mission.lastRunId ? findRun(mission.lastRunId) : null;
    if (!run) continue;
    const result = await observeMission(mission, run, 'agent');
    if (result?.observed) observed.push(`${mission.id}:${result.applied || 0}`);
  }
  return { observed, skipped: active.length ? undefined : 'no active mission due for observation' };
}

async function supervisorReview(mission) {
  const workflow = db().workflows.find((entry) => entry.id === mission.workflowId);
  const tools = db().tools.filter((tool) => tool.status === 'approved').map((tool) => tool.name).join(', ') || 'none';
  const reply = await chat(
    [
      {
        role: 'system',
        content:
          'You are the supervisor of a Windows screen-automation mission. Review the workflow against the goal. ' +
          'Reply as JSON only: {"review":"...","expectation":"...","replan":{"needed":true|false,"summary":"...","steps":[...]}}. ' +
          'Steps use: launchApp, openUrl, focusWindow, move, click, doubleClick, rightClick, drag, scroll, type, key, clipboard, aiExtract, wait, waitFor, screenshot, verifyScreen, verifyPlayback, mediaHold, expect, playMedia, closeWindow, runTool, note, writeNote, readNote, copyLink, downloadMedia, saveImage, writeTextFile, recordVideo, watchVideo, installApp, testApp. ' +
          'Only propose steps that close a real gap between the goal and the workflow. Never substitute Notepad or another app for the app the goal names. Prefer multiple fallback methods (waitFor, foreground guard, keyboard/menu path, vision check) over one brittle coordinate. Use ctrl+a/ctrl+c shortcuts or clipboard steps for copying, and aiExtract to pull the correct response out of a document. When media is involved, derive holds from the actual player duration and verify progress rather than assuming a fixed length. Keep the review under 120 words.',
      },
      {
        role: 'user',
        content: `Goal: ${mission.goal}\n${mission.context ? `Forwarded failure context:\n${mission.context}\n` : ''}Mode: ${mission.mode === 'live' ? 'live desktop input' : 'simulated'}\nApproved tools: ${tools}\nWorkflow: ${workflow.name}\n${workflowStepsText(
          workflow
        )}`,
      },
    ],
    { format: 'json', kind: 'mission-review', timeoutMs: 90000, temperature: 0.2 }
  );

  if (reply.ok) {
    const parsed = parseJsonLoose(reply.content);
    if (parsed) {
      const steps = Array.isArray(parsed.replan?.steps) ? parsed.replan.steps : [];
      return {
        review: String(parsed.review || 'Supervisor review complete.').slice(0, 900),
        expectation: String(parsed.expectation || mission.goal).slice(0, 900),
        replan: { needed: Boolean(parsed.replan?.needed), summary: parsed.replan?.summary || '', steps },
        source: 'ai',
      };
    }
  }
  const missingScreenshot = !workflow.steps.some((step) => step.type === 'screenshot');
  const missingAssertion = !workflow.steps.some((step) => step.type === 'expect');
  return {
    review: `Heuristic review: ${workflow.steps.length} steps. ${missingScreenshot ? 'No screenshot step. ' : ''}${
      missingAssertion ? 'No assertion step. ' : ''
    }${reply.ok ? '' : `AI unavailable (${reply.error}).`}`.trim(),
    expectation: mission.goal,
    replan: { needed: false, summary: '', steps: [] },
    source: 'heuristic',
  };
}

function applyReplan(mission, replan, source, signature = null) {
  const workflow = db().workflows.find((entry) => entry.id === mission.workflowId);
  if (!workflow) return false;
  const steps = (replan.steps || []).map((step, index) => normalizeStep(step, index)).filter(Boolean);
  if (!steps.length) return false;
  const run = mission.lastRunId ? findRun(mission.lastRunId) : null;
  const failedIndex = run ? run.steps.findIndex((step) => step.status === 'failed') : -1;
  const index =
    Number.isInteger(replan.atIndex) && replan.atIndex >= 0
      ? Math.min(replan.atIndex, workflow.steps.length)
      : failedIndex >= 0 && source !== 'pattern'
      ? Math.min(failedIndex, workflow.steps.length)
      : workflow.steps.length;
  workflow.steps.splice(index, 0, ...steps);
  workflow.updatedAt = now();
  persist();
  mission.replans.push({
    id: uid('rpl'),
    at: now(),
    source,
    signature: signature || (run ? errorSignature(run) : null),
    summary: String(replan.summary || `${steps.length} step(s) inserted`).slice(0, 800),
    steps,
    index,
    applied: true,
  });
  logEvent(
    mission,
    'planner',
    'replan',
    `${source === 'pattern' ? 'Learned pattern' : 'Replan'}: ${replan.summary || `${steps.length} step(s)`} (inserted at ${index + 1}).`,
    { steps: steps.length }
  );
  return true;
}

function heuristicReplan(run, workflow) {
  const failed = run?.steps?.find((step) => step.status === 'failed');
  if (!failed) {
    return {
      summary: 'Verifier was off target but no step failed.',
      steps: [{ type: 'screenshot', name: 'Re-capture evidence', params: { caption: 'Verification re-capture' } }],
    };
  }
  if (failed.type === 'focusWindow' || failed.type === 'type') {
    return {
      summary: `Wait for the target window before “${failed.name}”.`,
      steps: [
        {
          type: 'waitFor',
          name: 'Wait for the window before retrying',
          params: {
            kind: 'window',
            value: failed.params?.title || 'Notepad',
            mode: 'present',
            timeoutMs: 12000,
            intervalMs: 500,
          },
        },
      ],
    };
  }
  if (failed.type === 'expect') {
    return {
      summary: `Give the UI time to reach the asserted state, then re-check “${failed.name}”.`,
      steps: [{ type: 'wait', name: 'Settle before assertion', params: { ms: 1500 } }],
    };
  }
  return {
    summary: `Pause briefly before retrying “${failed.name}”.`,
    steps: [{ type: 'wait', name: 'Backoff before retry', params: { ms: 1200 } }],
  };
}

async function replanMission(mission, reason, run) {
  setAgent(mission, 'planner', 'working', 'Replanning from failure evidence');
  setSub(mission, 'planner', 'Step builder', 'working');
  const signature = errorSignature(run);
  mission.learnedPattern = null;

  if (signature && mission.conditions.useLearnedPatterns) {
    const pattern = findPattern(signature);
    if (pattern?.fixSteps?.length) {
      pattern.uses = (pattern.uses || 0) + 1;
      pattern.lastAt = now();
      const applied = applyReplan(
        mission,
        { summary: `Learned fix for “${signature}” (${pattern.wins} previous wins).`, steps: pattern.fixSteps },
        'pattern',
        signature
      );
      if (applied) {
        mission.learnedPattern = { signature, patternId: pattern.id, wins: pattern.wins };
        logEvent(mission, 'planner', 'decision', 'Applied a remembered fix that worked before.');
        setAgent(mission, 'planner', 'idle', 'Pattern applied');
        return { applied: true, source: 'pattern' };
      }
    }
  }

  const workflow = db().workflows.find((entry) => entry.id === mission.workflowId);
  const failures = (run?.steps || [])
    .filter((step) => step.status === 'failed')
    .map((step) => `${step.name} (${step.type}): ${step.error || 'failed'}`)
    .join('\n');
  const checks = mission.checks
    .slice(-8)
    .map((check) => `${check.at} ${check.step} -> ${check.status}`)
    .join('\n');
  const prior = mission.replans.map((replan) => replan.summary).join(' | ') || 'none';

  setAgent(mission, 'planner', 'working', 'Asking the model for a repair plan');
  const reply = await chat(
    [
      {
        role: 'system',
        content:
          'You repair Windows screen-automation workflows. Reply as JSON only: {"summary":"...","steps":[...]}. ' +
          'Insert the smallest set of steps (max 6) that would prevent this failure next attempt. ' +
          'Allowed types: launchApp, openUrl, focusWindow, move, click, doubleClick, rightClick, drag, scroll, type, key, clipboard, aiExtract, wait, waitFor, screenshot, verifyScreen, verifyPlayback, mediaHold, expect, playMedia, closeWindow, runTool, note, writeNote, readNote, copyLink, downloadMedia, saveImage, writeTextFile, recordVideo, watchVideo, installApp, testApp. ' +
          'Never substitute Notepad or another app for the app the goal names. Use key shortcuts such as ctrl+a, ctrl+c, ctrl+v (never type the shortcut words), and clipboard copyAll/read + aiExtract to copy the correct response from a document. Prefer waitFor over fixed waits. Use mediaHold for media duration/progress, and add a second independent method when a click, keypress or window title may vary with program settings. Return {"steps":[]} if the workflow cannot be repaired automatically.',
      },
      {
        role: 'user',
        content:           `Goal: ${mission.goal}\n${mission.context ? `Forwarded failure context:\n${mission.context}\n` : ''}Attempts: ${mission.attempts}/${mission.maxAttempts}\nReason: ${reason}\nFailures:\n${failures || 'none'}\nRecent checks:\n${checks || 'none'}\nPrevious replans: ${prior}\nObserver position: ${JSON.stringify(
            mission.observer?.position || null
          )}\nObserver finding: ${mission.observer?.summary || 'none'}\nRecent step ledger:\n${
            (run?.ledger || [])
              .slice(-8)
              .map((item) => `${item.seq}. ${item.name} -> ${item.status}${item.error ? ` (${item.error})` : ''} · next: ${item.next?.name || 'none'}`)
              .join('\n') || 'none'
          }\nOperator extractions: ${
            (mission.userInputs || []).slice(0, 4).map((item) => item.summary || item.text).join(' | ') || 'none'
          }\nCurrent workflow:\n${workflowStepsText(
          workflow,
          run
        )}`,
      },
    ],
    {
      format: 'json',
      kind: 'mission-replan',
      timeoutMs: 90000,
      temperature: 0.25,
      model: db().settings.replanModel || undefined,
    }
  );

  let plan = null;
  if (reply.ok) {
    const parsed = parseJsonLoose(reply.content);
    if (parsed && Array.isArray(parsed.steps) && parsed.steps.length) plan = parsed;
  }
  if (!plan) {
    plan = { ...heuristicReplan(run, workflow), summary: `${heuristicReplan(run, workflow).summary} (heuristic)` };
    logEvent(mission, 'planner', 'decision', reply.ok ? 'Model returned no usable steps; used the repair heuristic.' : `AI unavailable (${reply.error}); used the repair heuristic.`);
  }
  const applied = applyReplan(mission, plan, 'ai', signature);
  setSub(mission, 'planner', 'Step builder', 'idle');
  setAgent(mission, 'planner', 'idle', applied ? 'Repair plan applied' : 'No repair available', plan.summary);
  return { applied, source: 'ai', summary: plan.summary };
}

async function verifyMission(mission, run) {
  setAgent(mission, 'verifier', 'working', 'Comparing the run with the goal');
  setSub(mission, 'verifier', 'Evidence check', 'working');
  const vision = await visionPayload(mission, run);
  const failed = (run.steps || []).filter((step) => step.status === 'failed');
  const evidence = [
    ...(run.evidence || []).map((item) => `${item.kind}${item.simulated ? ' (simulated)' : ''}: ${item.caption || item.path}`),
    ...mission.references.slice(-3).map((item) => `${item.kind}: ${item.caption}${item.simulated ? ' (simulated)' : ''}`),
  ].join('; ');
  const checks = mission.checks
    .slice(-10)
    .map((check) => `${check.step} -> ${check.status} @${check.intervalMs}ms`)
    .join('\n');

  const reply = await chat(
    [
      {
        role: 'system',
        content:
          'You are the verifier for a Windows screen-automation mission. Decide whether the run achieved the goal. ' +
          'Reply as JSON only: {"verdict":"on_target|off_target|unknown","confidence":0.0-1.0,"summary":"...","findings":["..."],"nextActions":["..."]}. ' +
          'Simulated evidence never proves pixels; if the mode was simulated, cap confidence at 0.6. Be strict about assertions.',
      },
      {
        role: 'user',
        content: `Goal: ${mission.goal}\nExpected: ${mission.frame.expectation || mission.goal}\nMode: ${
          mission.mode === 'live' ? 'live' : 'simulated (no real desktop input)'
        }\nRun status: ${run.status}\nSteps:\n${(run.steps || [])
          .map((step) => `${step.name} (${step.type}) -> ${step.status}${step.error ? ` | ${step.error}` : ''}`)
          .join('\n')}\nEvidence: ${evidence || 'none'}\nChecks:\n${checks || 'none'}`,
      },
    ],
    { format: 'json', kind: 'mission-verify', timeoutMs: 90000, temperature: 0.15, images: vision.images }
  );

  if (reply.ok) {
    const parsed = parseJsonLoose(reply.content);
    if (parsed && ['on_target', 'off_target', 'unknown'].includes(parsed.verdict)) {
      return {
        verdict: parsed.verdict,
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
        summary: String(parsed.summary || '').slice(0, 900),
        findings: Array.isArray(parsed.findings) ? parsed.findings.map(String).slice(0, 8) : [],
        nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions.map(String).slice(0, 8) : [],
        comparedWith: evidence ? evidence.slice(0, 400) : '',
        visionUsed: Boolean(vision.images),
        source: 'ai',
        at: now(),
      };
    }
  }

  const passed = failed.length === 0 && run.status === 'passed';
  const hasAssertion = (run.steps || []).some((step) => step.type === 'expect');
  return {
    verdict: passed ? 'on_target' : 'off_target',
    confidence: passed ? (hasAssertion ? 0.7 : 0.5) : 0.8,
    summary: passed
      ? hasAssertion
        ? 'Every step passed and the workflow contains an assertion.'
        : 'Every step passed, but the workflow has no assertion step, so the result is sequence-only.'
      : `${failed.length} step(s) failed; the goal is not confirmed.`,
    findings: failed.map((step) => `${step.name}: ${step.error || 'failed'}`),
    nextActions: failed.length
      ? ['Review the failure screenshot and insert a wait for the target window.']
      : ['Add an explicit assertion such as expect window.'],
    comparedWith: evidence.slice(0, 400),
    visionUsed: false,
    source: 'heuristic',
    at: now(),
  };
}

async function finalReview(mission, run, verdict) {
  setAgent(mission, 'reviewer', 'working', 'Writing the mission review');
  setSub(mission, 'reviewer', 'Notes', 'working');
  const reply = await chat(
    [
      {
        role: 'system',
        content:
          'You are the final reviewer of a screen-automation mission. Reply as JSON only: ' +
          '{"summary":"...","updates":["..."],"nextActions":["..."],"workflowStatus":"keep|draft|ready"}. ' +
          'Be specific about what the evidence proves and what it does not.',
      },
      {
        role: 'user',
        content: `Goal: ${mission.goal}\nWorkflow: ${mission.workflowName}\nMode: ${mission.mode}\nAttempts: ${mission.attempts}/${mission.maxAttempts}\nRun: ${
          run?.status
        }\nVerification: ${verdict?.verdict} (${Math.round((verdict?.confidence || 0) * 100)}%) — ${verdict?.summary || ''}\nFindings: ${
          verdict?.findings?.join('; ') || 'none'
        }\nReplans: ${mission.replans.map((replan) => replan.summary).join(' | ') || 'none'}`,
      },
    ],
    { format: 'json', kind: 'mission-review-final', timeoutMs: 90000, temperature: 0.2 }
  );
  if (reply.ok) {
    const parsed = parseJsonLoose(reply.content);
    if (parsed?.summary) {
      return {
        summary: String(parsed.summary).slice(0, 1200),
        updates: Array.isArray(parsed.updates) ? parsed.updates.map(String).slice(0, 6) : [],
        nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions.map(String).slice(0, 6) : [],
        workflowStatus: ['keep', 'draft', 'ready'].includes(parsed.workflowStatus) ? parsed.workflowStatus : 'keep',
        source: 'ai',
        at: now(),
      };
    }
  }
  return {
    summary: verdict?.summary || `Run finished ${run?.status || 'unknown'}.`,
    updates: [
      `Attempts used: ${mission.attempts}/${mission.maxAttempts}`,
      `References captured: ${mission.references.length}`,
      `Replans applied: ${mission.replans.length}`,
    ],
    nextActions: verdict?.nextActions || [],
    workflowStatus: 'keep',
    source: 'heuristic',
    at: now(),
  };
}

function writeMissionNote(mission, run, review) {
  const lines = [
    `# Mission — ${mission.workflowName}`,
    '',
    `- Mission: \`${mission.id}\``,
    `- Goal: ${mission.goal}`,
    `- Mode: ${mission.mode === 'live' ? 'Live desktop control' : 'Simulated (no desktop input)'}`,
    `- Result: **${mission.status}** after ${mission.attempts}/${mission.maxAttempts} attempt(s)`,
    `- Verdict: ${mission.verification?.verdict || 'n/a'} (${Math.round((mission.verification?.confidence || 0) * 100)}%)`,
    `- Run: ${run ? `\`${run.id}\`` : 'none'}`,
    '',
    '## Review',
    review.summary || '',
    '',
    '## Updates',
    ...(review.updates?.length ? review.updates.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Next actions',
    ...(review.nextActions?.length ? review.nextActions.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Replans',
    ...(mission.replans.length ? mission.replans.map((item) => `- ${item.source}: ${item.summary}`) : ['- None']),
    '',
    '## References',
    ...mission.references.map(
      (ref) => `- ${ref.kind}${ref.simulated ? ' (simulated)' : ''}: ${ref.caption} \`${ref.path}\``
    ),
  ];
  const body = lines.join('\n');
  const file = path.join(NOTES, `${slug(`mission-${mission.workflowName}`)}-${mission.id}.md`);
  writeFileDurable(file, body);
  const note = {
    id: uid('note'),
    title: `Mission — ${mission.workflowName} (${mission.status})`,
    body,
    file: path.relative(process.cwd(), file).split(path.sep).join('/'),
    source: review.source === 'ai' ? 'ai' : 'auto',
    missionId: mission.id,
    runId: run?.id || null,
    workflowId: mission.workflowId,
    tags: ['mission', mission.status],
    createdAt: now(),
  };
  db().notes.unshift(note);
  db().notes = db().notes.slice(0, 120);
  persist();
  logActivity('mission', `Mission note written: ${mission.workflowName}`, { missionId: mission.id });
  return note;
}

async function monitorRun(mission, runId, execRole) {
  let interval = mission.conditions.checkIntervalMs;
  let previous = '';
  let stable = 0;
  let ticks = 0;
  let lastObservedPassed = 0;
  const started = Date.now();

  while (true) {
    if (mission.cancelRequested) {
      cancelRun(runId);
      return { cancelled: true, run: findRun(runId) };
    }
    await sleep(interval);
    const run = findRun(runId);
    if (!run) return { cancelled: false, run: null };
    const runningStep = run.steps.find((step) => step.status === 'running');
    const passedCount = run.steps.filter((step) => step.status === 'passed').length;
    const progress = `${passedCount}/${run.steps.length}:${run.status}:${runningStep?.id || ''}`;
    ticks++;
    mission.checks.unshift({
      at: now(),
      runId,
      step: runningStep?.name || run.status,
      status: run.status,
      note: `${passedCount}/${run.steps.length} steps`,
      intervalMs: interval,
      tick: ticks,
    });
    if (mission.checks.length > MAX_CHECKS) mission.checks.length = MAX_CHECKS;
    persist();

    const changed = progress !== previous;
    if (changed) {
      stable = 0;
      interval = Math.max(1000, Math.round(mission.conditions.checkIntervalMs / 2));
      logEvent(mission, execRole, 'progress', `${passedCount}/${run.steps.length} steps · ${runningStep?.name || run.status}`, {
        runId,
      });
    } else {
      stable++;
      interval = Math.min(15000, Math.round(interval * 1.5));
      if (ticks % 3 === 0) {
        logEvent(mission, 'supervisor', 'check', `Still on “${runningStep?.name || run.status}” (check ${ticks}).`);
      }
    }
    previous = progress;

    if (
      mission.conditions.observeEnabled &&
      run.status === 'running' &&
      passedCount > lastObservedPassed &&
      passedCount - lastObservedPassed >= Math.max(1, Number(mission.conditions.observeEverySteps) || 2)
    ) {
      lastObservedPassed = passedCount;
      try {
        await observeMission(mission, findRun(runId), 'progress');
      } catch (err) {
        logEvent(mission, 'observer', 'error', `Progress observation failed: ${err.message}`);
      }
    }

    if (!['queued', 'running'].includes(run.status)) return { cancelled: false, run };

    if (stable >= 4 && Date.now() - started > mission.conditions.stallMs) {
      logEvent(mission, 'supervisor', 'decision', `Run appears stalled on “${runningStep?.name || run.status}”; cancelling for repair.`, {
        runId,
      });
      cancelRun(runId);
      await sleep(1200);
      return { stalled: true, run: findRun(runId) };
    }
  }
}

async function runMission(id) {
  const mission = findMission(id);
  if (!mission) return;
  mission.status = 'planning';
  mission.stage = 'intake';
  mission.startedAt = mission.startedAt || now();
  persist();
  setAgent(mission, 'supervisor', 'working', 'Holding the frame');
  logEvent(mission, 'supervisor', 'start', `Mission running: ${mission.goal}`);

  setAgent(mission, 'supervisor', 'working', 'Capturing the baseline screen');
  setSub(mission, 'supervisor', 'Cross-reference', 'working');
  const baseline = await capture(mission, 'baseline', 'Baseline before commands');
  if (baseline) {
    mission.frame.baselinePath = baseline.path;
    logEvent(
      mission,
      'supervisor',
      'action',
      `Baseline captured${baseline.simulated ? ' (simulated placeholder)' : ''}; holding it for cross-reference.`,
      { path: baseline.path }
    );
  }
  setSub(mission, 'supervisor', 'Cross-reference', 'idle');

  setAgent(mission, 'planner', 'working', 'Reviewing the plan');
  const review = await supervisorReview(mission);
  mission.frame.expectation = review.expectation;
  mission.frame.notes.unshift({ at: now(), source: review.source, text: review.review });
  logEvent(mission, 'planner', 'decision', review.review);
  if (review.replan?.needed && review.replan.steps?.length && mission.conditions.autoReplan) {
    applyReplan(mission, review.replan, 'planning', null);
  }
  setAgent(mission, 'planner', 'idle', 'Plan reviewed', review.review);

  let run = null;
  let verdict = null;

  while (mission.attempts < mission.maxAttempts && !mission.cancelRequested) {
    const canContinue = await waitWhilePaused(mission);
    if (!canContinue) break;
    if (mission.pendingNote) {
      const note = mission.pendingNote;
      mission.pendingNote = null;
      logEvent(mission, 'operator', 'note', `Applying queued note before attempt ${mission.attempts + 1}: ${note}`);
      try {
        const applied = await replanMission(mission, `Operator note: ${note}`, run);
        logEvent(
          mission,
          'planner',
          'decision',
          applied?.applied
            ? `Operator note changed the route: ${applied.summary || 'repair plan applied'}.`
            : 'Operator note reviewed; no safe route change was found.'
        );
      } catch (err) {
        logEvent(mission, 'planner', 'error', `Could not apply the operator note: ${err.message}`);
      }
    }
    mission.attempts++;
    mission.stage = 'execute';
    mission.status = 'running';
    persist();
    const execRole = mission.attempts === 1 ? 'executor-a' : 'executor-b';
    setAgent(mission, execRole, 'working', `Attempt ${mission.attempts}/${mission.maxAttempts}`);
    setSub(mission, execRole, 'Input driver', 'working');

    const workflow = db().workflows.find((entry) => entry.id === mission.workflowId);
    if (!workflow) throw new Error('Workflow was deleted during the mission');
    run = createRun(workflow, {
      trigger: 'agent',
      dryRun: mission.mode !== 'live',
      agentRole: execRole,
      missionId: mission.id,
    });
    mission.lastRunId = run.id;
    mission.runs.push(run.id);
    logEvent(mission, execRole, 'action', `Dispatched run ${run.id} (${mission.mode === 'live' ? 'live' : 'simulated'}).`, {
      runId: run.id,
    });

    const outcome = await monitorRun(mission, run.id, execRole);
    run = outcome.run || findRun(run.id);
    setSub(mission, execRole, 'Input driver', 'idle');
    if (outcome.cancelled) break;
    if (!run) break;
    if (mission.conditions.observeEnabled) {
      try {
        await observeMission(mission, run, outcome.stalled ? 'stall' : 'attempt-end');
      } catch (err) {
        logEvent(mission, 'observer', 'error', `Attempt-end observation failed: ${err.message}`);
      }
    }
    setAgent(mission, execRole, run.status === 'passed' ? 'done' : 'error', `Run ${run.status}`, `${run.steps.filter((step) => step.status === 'passed').length}/${run.steps.length} steps passed`);

    mission.stage = 'verify';
    mission.status = 'verifying';
    persist();
    await capture(mission, 'checkpoint', `Screen after attempt ${mission.attempts}`, run);
    verdict = await verifyMission(mission, run);
    mission.verification = verdict;
    setSub(mission, 'verifier', 'Evidence check', 'idle');
    setAgent(
      mission,
      'verifier',
      verdict.verdict === 'on_target' ? 'done' : 'error',
      verdict.verdict,
      verdict.findings?.join(' · ') || verdict.summary
    );
    logEvent(
      mission,
      'verifier',
      'verification',
      `${verdict.verdict} at ${Math.round((verdict.confidence || 0) * 100)}% — ${verdict.summary || ''}`,
      { runId: run.id }
    );
    if (verdict.nextActions?.length) {
      logEvent(mission, 'verifier', 'decision', `Suggestions: ${verdict.nextActions.join(' · ')}`);
    }

    if (verdict.verdict === 'on_target' && run.status === 'passed') break;
    if (mission.attempts >= mission.maxAttempts) break;
    if (!mission.conditions.autoReplan) {
      logEvent(mission, 'supervisor', 'decision', 'Auto-replan is off; stopping after the failed attempt.');
      break;
    }
    mission.stage = 'replanning';
    mission.status = 'replanning';
    persist();
    const reason = verdict.summary || run.steps.find((step) => step.status === 'failed')?.error || run.status;
    const replan = await replanMission(mission, reason, run);
    if (!replan.applied) {
      logEvent(mission, 'supervisor', 'decision', 'No repair was possible; stopping the mission.');
      break;
    }
  }

  mission.stage = 'finalize';
  mission.status = 'reviewing';
  persist();
  const reviewOut = await finalReview(mission, run, verdict);
  mission.review = reviewOut;

  const passed = verdict?.verdict === 'on_target' && run?.status === 'passed';
  mission.status = mission.cancelRequested
    ? 'cancelled'
    : passed
    ? 'passed'
    : run?.status === 'failed'
    ? 'failed'
    : 'needs_review';
  mission.endedAt = now();
  mission.stage = 'done';
  writeMissionNote(mission, run, reviewOut);
  if (run) writeRunNote(run);

  if (run) recordShortcutOutcomes(mission, run);
  if (passed) {
    rememberPattern(mission);
    queueShortcutCandidates(mission, run, reviewOut);
    if (mission.conditions.autoReadyOnPass) {
      const workflow = db().workflows.find((entry) => entry.id === mission.workflowId);
      if (workflow && workflow.status === 'draft') {
        workflow.status = 'ready';
        workflow.updatedAt = now();
        logEvent(mission, 'reviewer', 'action', 'Workflow promoted to Ready by mission conditions.');
      }
    }
  }
  if (mission.verification?.nextActions?.length) {
    addSuggestion(
      `Mission on “${mission.workflowName}”: ${mission.verification.nextActions[0]}`,
      'mission',
      mission.workflowId,
      mission.lastRunId
    );
  }
  addSuggestion(
    `Mission “${mission.workflowName}” ${mission.status} after ${mission.attempts} attempt(s) — ${mission.verification?.verdict || 'unverified'}.`,
    'mission',
    mission.workflowId,
    mission.lastRunId
  );
  setSub(mission, 'reviewer', 'Notes', 'idle');
  setAgent(mission, 'reviewer', 'done', 'Review complete', reviewOut.summary);
  setAgent(mission, 'supervisor', 'done', 'Mission closed', `${mission.status} · ${mission.attempts} attempt(s)`);
  for (const agent of mission.pipeline) {
    for (const sub of agent.subAgents || []) sub.status = 'idle';
    if (agent.status === 'working') agent.status = 'idle';
  }
  persist();
  logEvent(mission, 'supervisor', 'result', `Mission ${mission.status} after ${mission.attempts} attempt(s).`);
  logActivity('mission', `Mission ${mission.status}: ${mission.workflowName}`, { missionId: mission.id });

  if (
    mission.status === 'failed' &&
    db().settings.autoActEnabled &&
    !mission.autoActScheduled &&
    Number(mission.autoActDepth || 0) < 2
  ) {
    mission.autoActScheduled = true;
    persist();
    logEvent(mission, 'habit-agent', 'proposal', 'Habit auto-act is evaluating the next route.');
    autoDecideMission(mission.id).catch((err) => logEvent(mission, 'habit-agent', 'error', `Auto-act failed: ${err.message}`));
  }
}

export function pauseMission(id) {
  const mission = findMission(id);
  if (!mission) throw new Error('Mission not found');
  mission.paused = true;
  const run = mission.lastRunId ? findRun(mission.lastRunId) : null;
  if (run && ['queued', 'running'].includes(run.status)) {
    try {
      controlRun(run.id, 'pause');
    } catch {
      // The run may have finished between the lookup and the control.
    }
  }
  logEvent(mission, 'supervisor', 'decision', 'Pause requested; holding the active run at the next step.');
  persist();
  return mission;
}

export function resumeMission(id) {
  const mission = findMission(id);
  if (!mission) throw new Error('Mission not found');
  mission.paused = false;
  const run = mission.lastRunId ? findRun(mission.lastRunId) : null;
  if (run && ['queued', 'running'].includes(run.status)) {
    try {
      controlRun(run.id, 'resume');
    } catch {
      // The run may have finished between the lookup and the control.
    }
  }
  logEvent(mission, 'supervisor', 'decision', 'Resumed.');
  persist();
  return mission;
}

export function controlMission(id, action) {
  const mission = findMission(id);
  if (!mission) throw new Error('Mission not found');
  const code = String(action || '').toLowerCase();
  if (!['pause', 'resume', 'continue', 'skip'].includes(code)) {
    throw new Error('Unknown mission control. Use pause, resume, continue or skip.');
  }
  if (code === 'pause') mission.paused = true;
  if (code === 'resume' || code === 'continue') mission.paused = false;
  let run = mission.lastRunId ? findRun(mission.lastRunId) : null;
  if (run && ['queued', 'running'].includes(run.status)) {
    try {
      run = controlRun(run.id, code);
    } catch (err) {
      logEvent(mission, 'supervisor', 'error', `Run control failed: ${err.message}`);
    }
  } else if (code === 'skip') {
    throw new Error('No active run to skip a step in.');
  }
  const label = code === 'skip' ? 'Skip requested for the current wait or next step.' : `Control ${code} applied.`;
  logEvent(mission, 'operator', 'decision', label);
  if (run) logEvent(mission, 'supervisor', 'action', `Run ${run.id} is ${run.status}${run.pauseRequested ? ' (paused at next boundary)' : ''}.`, { runId: run.id });
  persist();
  return { mission, run };
}

function startExtractionTest(mission, note, extraction) {
  const workflow = db().workflows.find((entry) => entry.id === mission.workflowId);
  if (!workflow) throw new Error('Workflow for this mission no longer exists');
  const test = createMission({
    workflowId: workflow.id,
    goal: `${mission.goal} — verify the extracted operator steps`,
    context: `Operator extraction from finished mission ${mission.id}: ${note}`,
    mode: mission.mode,
    trigger: 'operator-extraction',
    conditions: {
      ...mission.conditions,
      maxAttempts: 1,
      autoReplan: false,
      observeEnabled: true,
      autoApplyObserved: true,
    },
  });
  test.extractionSource = {
    missionId: mission.id,
    note,
    applied: extraction?.applied || 0,
    findings: extraction?.record?.summary || '',
  };
  persist();
  startMission(test.id);
  return test;
}

export async function sendMissionNote(id, text, options = {}) {
  const mission = findMission(id);
  if (!mission) throw new Error('Mission not found');
  const note = String(text || '').trim().slice(0, 2000);
  if (!note) throw new Error('Write a note before sending it.');
  const by = String(options.by || 'operator').slice(0, 80);
  mission.notes = mission.notes || [];
  mission.notes.unshift({ id: uid('note'), text: note, by, at: now(), applied: false });
  mission.notes = mission.notes.slice(0, 50);
  logEvent(mission, by, 'note', note);

  const apply = options.apply !== false;
  let queued = false;
  let replan = null;
  let extraction = null;
  let testMission = null;
  const run = mission.lastRunId ? findRun(mission.lastRunId) : null;
  if (apply) {
    if (mission.conditions.extractUserInput !== false) {
      try {
        extraction = await extractUserInput(mission, note, run);
      } catch (err) {
        logEvent(mission, 'input-extractor', 'error', `Could not extract concrete steps: ${err.message}`);
      }
    }
    const extracted = Number(extraction?.applied || 0);
    if (ACTIVE_STATUSES.includes(mission.status)) {
      if (extracted) {
        logEvent(mission, 'input-extractor', 'decision', 'Extracted steps are applied; the next supervisor attempt will test them on the live route.');
      } else {
        mission.pendingNote = note;
        queued = true;
        logEvent(mission, 'supervisor', 'decision', 'Note queued; it will steer the route before the next supervisor attempt.');
      }
    } else if (!extracted) {
      try {
        replan = await replanMission(mission, `Operator note: ${note}`, run);
        const entry = mission.notes.find((item) => item.text === note && item.by === by);
        if (entry) entry.applied = Boolean(replan?.applied);
        logEvent(
          mission,
          'planner',
          'decision',
          replan?.applied
            ? `Reprogrammed the route from the operator note: ${replan.summary || 'repair plan applied'}.`
            : 'Read the operator note, but found no safe route change.'
        );
      } catch (err) {
        logEvent(mission, 'planner', 'error', `Could not apply the note: ${err.message}`);
      }
    } else {
      const entry = mission.notes.find((item) => item.text === note && item.by === by);
      if (entry) entry.applied = true;
      logEvent(mission, 'input-extractor', 'decision', 'Concrete operator steps were added to the workflow and are ready for the next test run.');
      if (mission.conditions.autoTestExtracted !== false) {
        try {
          testMission = startExtractionTest(mission, note, extraction);
          if (extraction?.record) extraction.record.tested = testMission.id;
          logEvent(mission, 'input-extractor', 'action', `Extracted steps handed to test mission ${testMission.id}.`, {
            testMissionId: testMission.id,
          });
        } catch (err) {
          logEvent(mission, 'input-extractor', 'error', `Could not start the extracted-step test run: ${err.message}`);
        }
      }
    }
  }
  persist();
  return { mission, queued, replan, extraction, testMission };
}

export function cancelMission(id) {
  const mission = findMission(id);
  if (!mission) throw new Error('Mission not found');
  mission.cancelRequested = true;
  mission.paused = false;
  if (mission.lastRunId) cancelRun(mission.lastRunId);
  if (!ACTIVE.has(id)) {
    mission.status = 'cancelled';
    mission.endedAt = now();
    logEvent(mission, 'supervisor', 'result', 'Mission cancelled.');
  } else {
    logEvent(mission, 'supervisor', 'decision', 'Cancel requested; stopping after the current step.');
  }
  persist();
  logActivity('mission', `Mission cancelled: ${mission.workflowName}`, { missionId: id });
  return mission;
}

export async function checkMissionNow(id) {
  const mission = findMission(id);
  if (!mission) throw new Error('Mission not found');
  const run = mission.lastRunId ? findRun(mission.lastRunId) : null;
  const ref = await capture(mission, 'checkpoint', 'Manual checkpoint', run);
  mission.checks.unshift({
    at: now(),
    runId: run?.id || null,
    step: run?.steps.find((step) => step.status === 'running')?.name || run?.status || 'no active run',
    status: run?.status || 'idle',
    note: `manual checkpoint${ref ? '' : ' (capture failed)'}`,
    intervalMs: mission.conditions.checkIntervalMs,
    tick: mission.checks.length + 1,
  });
  logEvent(mission, 'supervisor', 'check', `Manual checkpoint at ${mission.stage}; run is ${run?.status || 'not started'}.`);
  persist();
  return { mission, reference: ref };
}

export async function replanMissionNow(id) {
  const mission = findMission(id);
  if (!mission) throw new Error('Mission not found');
  const run = mission.lastRunId ? findRun(mission.lastRunId) : null;
  const result = await replanMission(mission, 'Operator requested a replan', run);
  persist();
  return { mission, result };
}

const OPERATOR_COMMANDS = ['FORCE_REPLAN', 'OVERRIDE_PAUSE', 'OVERRIDE_RESUME', 'CANCEL', 'CHECKPOINT', 'RERUN'];

export async function operatorCommand(id, command, reason, by = 'admin') {
  const mission = findMission(id);
  if (!mission) throw new Error('Mission not found');
  const code = String(command || '').trim().toUpperCase();
  if (!OPERATOR_COMMANDS.includes(code)) {
    throw new Error(`Unknown operator command. Use one of: ${OPERATOR_COMMANDS.join(', ')}`);
  }
  mission.commands = mission.commands || [];
  mission.commands.unshift({
    id: uid('cmd'),
    command: code,
    reason: String(reason || '').slice(0, 400),
    by,
    at: now(),
  });
  mission.commands = mission.commands.slice(0, 20);
  logEvent(mission, 'supervisor', 'command', `Operator ${code}${reason ? `: ${reason}` : ''} (${by}).`);
  if (code === 'FORCE_REPLAN') {
    const run = mission.lastRunId ? findRun(mission.lastRunId) : null;
    const result = await replanMission(mission, `Operator FORCE_REPLAN${reason ? `: ${reason}` : ''}`, run);
    persist();
    return { mission, result };
  }
  if (code === 'OVERRIDE_PAUSE') {
    mission.paused = true;
    logEvent(mission, 'supervisor', 'decision', 'Operator override: mission paused.');
    persist();
    return { mission };
  }
  if (code === 'OVERRIDE_RESUME') {
    mission.paused = false;
    logEvent(mission, 'supervisor', 'decision', 'Operator override: mission resumed.');
    persist();
    return { mission };
  }
  if (code === 'CANCEL') return { mission: cancelMission(id) };
  if (code === 'CHECKPOINT') return checkMissionNow(id);
  if (code === 'RERUN') return { mission: retryMission(id) };
  return { mission };
}

function missionEvidence(mission) {
  const items = [];
  for (const ref of mission.references || []) {
    items.push({
      id: ref.id || uid('evd'),
      kind: ref.kind || 'screenshot',
      caption: ref.caption || 'Reference frame',
      path: ref.path,
      simulated: Boolean(ref.simulated),
      at: ref.at || mission.createdAt,
      runId: ref.runId || null,
      stepId: null,
      stepName: null,
    });
  }
  for (const cap of db().captures || []) {
    if (cap.missionId !== mission.id) continue;
    items.push({
      id: cap.id,
      kind: 'screenshot',
      caption: cap.caption || 'Manual capture',
      path: cap.path,
      simulated: Boolean(cap.simulated),
      at: cap.createdAt || mission.createdAt,
      runId: null,
      stepId: null,
      stepName: 'manual capture',
    });
  }
  for (const run of (mission.runs || []).map(findRun).filter(Boolean)) {
    for (const ev of run.evidence || []) {
      items.push({
        id: ev.id || uid('evd'),
        kind: ev.kind || 'screenshot',
        caption: ev.caption || 'Evidence',
        path: ev.path,
        simulated: Boolean(ev.simulated),
        at: ev.createdAt || run.createdAt,
        runId: run.id,
        stepId: ev.stepId || null,
        stepName: (run.steps || []).find((step) => step.id === ev.stepId)?.name || null,
      });
    }
  }
  const seen = new Set();
  return items
    .filter((item) => item.path && !seen.has(item.path) && seen.add(item.path))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function habitInsights(mission, lastRun) {
  const d = db();
  const terminal = d.runs.filter(
    (run) => run.workflowId === mission.workflowId && ['passed', 'failed', 'needs_review', 'cancelled'].includes(run.status)
  );
  const passed = terminal.filter((run) => run.status === 'passed').length;
  const passRate = terminal.length ? Math.round((passed / terminal.length) * 100) : null;
  const habits = [];
  if (passRate != null) {
    habits.push({
      id: 'workflow-pass-rate',
      label: `${mission.workflowName} pass rate`,
      confidence: passRate,
      detail: `${passed}/${terminal.length} terminal run(s) passed`,
      kind: 'workflow',
    });
  }
  if (lastRun?.failureSignature) {
    const repeats = terminal.filter((run) => run.failureSignature === lastRun.failureSignature).length;
    habits.push({
      id: 'failure-signature',
      label: `Failure signature repeats ×${repeats}`,
      confidence: Math.min(95, 45 + repeats * 15),
      detail: lastRun.failureSignature,
      kind: 'failure',
    });
  }
  for (const pattern of d.patterns || []) {
    const uses = Number(pattern.uses || 0);
    const wins = Number(pattern.wins || 0);
    if (!pattern.signature && !pattern.fixSteps?.length) continue;
    const confidence = uses > 0 ? Math.round((wins / uses) * 100) : Math.min(95, 55 + wins * 10);
    habits.push({
      id: pattern.id,
      label: pattern.signature ? `Learned fix: ${pattern.signature}` : 'Learned fix',
      confidence,
      detail: `${wins} win(s)${uses ? ` / ${uses} use(s)` : ''} · ${(pattern.fixSteps || []).length} step(s)`,
      kind: 'pattern',
    });
  }
  habits.sort((a, b) => b.confidence - a.confidence);

  const failureCounts = new Map();
  for (const run of terminal.filter((entry) => entry.status === 'failed')) {
    for (const step of run.steps || []) {
      if (step.status !== 'failed') continue;
      const key = `${step.type}:${step.name}`;
      const entry = failureCounts.get(key) || { key, label: step.name, type: step.type, failures: 0, error: step.error || '' };
      entry.failures++;
      entry.error = step.error || entry.error;
      failureCounts.set(key, entry);
    }
  }
  const exclusions = [...failureCounts.values()]
    .filter((entry) => entry.failures >= 2)
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 4)
    .map((entry) => ({
      ...entry,
      reason: `Failed ${entry.failures}× — exclude or replace this step before the next attempt.`,
    }));

  return { habits: habits.slice(0, 8), passRate, terminalRuns: terminal.length, exclusions };
}

function missionProposal(mission, opts) {
  const { habits, exclusions } = opts;
  const confidence = habits[0]?.confidence ?? Math.round((mission.verification?.confidence || 0) * 100);
  const threshold = Math.max(1, Math.min(100, Number(db().settings.autoActThreshold ?? 80)));
  const active = ACTIVE_STATUSES.includes(mission.status);
  const failed = ['failed', 'needs_review'].includes(mission.status);
  const passed = mission.status === 'passed';
  let proposal;
  if (active) {
    proposal = {
      action: 'continue',
      label: 'Continue monitoring',
      reason: 'The supervisor is still working; checks and captures keep accumulating.',
      confidence: 100,
      requiresApproval: false,
    };
  } else if (passed) {
    proposal = {
      action: 'present',
      label: 'Present the evidence',
      reason: 'The verifier accepted the run. Review the captures and file list before closing.',
      confidence,
      requiresApproval: false,
    };
  } else if (failed) {
    if (confidence >= threshold && habits.length) {
      proposal = {
        action: 'retry-alt',
        label: `Retry with habit · ${habits[0].label}`,
        reason: `${confidence}% confidence is at or above the ${threshold}% auto-act threshold. ${habits[0].detail}`,
        confidence,
        requiresApproval: false,
      };
    } else {
      proposal = {
        action: 'ask',
        label: 'Ask for an alternative path',
        reason: `No habit reaches the ${threshold}% auto-act threshold. Queue the question for a human or the main AI.`,
        confidence,
        requiresApproval: true,
      };
    }
  } else {
    proposal = {
      action: 'retry',
      label: 'Retry the mission',
      reason: 'The session ended without a pass; retry from a fresh budget.',
      confidence,
      requiresApproval: false,
    };
  }
  const autoAct = {
    enabled: Boolean(db().settings.autoActEnabled),
    threshold,
    confidence,
    eligible: Boolean(
      db().settings.autoActEnabled &&
        failed &&
        confidence >= threshold &&
        ['retry', 'retry-alt'].includes(proposal.action)
    ),
  };
  const questions = failed
    ? [
        {
          id: 'q-next',
          prompt: `The session stopped at “${mission.lastRunId || 'no run'}”. Continue with the habit, retry with an alternative path, change the goal, or stop?`,
          options: ['retry', 'retry-alt', 'alt-goal', 'stop'],
          exclusions,
        },
      ]
    : [];
  return { proposal, confidence, autoAct, questions };
}

export function missionPresentation(id) {
  const mission = findMission(id);
  if (!mission) throw new Error('Mission not found');
  const runs = (mission.runs || []).map(findRun).filter(Boolean);
  const lastRun = mission.lastRunId ? findRun(mission.lastRunId) : runs[runs.length - 1];
  const evidence = missionEvidence(mission);
  const habitInfo = habitInsights(mission, lastRun);
  const { proposal, confidence, autoAct, questions } = missionProposal(mission, habitInfo);
  const workpoints = runs.map((run) => ({
    runId: run.id,
    agentRole: run.agentRole || 'operator',
    status: run.status,
    retryCount: Number(run.retryCount || 0),
    errorCategory: run.errorCategory || null,
    steps: (run.steps || []).map((step) => ({
      id: step.id,
      name: step.name,
      type: step.type,
      status: step.status,
      optional: Boolean(step.optional),
      error: step.error || null,
      output: String(step.output || '').slice(0, 300),
      evidenceCount: (step.evidenceIds || []).length,
      ms: step.ms || null,
    })),
  }));
  const elements = [
    { label: 'Goal', value: mission.goal },
    { label: 'Expected', value: mission.frame?.expectation || 'Not recorded' },
    { label: 'Verdict', value: `${mission.verification?.verdict || 'pending'}${mission.verification?.confidence != null ? ` · ${Math.round(mission.verification.confidence * 100)}%` : ''}` },
    { label: 'Last run', value: lastRun ? `${lastRun.id} · ${lastRun.status}` : 'No run yet' },
    { label: 'Replans', value: `${(mission.replans || []).length}` },
    { label: 'References', value: `${(mission.references || []).length}` },
  ];
  for (const finding of mission.verification?.findings || []) elements.push({ label: 'Finding', value: finding });
  for (const action of mission.verification?.nextActions || []) elements.push({ label: 'Next action', value: action });

  return {
    id: mission.id,
    goal: mission.goal,
    context: mission.context || '',
    workflowId: mission.workflowId,
    workflowName: mission.workflowName,
    status: mission.status,
    stage: mission.stage,
    paused: Boolean(mission.paused),
    mode: mission.mode,
    attempts: mission.attempts,
    maxAttempts: mission.maxAttempts,
    createdAt: mission.createdAt,
    endedAt: mission.endedAt,
    verdict: mission.verification?.verdict || null,
    confidence: mission.verification?.confidence ?? null,
    summary: mission.verification?.summary || '',
    review: mission.review || null,
    elements,
    workpoints,
    evidence,
    files: evidence.map((item) => ({
      id: item.id,
      caption: item.caption,
      path: item.path,
      simulated: item.simulated,
      at: item.at,
      runId: item.runId,
      stepName: item.stepName,
      url: `/api/files/raw?path=${encodeURIComponent(item.path)}`,
    })),
    conversation: (mission.events || [])
      .slice()
      .reverse()
      .map((evt) => ({ id: evt.id, at: evt.at, agent: evt.agent, kind: evt.kind, message: evt.message, severity: evt.severity || null })),
    decisions: mission.decisions || [],
    questions: [...(mission.questions || []), ...questions],
    habits: habitInfo.habits,
    passRate: habitInfo.passRate,
    exclusions: habitInfo.exclusions,
    proposal,
    autoAct,
    analysis: lastRun?.analysis || null,
  };
}

export async function decideMission(id, options = {}) {
  const mission = findMission(id);
  if (!mission) throw new Error('Mission not found');
  const action = String(options.action || '').trim().toLowerCase();
  const instruction = String(options.instruction || options.reason || '').slice(0, 800);
  const by = String(options.by || 'operator').slice(0, 80);
  const allowed = ['continue', 'retry', 'retry-alt', 'alt-goal', 'alt-workflow', 'stop', 'ask', 'present'];
  if (!allowed.includes(action)) throw new Error(`Unknown decision. Use one of: ${allowed.join(', ')}`);
  mission.decisions = mission.decisions || [];
  mission.decisions.unshift({
    id: uid('dec'),
    action,
    instruction,
    by,
    at: now(),
  });
  mission.decisions = mission.decisions.slice(0, 30);
  logEvent(mission, by, 'decision', `Decision ${action}${instruction ? `: ${instruction}` : ''}.`);

  if (action === 'continue') {
    if (!ACTIVE_STATUSES.includes(mission.status)) {
      throw new Error('This session has finished. Retry it or change the goal instead of continuing.');
    }
    if (mission.paused) resumeMission(id);
    const activeRun = mission.lastRunId ? findRun(mission.lastRunId) : null;
    if (activeRun && ['queued', 'running'].includes(activeRun.status)) {
      try {
        controlRun(activeRun.id, 'continue');
      } catch {
        // The run may have finished between the lookup and the control.
      }
    }
  } else if (action === 'present') {
    // Presentation is a review-only decision; it is recorded for the audit trail.
  } else if (action === 'ask') {
    mission.questions = mission.questions || [];
    mission.questions.unshift({
      id: uid('q'),
      prompt: instruction || 'The supervisor needs a decision to continue.',
      at: now(),
      by,
    });
    mission.questions = mission.questions.slice(0, 20);
  } else if (action === 'stop') {
    cancelMission(id);
  } else if (action === 'retry') {
    const next = retryMission(id);
    next.autoActDepth = Number(mission.autoActDepth || 0) + 1;
    next.autoActSource = mission.id;
    persist();
    return { mission: next, source: missionSummary(mission), action };
  } else if (action === 'retry-alt') {
    const run = mission.lastRunId ? findRun(mission.lastRunId) : null;
    let replan = null;
    if (run?.status === 'failed') {
      replan = await replanMission(
        mission,
        `Alternative path${instruction ? `: ${instruction}` : ''} — use a different route, wait for the target element and re-capture before retrying.`,
        run
      );
    }
    const next = retryMission(id);
    next.autoActDepth = Number(mission.autoActDepth || 0) + 1;
    next.autoActSource = mission.id;
    persist();
    return { mission: next, source: missionSummary(mission), action, replan };
  } else if (action === 'alt-goal') {
    const goal = String(options.goal || instruction || mission.goal).trim();
    if (!goal) throw new Error('An alternative goal is required');
    const next = createMission({
      workflowId: mission.workflowId,
      goal,
      mode: mission.mode,
      conditions: { ...mission.conditions, maxAttempts: mission.maxAttempts },
      trigger: 'decision',
    });
    startMission(next.id);
    persist();
    return { mission: findMission(next.id), source: missionSummary(mission), action };
  } else if (action === 'alt-workflow') {
    const workflow = db().workflows.find((entry) => entry.id === options.workflowId);
    if (!workflow) throw new Error('Pick an alternative workflow');
    const goal = String(options.goal || instruction || mission.goal).trim();
    const next = createMission({
      workflowId: workflow.id,
      goal,
      mode: mission.mode,
      conditions: { ...mission.conditions, maxAttempts: mission.maxAttempts },
      trigger: 'decision',
    });
    startMission(next.id);
    persist();
    return { mission: findMission(next.id), source: missionSummary(mission), action };
  }
  persist();
  return { mission: findMission(id), action };
}

export async function autoDecideMission(id) {
  const presentation = missionPresentation(id);
  if (!presentation.autoAct.enabled) {
    return { acted: false, reason: 'Auto-act is disabled in Settings.', presentation };
  }
  if (!presentation.autoAct.eligible) {
    return {
      acted: false,
      reason: `Confidence ${presentation.autoAct.confidence}% is below the ${presentation.autoAct.threshold}% threshold or the session is not retryable.`,
      presentation,
    };
  }
  const result = await decideMission(id, {
    action: presentation.proposal.action,
    instruction: `Habit auto-act at ${presentation.autoAct.confidence}%: ${presentation.proposal.label}`,
    by: 'habit-agent',
  });
  return { acted: true, ...result, presentation };
}

export function retryMission(id) {
  const original = findMission(id);
  if (!original) throw new Error('Mission not found');
  const mission = createMission({
    workflowId: original.workflowId,
    goal: original.goal,
    mode: original.mode,
    conditions: { ...original.conditions, maxAttempts: original.maxAttempts },
    trigger: 'retry',
  });
  startMission(mission.id);
  return mission;
}

export function recoverMissions() {
  let changed = 0;
  for (const mission of db().missions) {
    if (!ACTIVE_STATUSES.includes(mission.status)) continue;
    mission.status = 'failed';
    mission.stage = 'interrupted';
    mission.endedAt = now();
    logEvent(mission, 'supervisor', 'error', 'Console restarted before the mission finished.');
    for (const agent of mission.pipeline) {
      if (agent.status === 'working') agent.status = 'error';
      for (const sub of agent.subAgents || []) if (sub.status === 'working') sub.status = 'idle';
    }
    changed++;
  }
  if (changed) persist();
  return changed;
}
