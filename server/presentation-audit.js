import { normalizeMarks, stepMarks } from './research.js';
import { lintWorkflow } from './planner.js';
import { shadowTestPlan } from './shadow-test.js';

function clip(value, max = 240) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function lower(value) {
  return String(value || '').toLowerCase();
}

function firstValue(params, keys) {
  for (const key of keys) {
    const value = params?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function expectedElement(step) {
  const params = step?.params || {};
  switch (step?.type) {
    case 'clickElement':
      return firstValue(params, ['name', 'element', 'label']) || 'Named visible control';
    case 'focusWindow':
      return firstValue(params, ['title', 'windowName', 'windowTitle', 'window', 'process']) || 'Target window';
    case 'waitFor':
      return firstValue(params, ['value', 'text', 'title', 'window', 'process']) || 'Expected window or text';
    case 'expect':
      return firstValue(params, ['value', 'text', 'title', 'window', 'process', 'expected']) || 'Expected state';
    case 'verifyScreen':
      return firstValue(params, ['expected', 'description', 'text', 'prompt']) || 'Visible verified result';
    case 'openUrl':
      return firstValue(params, ['url', 'urlVar']) || 'Requested page';
    case 'launchApp':
      return firstValue(params, ['target', 'app', 'application']) || 'Target application';
    case 'type':
      return firstValue(params, ['text', 'value']) ? 'Editable text field' : 'Text field';
    case 'key':
      return firstValue(params, ['keys']) ? `Keyboard target · ${firstValue(params, ['keys'])}` : 'Keyboard target';
    case 'downloadMedia':
      return 'Download control or saved file';
    case 'playMedia':
    case 'watchVideo':
      return 'Playing media';
    case 'screenshot':
      return 'Visible result for evidence';
    default:
      return step?.name || step?.type || 'Visible result';
  }
}

function ageHours(at, nowMs) {
  const time = Date.parse(at || '');
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.round(((nowMs - time) / 3600000) * 10) / 10);
}

function markMatches(mark, expected) {
  const haystack = lower(`${mark.label || ''} ${mark.number || ''}`);
  const wanted = lower(expected)
    .replace(/^(?:the|a|an)\s+/, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2)
    .slice(0, 4);
  if (!wanted.length) return false;
  return wanted.some((token) => haystack.includes(token));
}

function screenshotCandidates({ workflow, mission, runs, captures }) {
  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (!item.path || seen.has(item.path)) return;
    seen.add(item.path);
    items.push(item);
  };
  for (const run of runs) {
    for (const evidence of run.evidence || []) {
      if (evidence.kind !== 'screenshot' || !evidence.path) continue;
      const marks = Array.isArray(evidence.marks) ? normalizeMarks(evidence.marks) : normalizeMarks(stepMarks(run, evidence));
      push({
        id: evidence.id || null,
        path: evidence.path,
        url: `/api/files/raw?path=${encodeURIComponent(evidence.path)}`,
        caption: clip(evidence.caption || 'Run evidence', 160),
        simulated: Boolean(evidence.simulated),
        width: evidence.width || null,
        height: evidence.height || null,
        at: evidence.createdAt || run.endedAt || run.createdAt || null,
        source: 'run',
        runId: run.id,
        workflowId: run.workflowId || null,
        stepId: evidence.stepId || null,
        stepName: (run.steps || []).find((step) => step.id === evidence.stepId)?.name || null,
        marks,
      });
    }
  }
  for (const ref of mission?.references || []) {
    if (!ref.path) continue;
    push({
      id: ref.id || null,
      path: ref.path,
      url: `/api/files/raw?path=${encodeURIComponent(ref.path)}`,
      caption: clip(ref.caption || 'Session reference', 160),
      simulated: Boolean(ref.simulated),
      width: ref.width || null,
      height: ref.height || null,
      at: ref.at || mission.createdAt || null,
      source: 'mission',
      runId: ref.runId || null,
      workflowId: mission.workflowId || null,
      stepId: null,
      stepName: null,
      marks: normalizeMarks(ref.marks),
    });
  }
  for (const capture of captures || []) {
    if (!capture.path) continue;
    push({
      id: capture.id || null,
      path: capture.path,
      url: `/api/files/raw?path=${encodeURIComponent(capture.path)}`,
      caption: clip(capture.caption || 'Manual capture', 160),
      simulated: Boolean(capture.simulated),
      width: capture.width || null,
      height: capture.height || null,
      at: capture.createdAt || null,
      source: 'capture',
      runId: capture.runId || null,
      workflowId: capture.workflowId || null,
      stepId: null,
      stepName: null,
      marks: normalizeMarks(capture.marks),
    });
  }
  return items
    .filter((item) => item.source === 'mission' || (workflow?.id && item.workflowId === workflow.id))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

function currentPosition(workflow, run) {
  const steps = workflow?.steps || [];
  const failed = (run?.steps || []).find((step) => step.status === 'failed');
  const running = run?.position?.stepId
    ? (run.steps || []).find((step) => step.id === run.position.stepId)
    : null;
  const pending = (run?.steps || []).find((step) => step.status === 'pending' || step.status === 'running');
  const step = failed || running || pending || (run?.steps || [])[steps.length - 1] || null;
  const index = step ? Math.max(0, (run?.steps || []).findIndex((entry) => entry.id === step.id)) : -1;
  const next = index >= 0 ? (run?.steps || [])[index + 1] || null : steps[0] || null;
  return { step, index: index >= 0 ? index : null, next };
}

function agentFindings(agents) {
  return (agents || [])
    .map((agent) => {
      const recent = (agent.log || []).slice(-3).map((entry) => clip(entry.message || entry.note || entry, 180));
      const error = (agent.log || [])
        .slice(-12)
        .reverse()
        .find((entry) => /error|failed|blocked/i.test(`${entry.level || ''} ${entry.message || entry}`));
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role || agent.kind || 'agent',
        status: agent.status || (agent.enabled ? 'idle' : 'paused'),
        enabled: Boolean(agent.enabled),
        lastTickAt: agent.lastTickAt || null,
        issue: error ? clip(error.message || error, 220) : null,
        recent,
      };
    })
    .slice(0, 8);
}

