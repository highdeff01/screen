import { db, persist, uid, now } from './store.js';
import { signatureHash } from './visual.js';

const MAX_EPISODES = 120;
const RECENCY_HALF_LIFE_HOURS = 10;
const RECENCY_WEIGHT = 0.16;
const TREND_WEIGHT = 0.04;
const STOP = new Set(['the', 'and', 'then', 'with', 'into', 'from', 'for', 'this', 'that', 'what', 'when', 'where', 'while', 'about', 'after', 'before', 'using', 'use', 'your', 'you', 'its', 'it', 'is', 'are', 'a', 'an', 'to', 'of', 'in', 'on', 'or', 'as', 'by', 'be', 'can', 'should']);
const GENERIC = new Set([
  'ask', 'question', 'questions', 'kiro', 'notepad', 'save', 'saved', 'answer', 'answers', 'copy', 'open', 'paste',
  'file', 'files', 'desktop', 'chat', 'chats', 'session', 'sessions', 'conversation', 'new', 'start', 'starts', 'current',
  'visible', 'reuse', 'only', 'already', 'present', 'then', 'latest', 'capture', 'screen', 'type', 'wait', 'focus',
  'verify', 'response', 'result', 'message', 'messages', 'text', 'content', 'read', 'write', 'app', 'application',
  'window', 'click', 'press', 'key', 'keys', 'shortcut', 'please', 'properly', 'correctly', 'successfully', 'again',
]);

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP.has(token));
}

function tokenSet(text) {
  return new Set(tokens(text));
}

function overlapScore(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / Math.max(1, Math.min(left.size, right.size));
}

function topicScore(query, target) {
  const wanted = new Set(tokens(query).filter((token) => !GENERIC.has(token)));
  if (!wanted.size) return 0.5;
  const available = new Set(tokens(target));
  for (const token of wanted) if (!available.has(token)) return 0;
  return 1;
}

function goalSubject(text) {
  const value = String(text || '');
  const phrases = value.matchAll(/\b(?:about|what is|what's|what are|tell me about|explain)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9 _-]{0,60})/gi);
  for (const match of phrases) {
    const found = tokens(match[1]).find((token) => !GENERIC.has(token));
    if (found) return found;
  }
  const clause = value.split(/[,.;]|\bthen\b/i)[0];
  return tokens(clause).find((token) => !GENERIC.has(token)) || null;
}

function recencyScore(createdAt, nowMs = Date.now()) {
  const timestamp = Date.parse(createdAt || '');
  if (!Number.isFinite(timestamp)) return 0;
  const reference = Number(nowMs);
  const ageHours = Math.max(0, ((Number.isFinite(reference) ? reference : Date.now()) - timestamp) / 3600000);
  return Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS);
}

function successTrend(episode, episodes = []) {
  const subject = goalSubject(episode.goal);
  const peers = episodes
    .filter((entry) => entry.workflowId && entry.workflowId === episode.workflowId && (!subject || goalSubject(entry.goal) === subject))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 5);
  if (peers.length < 2) return 0;
  const passRate = peers.filter((entry) => entry.status === 'passed').length / peers.length;
  const latest = peers[0].status === 'passed' ? 1 : -1;
  return Math.round((((passRate * 2) - 1) * 0.5 + latest * 0.5) * 1000) / 1000;
}

function versionMismatch(episode, app = {}) {
  const current = String(app?.version || '').trim().toLowerCase();
  if (!current) return false;
  const versions = episode.appVersions || {};
  const keys = [app?.process, app?.name]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  for (const key of keys) {
    const remembered = String(versions[key] || '').trim().toLowerCase();
    if (remembered) return remembered !== current;
  }
  return false;
}

function subjectScore(episode) {
  const subject = goalSubject(episode.goal);
  if (!subject) return 1;
  const typed = (episode.steps || [])
    .filter((step) => step.type === 'type')
    .map((step) => String(step.params?.text || ''))
    .join(' ')
    .toLowerCase();
  if (!typed) return 1;
  return typed.includes(subject) ? 1 : 0;
}

function missionFor(run) {
  return run?.missionId ? db().missions.find((mission) => mission.id === run.missionId) || null : null;
}

function stepPlan(step) {
  return {
    type: step.type,
    name: String(step.name || '').slice(0, 120),
    params: { ...(step.params || {}) },
    condition: step.condition || null,
    optional: Boolean(step.optional),
  };
}

