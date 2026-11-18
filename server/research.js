import fs from 'node:fs';
import path from 'node:path';
import { DATA, db, resolveInside } from './store.js';
import { getHistory } from './llm.js';
import { recallWorkflowMemory } from './workflow-memory.js';

const MAX_CONVERSATION = 14;
const MAX_FAILED = 8;
const MAX_PASSED = 4;
const MAX_SCREENSHOTS = 12;
const MAX_WORKFLOWS = 20;
const MAX_IMAGE_BYTES = 1_700_000;
const STOP = new Set([
  'the', 'and', 'then', 'than', 'with', 'into', 'from', 'for', 'this', 'that', 'what', 'when', 'where',
  'while', 'about', 'after', 'before', 'using', 'use', 'your', 'you', 'its', 'it', 'is', 'are', 'a',
  'an', 'to', 'of', 'in', 'on', 'or', 'as', 'by', 'be', 'can', 'should', 'open', 'launch', 'start',
  'save', 'answer', 'file', 'desktop', 'ask', 'copy', 'paste', 'type', 'wait', 'focus', 'verify',
]);

function clip(value, max = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function tokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP.has(token));
}

export function normalizeMarks(raw = []) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, 12)
    .map((mark, index) => {
      const x = Number(mark?.x);
      const y = Number(mark?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return {
        number: index + 1,
        label: clip(mark?.label || `Mark ${index + 1}`, 60),
        x: Math.max(0, Math.min(100, Math.round(x * 10) / 10)),
        y: Math.max(0, Math.min(100, Math.round(y * 10) / 10)),
      };
    })
    .filter(Boolean);
}

function isFailure(run) {
  return ['failed', 'needs_review', 'cancelled'].includes(run?.status);
}

function stepText(step) {
  return `${step?.type || ''} ${step?.name || ''} ${JSON.stringify(step?.params || {})}`;
}

function runText(run) {
  return [
    run?.workflowName,
    run?.goal,
    ...(run?.steps || []).map(stepText),
  ].filter(Boolean).join(' ');
}

function looksRelated(run, workflow, goal, appNames) {
  if (workflow?.id && run.workflowId === workflow.id) return true;
  const haystack = runText(run).toLowerCase();
  const wanted = tokens(goal);
  if (wanted.some((token) => haystack.includes(token))) return true;
  return appNames.some((name) => name && haystack.includes(name));
}

export function stepMarks(run, evidence) {
  if (Array.isArray(evidence?.marks)) {
    return normalizeMarks(evidence.marks).slice(0, 4);
  }
  const step = (run?.steps || []).find((entry) => entry.id === evidence.stepId);
  if (!step || !Number(evidence.width) || !Number(evidence.height)) return [];
  const width = Number(evidence.width);
  const height = Number(evidence.height);
  const params = step.params || {};
  const coordinates = [];
  if (Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y))) {
    coordinates.push({ x: Number(params.x), y: Number(params.y), label: step.name || step.type });
  }
  if (Number.isFinite(Number(params.x1)) && Number.isFinite(Number(params.y1))) {
    coordinates.push({ x: Number(params.x1), y: Number(params.y1), label: step.name || step.type });
  }
  return coordinates
    .map((mark, index) => ({
      number: index + 1,
      label: clip(mark.label, 60),
      x: Math.max(0, Math.min(100, Math.round((mark.x / width) * 1000) / 10)),
      y: Math.max(0, Math.min(100, Math.round((mark.y / height) * 1000) / 10)),
    }))
    .slice(0, 4);
}

function screenshotsFor(run) {
  if (!run) return [];
  return (run.evidence || [])
    .filter((item) => item?.path && (item.kind === 'screenshot' || /\.(?:png|jpe?g|webp)$/i.test(item.path)))
    .slice(-3)
    .map((item) => ({
      runId: run.id,
      workflowId: run.workflowId || null,
      workflowName: run.workflowName || 'Workflow',
      runStatus: run.status,
      simulated: Boolean(item.simulated),
      caption: clip(item.caption || 'Run evidence', 160),
      path: item.path,
      width: item.width || null,
      height: item.height || null,
      createdAt: item.createdAt || run.endedAt || run.createdAt || null,
      marks: stepMarks(run, item),
    }));
}