function patternFindings(memories) {
  return (memories || []).slice(0, 6).map((memory) => ({
    runId: memory.runId,
    workflowName: memory.workflowName,
    status: memory.status,
    mode: memory.mode,
    quality: memory.quality ?? null,
    score: memory.score ?? null,
    passed: memory.passed ?? null,
    total: memory.total ?? null,
    hindrances: (memory.hindrances || []).slice(0, 4),
    steps: (memory.steps || []).slice(0, 8).map((step) => `${step.type}: ${step.name}`),
  }));
}

function suggestedTest(step) {
  if (!step) return null;
  if (step.type === 'clickElement') {
    return `Add a waitFor for “${expectedElement(step)}”, then re-capture before the click.`;
  }
  if (step.type === 'focusWindow') return `Verify “${expectedElement(step)}” is the foreground window before continuing.`;
  if (step.type === 'waitFor') return `Re-check the waiting condition “${expectedElement(step)}” against the current capture.`;
  if (['playMedia', 'watchVideo', 'downloadMedia'].includes(step.type)) return `Confirm the media state and output file, then re-test this phase.`;
  return `Re-run “${clip(step.name, 90)}” in simulated mode and compare the new evidence.`;
}

/**
 * Turn workflow, run, screenshot and memory evidence into a reviewable flow
 * audit. This is deliberately deterministic: it never claims a visual element
 * exists unless a screenshot mark or an explicit visual finding supports it.
 */