function hindrancesFor(run) {
  const out = [];
  for (const step of run.steps || []) {
    const label = `${step.name || step.type} (${step.type})`;
    if (step.status === 'failed' && step.error) out.push(`${label}: ${String(step.error).slice(0, 220)}`);
    if (step.audit?.level === 'warning' && step.audit.message) out.push(`${label}: ${String(step.audit.message).slice(0, 220)}`);
    if (/via vision|fallback coordinates/i.test(String(step.output || ''))) out.push(`${label}: needed a visual/coordinate fallback.`);
    if (/clipboard.*(unchanged|below)|did not change/i.test(String(step.error || ''))) out.push(`${label}: clipboard freshness failed.`);
  }
  return [...new Set(out)].slice(0, 12);
}

export function episodeFromRun(run, workflow = null) {
  if (!run || !['passed', 'failed', 'needs_review', 'cancelled'].includes(run.status)) return null;
  const wf = workflow || db().workflows.find((entry) => entry.id === run.workflowId) || null;
  const mission = missionFor(run);
  const steps = (run.steps || []).map((step) => {
    const plan = stepPlan(step);
    for (const [key, value] of Object.entries(plan.params || {})) {
      if (typeof value === 'string' && value.length > 2000) plan.params[key] = value.slice(0, 2000);
    }
    return {
      ...plan,
      status: step.status,
      output: String(step.output || '').slice(0, 240),
    };
  });
  const visual = (run.steps || [])
    .filter((step) => step.visual)
    .map((step) => ({
      step: step.name,
      type: step.type,
      changedPct: Number(step.visual.changedPct) || 0,
      meanDelta: Number(step.visual.meanDelta) || 0,
      noVisibleChange: Boolean(step.visual.noVisibleChange),
      warning: step.audit?.level === 'warning',
      failed: step.status === 'failed',
    }))
    .slice(0, 30);
  const passed = (run.steps || []).filter((step) => step.status === 'passed').length;
  const total = Math.max(1, (run.steps || []).length);
  const goal = String(mission?.goal || wf?.description || wf?.name || run.workflowName || '').trim();
  const apps = [...new Set(
    (run.steps || [])
      .map((step) => step.appContext?.process || step.appContext?.title || step.params?.foreground || step.params?.window || step.params?.title || step.params?.target || '')
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )].slice(0, 8);
  const appVersions = {};
  for (const step of run.steps || []) {
    const process = String(step.appContext?.process || '').trim().toLowerCase();
    const version = String(step.appContext?.version || '').trim();
    if (process && version && !appVersions[process]) appVersions[process] = version;
  }
  const episode = {
    id: uid('mem'),
    runId: run.id,
    workflowId: run.workflowId || null,
    workflowName: wf?.name || run.workflowName || 'Workflow',
    goal,
    mode: run.dryRun ? 'simulated' : 'live',
    status: run.status,
    quality: Math.round(((passed / total) * 0.8 + (run.status === 'passed' ? 0.2 : 0)) * 100) / 100,
    passed,
    total: run.steps?.length || 0,
    apps,
    appVersions,
    steps,
    visual,
    hindrances: hindrancesFor(run),
    evidence: (run.evidence || []).filter((item) => item.kind === 'screenshot').slice(-4).map((item) => ({
      caption: item.caption || '',
      path: item.path || '',
    })),
    signature: signatureHash({ cells: (run.steps || []).map((step) => `${step.type}|${step.name}|${step.status}`) }),
    createdAt: run.endedAt || run.createdAt || now(),
  };
  return episode;
}

function ensureStore() {
  const d = db();
  if (!Array.isArray(d.workflowMemory)) d.workflowMemory = [];
  return d;
}

export function backfillWorkflowMemory({ force = false } = {}) {
  const d = ensureStore();
  if (d.workflowMemory.length && !force) return d.workflowMemory;
  const episodes = [];
  for (const run of d.runs) {
    const episode = episodeFromRun(run);
    if (episode) episodes.push(episode);
    if (episodes.length >= MAX_EPISODES) break;
  }
  d.workflowMemory = episodes;
  persist();
  return d.workflowMemory;
}

export function forgetWorkflowMemory(workflowId) {
  if (!workflowId) return 0;
  const d = ensureStore();
  const before = d.workflowMemory.length;
  d.workflowMemory = d.workflowMemory.filter((entry) => entry.workflowId !== workflowId);
  if (d.workflowMemory.length !== before) persist();
  return before - d.workflowMemory.length;
}