function failedDetail(run, episode = null) {
  const failed = (run.steps || [])
    .filter((step) => step.status === 'failed')
    .map((step) => `${step.name || step.type}: ${clip(step.error || step.output || 'failed', 220)}`);
  const hindrances = episode?.hindrances || [];
  return {
    runId: run.id,
    workflowId: run.workflowId || null,
    workflowName: run.workflowName || 'Workflow',
    status: run.status,
    mode: run.dryRun ? 'simulated' : 'live',
    goal: clip(run.goal || '', 300),
    at: run.endedAt || run.createdAt || null,
    failureSignature: clip(run.failureSignature || run.analysis?.summary || '', 260),
    failed: failed.slice(0, 6),
    hindrances: hindrances.slice(0, 6),
    plan: (run.steps || []).slice(0, 12).map((step) => `${step.type || 'step'}: ${clip(step.name, 100)}`),
  };
}

function workflowHistory(workflow) {
  const d = db();
  return d.workflows
    .map((entry) => {
      const runs = d.runs.filter((run) => run.workflowId === entry.id);
      const latest = runs[0] || null;
      return {
        id: entry.id,
        name: entry.name,
        status: entry.status,
        steps: (entry.steps || []).length,
        runs: runs.length,
        passed: runs.filter((run) => run.status === 'passed').length,
        failed: runs.filter(isFailure).length,
        current: entry.id === workflow?.id,
        lastStatus: latest?.status || null,
        lastAt: latest?.endedAt || latest?.createdAt || entry.updatedAt || null,
      };
    })
    .sort((a, b) => Number(b.current) - Number(a.current) || String(b.lastAt || '').localeCompare(String(a.lastAt || '')))
    .slice(0, MAX_WORKFLOWS);
}

function conversationSlice() {
  return getHistory()
    .slice(-MAX_CONVERSATION)
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: clip(message.content, 700),
    }))
    .filter((message) => message.content);
}

function imagePayload(screenshots) {
  const images = [];
  const seen = new Set();
  for (const shot of screenshots) {
    if (images.length >= 2 || !shot.path || seen.has(shot.path) || shot.simulated) continue;
    seen.add(shot.path);
    const resolved = resolveInside(DATA, shot.path);
    if (!resolved) continue;
    try {
      const buffer = fs.readFileSync(resolved);
      if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) continue;
      images.push(buffer.toString('base64'));
    } catch {
      // A missing old capture must not block research.
    }
  }
  return images;
}

function promptFor(research) {
  const lines = [];
  if (research.conversation.length) {
    lines.push('RECENT OPERATOR CONVERSATION (the user’s wording and previous corrections):');
    for (const message of research.conversation) lines.push(`- ${message.role}: ${message.content}`);
  }
  if (research.failedAttempts.length) {
    lines.push('FAILED / ABANDONED ATTEMPTS FOR THIS INPUT (do not repeat their order, target app, or failure signature):');
    for (const item of research.failedAttempts) {
      lines.push(
        `- ${item.workflowName} · ${item.status} · ${item.mode} · ${item.at || 'time unknown'}` +
          `${item.goal ? ` · goal: ${item.goal}` : ''}`
      );
      if (item.failureSignature) lines.push(`  Failure: ${item.failureSignature}`);
      if (item.failed.length) lines.push(`  Failed steps: ${item.failed.join(' | ')}`);
      if (item.hindrances.length) lines.push(`  Hindrances: ${item.hindrances.join(' | ')}`);
      if (item.plan.length) lines.push(`  Previous order: ${item.plan.join(' -> ')}`);
    }
  }
  if (research.passedAttempts.length) {
    lines.push('PASSED ATTEMPTS (reuse proven controls and order, not their old question text):');
    for (const item of research.passedAttempts) {
      lines.push(`- ${item.workflowName} · ${item.total} steps · ${item.plan.slice(0, 10).join(' -> ')}`);
    }
  }
  if (research.screenshots.length) {
    lines.push('PAST SCREENSHOTS (caption, path and numbered click markers; use them as visual evidence):');
    for (const shot of research.screenshots) {
      const marks = shot.marks.length
        ? ` marks=${shot.marks.map((mark) => `${mark.number}:${mark.label}@${mark.x}%,${mark.y}%`).join(', ')}`
        : '';
      lines.push(`- ${shot.runStatus} · ${shot.caption} · ${shot.path}${shot.simulated ? ' (simulated)' : ''}${marks}`);
    }
  }
  if (research.workflowHistory.length) {
    lines.push('WORKFLOW HISTORY ACROSS THE CONSOLE:');
    for (const item of research.workflowHistory) {
      lines.push(`- ${item.name} [${item.status}] ${item.steps} steps · ${item.passed} passed / ${item.failed} failed`);
    }
  }
  if (research.externalVisualTests?.length) {
    lines.push('EXTERNAL VISUAL TESTER FINDINGS (received from the connected screenshot program):');
    for (const test of research.externalVisualTests) {
      lines.push(`- ${test.ok ? 'passed' : 'needs review'} · ${test.caption || test.imagePath}${test.summary ? ` · ${test.summary}` : ''}`);
      for (const finding of (test.findings || []).slice(0, 4)) {
        lines.push(`  Finding: ${typeof finding === 'string' ? finding : `${finding.label}: ${finding.detail}`}`);
      }
      for (const suggestion of (test.suggestions || []).slice(0, 4)) {
        lines.push(`  Suggestion: ${typeof suggestion === 'string' ? suggestion : `${suggestion.label}: ${suggestion.detail}`}`);
      }
    }
  }
  lines.push('Use the failed attempts as negative evidence. Use the screenshots and passed attempts as positive evidence. Build one ordered flow that covers the full goal, and never repeat a failed method unchanged.');
  return lines.join('\n').slice(0, 14000);
}