export function evaluateFlow({
  workflow,
  mission = null,
  runs = [],
  captures = [],
  agents = [],
  memories = [],
  visual = null,
  nowMs = Date.now(),
} = {}) {
  const visibleRuns = (runs || []).filter((run) => !run.shadow).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const run = mission?.lastRunId
    ? visibleRuns.find((entry) => entry.id === mission.lastRunId) || visibleRuns[0] || null
    : visibleRuns[0] || null;
  const screenshots = screenshotCandidates({ workflow, mission, runs: visibleRuns.slice(0, 12), captures });
  const screenshot = screenshots[0] || null;
  const position = currentPosition(workflow, run);
  const plan = shadowTestPlan({
    steps: workflow?.steps || [],
    preflight: workflow?.preflight || [],
    confidence: workflow?.planConfidence ?? null,
    screenshots,
    backups: workflow?.backupSteps || [],
    lint: lintWorkflow(workflow),
  });
  const lint = lintWorkflow(workflow);
  const lintErrors = (lint.issues || []).filter((issue) => issue.severity === 'error');
  const elements = (workflow?.steps || []).map((step, index) => {
    const expected = clip(expectedElement(step), 160);
    const runtime = (run?.steps || []).find((entry) => entry.id === step.id);
    const related = screenshot?.stepId && screenshot.stepId === step.id;
    const marked = (screenshot?.marks || []).some((mark) => markMatches(mark, expected));
    const visualFinding = (visual?.elements || []).find((entry) => Number(entry.index) === index || entry.stepId === step.id);
    const visualStatus = lower(visualFinding?.status);
    let status = 'unverified';
    let detail = 'No screenshot mark or visual finding names this element.';
    if (visualStatus === 'present' || visualStatus === 'missing' || visualStatus === 'unclear') {
      status = visualStatus;
      detail = clip(visualFinding.detail || visualFinding.note || (visualStatus === 'present' ? 'Visual model found it.' : 'Visual model could not confirm it.'), 220);
    } else if (!screenshot) {
      status = 'missing';
      detail = 'No current screenshot is available.';
    } else if (related || marked) {
      status = 'observed';
      detail = related
        ? `Evidence was captured at this step${screenshot.marks.length ? ` (${screenshot.marks.length} mark(s))` : ''}.`
        : 'A screenshot mark names this expected element.';
    }
    return {
      index,
      stepId: step.id,
      stepName: step.name,
      type: step.type,
      expected,
      status,
      detail,
      runtimeStatus: runtime?.status || null,
      error: clip(runtime?.error || '', 220) || null,
      screenshotId: screenshot?.id || null,
      markNumbers: (screenshot?.marks || []).filter((mark) => markMatches(mark, expected)).map((mark) => mark.number),
    };
  });
  if (visual?.elements?.length) {
    for (const finding of visual.elements) {
      const index = Number(finding.index);
      if (!Number.isInteger(index) || index < 0 || index >= elements.length) continue;
      elements[index].visualDetail = clip(finding.detail || finding.note || '', 220);
      elements[index].confidence = Number.isFinite(Number(finding.confidence)) ? Number(finding.confidence) : null;
      for (const key of ['x', 'y', 'width', 'height']) {
        if (Number.isFinite(Number(finding[key]))) elements[index][key] = Number(finding[key]);
      }
    }
  }

  const failures = plan.failures || [];
  const blockers = [];
  const warnings = [];
  if (!(workflow?.steps || []).length) {
    blockers.push({ code: 'no-steps', label: 'Workflow has no executable steps', detail: 'Add or plan steps before presenting the flow.' });
  }
  for (const failure of failures) {
    blockers.push({
      code: 'missing-input',
      label: `Step ${Number(failure.index) + 1} is incomplete`,
      detail: failure.reason,
      stepIndex: failure.index,
    });
  }
  for (const issue of lintErrors) {
    const stepIndex = issue.stepNumber ? Number(issue.stepNumber) - 1 : null;
    blockers.push({
      code: issue.code || 'lint',
      label: issue.message || `Plan issue: ${issue.code}`,
      detail: issue.message || 'The workflow plan has a blocking lint error.',
      stepIndex: Number.isInteger(stepIndex) ? stepIndex : null,
    });
  }
  if (!screenshot) {
    warnings.push({ code: 'no-screenshot', label: 'No current screenshot', detail: 'Capture the app state so the flow can be checked against the screen.' });
  } else if (!screenshot.marks.length) {
    warnings.push({ code: 'no-marks', label: 'Screenshot has no element marks', detail: 'Draw marks around the controls and expected result to make presence checks explicit.' });
  }
  if (run && ['failed', 'needs_review', 'cancelled'].includes(run.status)) {
    blockers.push({
      code: 'last-run-failed',
      label: `Last ${run.dryRun ? 'simulated' : 'live'} run ${run.status}`,
      detail: position.step?.error || run.analysis?.summary || 'The most recent run did not complete successfully.',
      stepIndex: position.index,
    });
  }
  if (position.next && position.step?.status === 'failed') {
    warnings.push({
      code: 'next-step-blocked',
      label: `Next step waits on “${clip(position.step.name, 70)}”`,
      detail: `Step ${position.index + 2} cannot be confirmed until the failed step succeeds.`,
    });
  }
  for (const element of elements) {
    if (element.status === 'missing') {
      blockers.push({
        code: 'missing-element',
        label: `Missing or unconfirmed element: ${element.expected}`,
        detail: element.visualDetail || element.detail,
        stepIndex: element.index,
      });
    } else if (element.status === 'unclear') {
      warnings.push({
        code: 'unclear-element',
        label: `Needs review: ${element.expected}`,
        detail: element.visualDetail || element.detail,
        stepIndex: element.index,
      });
    }
  }
  const agentRows = agentFindings(agents);
  for (const agent of agentRows) {
    if (agent.issue) warnings.push({ code: `agent-${agent.id}`, label: `${agent.name} reported an issue`, detail: agent.issue });
  }
  const observed = elements.filter((element) => element.status === 'observed' || element.status === 'present').length;
  if (screenshot && elements.length && observed === 0) {
    warnings.push({
      code: 'no-element-evidence',
      label: 'No expected element is backed by a mark or visual finding',
      detail: 'The screenshot exists, but it does not confirm any named control. Add marks or run a visual check.',
    });
  }
  const patterns = patternFindings(memories);
  const failedPatterns = patterns.filter((pattern) => pattern.hindrances?.length);
  const suggestions = [];
  if (!screenshot) suggestions.push({ title: 'Capture the current screen', detail: 'Use Presentation → Capture, then mark the controls that prove the flow is on track.', priority: 'high' });
  else if (!screenshot.marks.length) suggestions.push({ title: 'Draw proof onto the screenshot', detail: 'Mark the target control, the expected result and the next action before generating the deck.', priority: 'high' });
  if (position.step?.status === 'failed') suggestions.push({ title: `Repair “${clip(position.step.name, 80)}” before moving on`, detail: suggestedTest(position.step), priority: 'high' });
  for (const element of elements.filter((entry) => entry.status === 'missing').slice(0, 3)) {
    suggestions.push({ title: `Confirm ${element.expected}`, detail: suggestedTest((workflow.steps || [])[element.index]), priority: 'high' });
  }
  for (const pattern of failedPatterns.slice(0, 2)) {
    suggestions.push({
      title: `Reuse the lesson from ${pattern.workflowName}`,
      detail: pattern.hindrances[0],
      priority: 'medium',
    });
  }
  if (!agentRows.some((agent) => agent.enabled && /watchdog|observer/i.test(`${agent.role} ${agent.name}`))) {
    suggestions.push({ title: 'Enable an evidence watcher', detail: 'The failure watchdog or observer adds missing screenshots and step evidence while the flow runs.', priority: 'medium' });
  }
  if (!suggestions.length) suggestions.push({ title: 'Keep the verified path', detail: 'Re-test after any app update and compare the new evidence with this deck.', priority: 'low' });

  const confidence = Math.max(
    20,
    Math.min(
      98,
      Math.round(
        (plan.score || 0) * 0.55 +
          (screenshot ? 12 : 0) +
          (screenshot?.marks?.length ? 8 : 0) +
          (observed / Math.max(1, elements.length)) * 16 +
          (run?.status === 'passed' ? 9 : 0) -
          blockers.length * 8 -
          warnings.length * 2
      )
    )
  );
  const verdict = blockers.length ? 'blocked' : warnings.length || elements.some((element) => element.status === 'unverified') ? 'review' : 'ready';
  const reasonLines = [
    ...blockers.map((blocker) => blocker.detail || blocker.label),
    ...warnings.slice(0, 3).map((warning) => warning.detail || warning.label),
  ].filter(Boolean);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    verdict,
    confidence,
    summary:
      verdict === 'ready'
        ? 'The plan, current evidence and next step line up. This flow is ready for review.'
        : verdict === 'blocked'
          ? `The flow cannot be trusted yet: ${blockers[0]?.label || 'a blocking check failed'}.`
          : `The flow is plausible but needs review: ${warnings[0]?.label || 'some elements are unverified'}.`,
    reasons: [...new Set(reasonLines)].slice(0, 8),
    blockers: blockers.slice(0, 12),
    warnings: warnings.slice(0, 12),
    checks: [
      { key: 'steps', label: 'Workflow has steps', ok: (workflow?.steps || []).length > 0 },
      { key: 'parameters', label: 'Required step inputs are present', ok: failures.length === 0 },
      { key: 'lint', label: 'No blocking plan lint errors', ok: lintErrors.length === 0 },
      { key: 'screenshot', label: 'Current screenshot is available', ok: Boolean(screenshot) },
      { key: 'marks', label: 'Expected elements are marked or visually checked', ok: elements.some((element) => element.status === 'observed' || element.status === 'present') },
      { key: 'last-run', label: 'Last run completed without a failure', ok: !run || !['failed', 'needs_review', 'cancelled'].includes(run.status) },
      { key: 'next-step', label: 'Next step is available to verify', ok: Boolean(position.next || run?.status === 'passed') },
    ],
    elements,
    current: {
      missionId: mission?.id || null,
      runId: run?.id || null,
      runStatus: run?.status || null,
      mode: run ? (run.dryRun ? 'simulated' : 'live') : null,
      position: position.index,
      step: position.step
        ? {
            index: position.index,
            id: position.step.id,
            name: position.step.name,
            type: position.step.type,
            status: position.step.status,
            error: clip(position.step.error || '', 300) || null,
          }
        : null,
      next: position.next
        ? {
            index: position.index + 1,
            id: position.next.id,
            name: position.next.name,
            type: position.next.type,
            expected: clip(expectedElement(position.next), 160),
          }
        : null,
      screenshot,
      screenshotCount: screenshots.length,
      screenshotAgeHours: screenshot ? ageHours(screenshot.at, nowMs) : null,
    },
    visual: visual
      ? {
          available: true,
          model: visual.model || null,
          summary: clip(visual.summary || '', 500),
          findings: (visual.elements || []).slice(0, 16).map((entry) => ({
            index: Number(entry.index),
            status: entry.status,
            detail: clip(entry.detail || entry.note || '', 220),
            confidence: entry.confidence ?? null,
          })),
        }
      : { available: false, summary: 'Visual model did not inspect the screenshot.' },
    patterns,
    agents: agentRows,
    suggestions: suggestions.slice(0, 8),
    crossRefs: {
      workflowId: workflow?.id || null,
      workflowName: workflow?.name || null,
      missionId: mission?.id || null,
      runIds: visibleRuns.slice(0, 8).map((entry) => entry.id),
      screenshotPaths: screenshots.slice(0, 8).map((entry) => entry.path),
      patternRuns: patterns.map((pattern) => pattern.runId).filter(Boolean),
      agents: agentRows.map((agent) => agent.id),
    },
    plan: {
      status: plan.status,
      score: plan.score,
      passed: plan.passed,
      total: plan.total,
      failures,
      warnings: plan.warnings || [],
    },
  };
}