export function rememberRun(run, workflow = null) {
  if (!run) return null;
  const episode = episodeFromRun(run, workflow);
  if (!episode) return null;
  const d = ensureStore();
  d.workflowMemory = d.workflowMemory.filter((entry) => entry.runId !== run.id);
  d.workflowMemory.unshift(episode);
  d.workflowMemory = d.workflowMemory.slice(0, MAX_EPISODES);
  persist();
  return episode;
}

function scoreEpisode(episode, { goal, workflow, app, episodes = [], nowMs = Date.now() }) {
  const query = `${goal || ''} ${workflow?.name || ''} ${workflow?.description || ''}`;
  const target = `${episode.goal || ''} ${episode.workflowName || ''} ${(episode.steps || []).map((step) => `${step.type} ${step.name}`).join(' ')}`;
  const textScore = overlapScore(query, target);
  const topic = topicScore(goal, `${episode.goal || ''} ${episode.workflowName || ''}`);
  const subject = subjectScore(episode);
  const appName = String(app?.name || app?.process || '').toLowerCase();
  const appScore = appName && (episode.apps || []).some((entry) => entry.toLowerCase().includes(appName)) ? 1 : 0;
  const workflowScore = workflow?.id && episode.workflowId === workflow.id ? 1 : 0;
  const stepTypes = new Set((workflow?.steps || []).map((step) => step.type));
  const episodeTypes = new Set((episode.steps || []).map((step) => step.type));
  let typeOverlap = 0;
  if (stepTypes.size && episodeTypes.size) {
    let shared = 0;
    for (const type of stepTypes) if (episodeTypes.has(type)) shared++;
    typeOverlap = shared / Math.max(1, Math.min(stepTypes.size, episodeTypes.size));
  }
  const statusBoost = episode.status === 'passed' ? 0.06 : 0;
  const visualWarnings = (episode.visual || []).filter((item) => item.warning).length;
  const penalty = Math.min(0.2, (episode.hindrances || []).length * 0.025 + visualWarnings * 0.01);
  const recency = recencyScore(episode.createdAt, nowMs);
  const trend = successTrend(episode, episodes);
  const versionBlocked = versionMismatch(episode, app);
  const score = Math.max(0, Math.min(0.99,
    textScore * 0.42 +
    appScore * 0.12 +
    workflowScore * 0.1 +
    typeOverlap * 0.1 +
    (episode.quality || 0) * 0.14 +
    recency * RECENCY_WEIGHT +
    trend * TREND_WEIGHT +
    statusBoost -
    penalty
  ));
  return {
    score: Math.round(score * 1000) / 1000,
    textScore: Math.round(textScore * 1000) / 1000,
    topicScore: topic,
    subjectScore: subject,
    appScore,
    recency: Math.round(recency * 1000) / 1000,
    trend,
    versionMismatch: versionBlocked,
  };
}

export function recallWorkflowMemory({ goal = '', workflow = null, app = null, limit = 3, minScore = 0.18, nowMs = Date.now() } = {}) {
  const d = ensureStore();
  if (!d.workflowMemory.length) backfillWorkflowMemory();
  return (d.workflowMemory || [])
    .map((episode) => ({ ...episode, ...scoreEpisode(episode, { goal, workflow, app, episodes: d.workflowMemory, nowMs }) }))
    .filter((episode) => !episode.versionMismatch && episode.score >= minScore && episode.topicScore !== 0 && episode.subjectScore !== 0)
    .sort((a, b) => b.score - a.score || (b.quality || 0) - (a.quality || 0) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(8, Number(limit) || 3)));
}

/**
 * Find a passed sequence by the apps it touches, not by question subject.
 * This is a template for the same source/destination pattern, not an exact
 * question reuse; the caller must replace the typed question before running.
 */
export function recallWorkflowTemplate({ apps = [], versions = {}, limit = 1 } = {}) {
  const d = ensureStore();
  const wanted = (Array.isArray(apps) ? apps : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return null;
  const currentVersions = Object.fromEntries(
    Object.entries(versions || {})
      .map(([key, value]) => [String(key).toLowerCase(), String(value || '').trim().toLowerCase()])
      .filter(([, value]) => value)
  );
  return (d.workflowMemory || [])
    .filter((entry) =>
      entry.status === 'passed' &&
      entry.mode === 'live' &&
      (entry.quality || 0) >= 0.8 &&
      !Object.entries(entry.appVersions || {}).some(([app, version]) =>
        currentVersions[String(app).toLowerCase()] &&
        currentVersions[String(app).toLowerCase()] !== String(version || '').toLowerCase()
      ) &&
      wanted.every((name) => (entry.apps || []).some((app) => String(app).toLowerCase().includes(name)))
    )
    .sort((a, b) => (b.quality || 0) - (a.quality || 0) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(3, Number(limit) || 1)))[0] || null;
}