export function buildWorkflowResearch({ workflow = null, goal = '', app = null } = {}) {
  const d = db();
  const appNames = [app?.name, app?.process]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const workflowApps = [...new Set((workflow?.steps || [])
    .map((step) => step.appContext?.process || step.params?.foreground || step.params?.title || step.params?.target || '')
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))].slice(0, 8);
  const names = [...new Set([...appNames, ...workflowApps])];
  const memories = recallWorkflowMemory({ goal, workflow, app, limit: 8 });
  const memoryByRun = new Map((d.workflowMemory || []).map((entry) => [entry.runId, entry]));
  const matchingRuns = (d.runs || [])
    .filter((run) => looksRelated(run, workflow, goal, names))
    .slice(0, 60);
  const failedRuns = matchingRuns.filter(isFailure).slice(0, MAX_FAILED);
  const passedRuns = matchingRuns.filter((run) => run.status === 'passed').slice(0, MAX_PASSED);

  const failedAttempts = failedRuns.map((run) => {
    const fromRun = failedDetail(run, memoryByRun.get(run.id));
    const episode = (memories || []).find((entry) => entry.runId === run.id);
    if (!episode) return fromRun;
    return {
      ...fromRun,
      hindrances: [...new Set([...(fromRun.hindrances || []), ...(episode.hindrances || [])])].slice(0, 8),
      plan: (episode.steps || []).length
        ? (episode.steps || []).slice(0, 12).map((step) => `${step.type || 'step'}: ${clip(step.name, 100)}`)
        : fromRun.plan,
    };
  });

  // A memory episode can outlive a pruned run; keep its failure evidence visible.
  for (const episode of memories || []) {
    if (episode.status === 'passed' || failedAttempts.some((item) => item.runId === episode.runId)) continue;
    failedAttempts.push({
      runId: episode.runId,
      workflowId: episode.workflowId,
      workflowName: episode.workflowName,
      status: episode.status,
      mode: episode.mode,
      goal: clip(episode.goal, 300),
      at: episode.createdAt,
      failureSignature: (episode.hindrances || [])[0] || '',
      failed: (episode.steps || []).filter((step) => step.status === 'failed').map((step) => `${step.name}: failed`).slice(0, 6),
      hindrances: (episode.hindrances || []).slice(0, 6),
      plan: (episode.steps || []).slice(0, 12).map((step) => `${step.type}: ${clip(step.name, 100)}`),
    });
  }

  const passedAttempts = passedRuns.map((run) => ({
    runId: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName || 'Workflow',
    mode: run.dryRun ? 'simulated' : 'live',
    total: (run.steps || []).length,
    at: run.endedAt || run.createdAt || null,
    plan: (run.steps || []).slice(0, 12).map((step) => `${step.type}: ${clip(step.name, 100)}`),
  }));

  const screenshotRuns = [...failedRuns, ...passedRuns].filter(Boolean);
  const screenshots = [];
  const seenShots = new Set();
  for (const run of screenshotRuns) {
    for (const shot of screenshotsFor(run)) {
      const key = `${shot.path}|${shot.caption}`;
      if (seenShots.has(key) || screenshots.length >= MAX_SCREENSHOTS) continue;
      seenShots.add(key);
      screenshots.push(shot);
    }
  }
  for (const capture of (d.captures || []).slice(0, 12)) {
    if (screenshots.length >= MAX_SCREENSHOTS) break;
    const key = `${capture.path}|${capture.caption}`;
    if (seenShots.has(key) || !capture.path) continue;
    seenShots.add(key);
    screenshots.push({
      runId: capture.runId || null,
      workflowId: capture.workflowId || null,
      workflowName: 'Manual capture',
      runStatus: 'capture',
      simulated: Boolean(capture.simulated),
      caption: clip(capture.caption || 'Screen capture', 160),
      path: capture.path,
      width: capture.width || null,
      height: capture.height || null,
      createdAt: capture.createdAt || null,
      marks: [],
    });
  }

  const externalVisualTests = (d.proposals || [])
    .filter((proposal) => !workflow?.id || proposal.workflowId === workflow.id)
    .flatMap((proposal) =>
      (proposal.visualTests || []).map((test) => ({
        proposalId: proposal.id,
        at: test.at,
        imagePath: test.imagePath,
        caption: test.caption,
        ok: test.ok,
        confidence: test.confidence,
        summary: test.summary,
        findings: test.findings || [],
        suggestions: test.suggestions || [],
        annotations: test.annotations || [],
      }))
    )
    .slice(0, 8);

  const research = {
    goal: clip(goal, 800),
    generatedAt: new Date().toISOString(),
    conversation: conversationSlice(),
    failedAttempts,
    passedAttempts,
    screenshots,
    externalVisualTests,
    workflowHistory: workflowHistory(workflow),
    memory: (memories || []).map((entry) => ({
      runId: entry.runId,
      workflowId: entry.workflowId,
      workflowName: entry.workflowName,
      status: entry.status,
      mode: entry.mode,
      quality: entry.quality,
      score: entry.score,
      passed: entry.passed,
      total: entry.total,
      hindrances: (entry.hindrances || []).slice(0, 5),
    })),
    crossRefs: {
      apps: [...new Set([...names, ...(memories || []).flatMap((entry) => entry.apps || [])])].slice(0, 12),
      workflows: (workflowHistory(workflow) || []).map((entry) => entry.name).slice(0, 12),
      failedRuns: failedAttempts.map((item) => item.runId).filter(Boolean),
      screenshotPaths: screenshots.map((shot) => shot.path).slice(0, MAX_SCREENSHOTS),
    },
  };
  research.images = imagePayload(screenshots);
  research.promptText = promptFor(research);
  research.summary = {
    conversationMessages: research.conversation.length,
    failedAttempts: research.failedAttempts.length,
    passedAttempts: research.passedAttempts.length,
    screenshots: research.screenshots.length,
    workflows: research.workflowHistory.length,
    memoryEpisodes: research.memory.length,
    externalVisualTests: research.externalVisualTests.length,
  };
  return research;
}

export function compactResearch(research) {
  if (!research) return null;
  return {
    goal: research.goal,
    generatedAt: research.generatedAt,
    summary: research.summary,
    conversation: (research.conversation || []).slice(-8),
    failedAttempts: (research.failedAttempts || []).slice(0, 6),
    passedAttempts: (research.passedAttempts || []).slice(0, 4),
    screenshots: (research.screenshots || []).slice(0, 8),
    externalVisualTests: (research.externalVisualTests || []).slice(0, 6),
    workflowHistory: (research.workflowHistory || []).slice(0, 12),
    memory: (research.memory || []).slice(0, 6),
    crossRefs: research.crossRefs,
  };
}