/** Build numbered marks from visual findings that returned a usable screen position. */
export function autoMarksForAudit(audit) {
  return (audit?.elements || [])
    .filter(
      (element) =>
        element.status === 'present' &&
        Number.isFinite(Number(element.x)) &&
        Number.isFinite(Number(element.y))
    )
    .slice(0, 10)
    .map((element, index) => ({
      number: index + 1,
      label: clip(element.expected, 60),
      x: Math.max(0, Math.min(100, Number(element.x))),
      y: Math.max(0, Math.min(100, Number(element.y))),
      auto: true,
    }));
}

/** Recompute the verdict after an optional visual model inspection. */
export function mergeVisualFindings(audit, visual) {
  if (!audit || !visual) return audit;
  const elements = (audit.elements || []).map((element) => ({ ...element }));
  const blockers = (audit.blockers || []).filter((blocker) => !['missing-element', 'visual-missing-element'].includes(blocker.code));
  const warnings = (audit.warnings || []).filter(
    (warning) => !['unclear-element', 'no-element-evidence', 'no-screenshot', 'no-marks'].includes(warning.code)
  );
  for (const finding of visual.elements || []) {
    const index = Number(finding.index);
    if (!Number.isInteger(index) || index < 0 || index >= elements.length) continue;
    const status = lower(finding.status);
    if (!['present', 'missing', 'unclear'].includes(status)) continue;
    elements[index].status = status;
    elements[index].detail = clip(finding.detail || finding.note || 'Visual model finding.', 220);
    elements[index].visualDetail = elements[index].detail;
    elements[index].confidence = Number.isFinite(Number(finding.confidence)) ? Number(finding.confidence) : null;
    for (const key of ['x', 'y', 'width', 'height']) {
      if (Number.isFinite(Number(finding[key]))) elements[index][key] = Number(finding[key]);
    }
    if (status === 'missing') {
      blockers.push({
        code: 'visual-missing-element',
        label: `Visual check could not find: ${elements[index].expected}`,
        detail: elements[index].detail,
        stepIndex: index,
      });
    } else if (status === 'unclear') {
      warnings.push({
        code: 'unclear-element',
        label: `Visual check is unsure about: ${elements[index].expected}`,
        detail: elements[index].detail,
        stepIndex: index,
      });
    }
  }
  const observed = elements.filter((element) => element.status === 'observed' || element.status === 'present').length;
  if (elements.length && observed === 0) {
    warnings.push({
      code: 'no-element-evidence',
      label: 'No expected element is backed by a visual finding',
      detail: 'The visual check did not confirm any named element.',
    });
  }
  const verdict = blockers.length ? 'blocked' : warnings.length || elements.some((element) => element.status === 'unverified') ? 'review' : 'ready';
  return {
    ...audit,
    elements,
    blockers: blockers.slice(0, 12),
    warnings: warnings.slice(0, 12),
    checks: (audit.checks || []).map((check) =>
      check.key === 'screenshot' || check.key === 'marks' ? { ...check, ok: true } : check
    ),
    verdict,
    confidence: Math.max(20, Math.min(98, Math.round((audit.confidence || 50) + (observed / Math.max(1, elements.length)) * 10 - blockers.length * 6))),
    visual: {
      available: true,
      model: visual.model || null,
      summary: clip(visual.summary || '', 500),
      findings: (visual.elements || []).slice(0, 16).map((entry) => ({
        index: Number(entry.index),
        status: entry.status,
        detail: clip(entry.detail || entry.note || '', 220),
        confidence: entry.confidence ?? null,
      })),
    },
    summary:
      verdict === 'ready'
        ? 'The plan and visual evidence line up. This flow is ready for review.'
        : verdict === 'blocked'
          ? `The flow cannot be trusted yet: ${blockers[0]?.label || 'a visual check failed'}.`
          : `The flow needs review: ${warnings[0]?.label || 'some elements remain unclear'}.`,
  };
}