export function formatWorkflowMemory(memories, maxSteps = 8) {
  if (!Array.isArray(memories) || !memories.length) return 'No prior workflow memory matched this goal.';
  return memories
    .map((memory) => {
      const steps = (memory.steps || [])
        .slice(0, maxSteps)
        .map((step, index) => {
          const hints = [
            step.params?.text ? `text="${String(step.params.text).slice(0, 120)}"` : '',
            step.params?.title ? `title="${String(step.params.title).slice(0, 80)}"` : '',
            step.params?.keys ? `keys="${String(step.params.keys).slice(0, 40)}"` : '',
            step.params?.target ? `target="${String(step.params.target).slice(0, 80)}"` : '',
          ].filter(Boolean);
          return `${index + 1}.${step.type}:${step.name}${hints.length ? ` {${hints.join(', ')}}` : ''}${step.status && step.status !== 'passed' ? ` [${step.status}]` : ''}`;
        })
        .join(' -> ');
      const visual = (memory.visual || [])
        .filter((item) => item.warning || item.failed)
        .slice(0, 4)
        .map((item) => `${item.step}: no visible change`)
        .join('; ');
      return [
        `- ${Math.round((memory.score || 0) * 100)}% match · ${memory.workflowName} · ${memory.mode} · ${memory.status} · ${memory.passed}/${memory.total} steps`,
        memory.goal ? `  Goal: ${String(memory.goal).slice(0, 240)}` : '',
        steps ? `  Validated sequence: ${steps}` : '',
        memory.hindrances?.length ? `  Hindrances: ${memory.hindrances.join(' | ').slice(0, 500)}` : '',
        visual ? `  Visual checks: ${visual}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n');
}

export function planStepsFromMemory(memory, maxSteps = 24) {
  if (!memory || !Array.isArray(memory.steps) || !memory.steps.length) return [];
  return memory.steps
    .slice(0, Math.max(1, Math.min(24, maxSteps)))
    .map((step) => ({
      type: step.type,
      name: step.name,
      params: { ...(step.params || {}) },
      condition: step.condition || null,
      optional: Boolean(step.optional),
    }));
}

export function summarizeWorkflowMemory() {
  const d = ensureStore();
  return {
    count: d.workflowMemory.length,
    passed: d.workflowMemory.filter((entry) => entry.status === 'passed').length,
    recent: d.workflowMemory.slice(0, 6).map((entry) => ({
      id: entry.id,
      workflowId: entry.workflowId,
      workflowName: entry.workflowName,
      mode: entry.mode,
      status: entry.status,
      quality: entry.quality,
      hindrances: (entry.hindrances || []).length,
      visualWarnings: (entry.visual || []).filter((item) => item.warning).length,
      createdAt: entry.createdAt,
    })),
  };
}

export function listWorkflowMemory({ workflowId = '', status = '', limit = 40 } = {}) {
  const d = ensureStore();
  if (!d.workflowMemory.length) backfillWorkflowMemory();
  const count = Math.max(1, Math.min(100, Number(limit) || 40));
  const episodes = d.workflowMemory
    .filter((entry) => (!workflowId || entry.workflowId === workflowId) && (!status || entry.status === status))
    .slice(0, count)
    .map((entry) => ({
      id: entry.id,
      runId: entry.runId,
      workflowId: entry.workflowId,
      workflowName: entry.workflowName,
      goal: entry.goal,
      mode: entry.mode,
      status: entry.status,
      quality: entry.quality,
      passed: entry.passed,
      total: entry.total,
      apps: entry.apps || [],
      steps: (entry.steps || []).map((step) => ({
        type: step.type,
        name: step.name,
        status: step.status,
        condition: step.condition || null,
        optional: Boolean(step.optional),
        detail: String(step.params?.text || step.params?.title || step.params?.target || step.params?.keys || '').slice(0, 180),
      })),
      visual: (entry.visual || []).slice(0, 16),
      hindrances: (entry.hindrances || []).slice(0, 12),
      evidence: (entry.evidence || []).slice(0, 4),
      createdAt: entry.createdAt,
    }));
  return { count: d.workflowMemory.length, episodes };
}
