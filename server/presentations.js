import fs from 'node:fs';
import path from 'node:path';
import { db, persist, uid, now, logActivity, DATA, resolveInside } from './store.js';
import { chat, parseJsonLoose, listModels } from './llm.js';
import { recallWorkflowMemory } from './workflow-memory.js';
import { createRun, waitForRun } from './engine.js';
import { createProposal } from './proposals.js';
import { executeStep, IS_WINDOWS } from './automation.js';
import { autoMarksForAudit, evaluateFlow, mergeVisualFindings } from './presentation-audit.js';
import { ensureDeckProfile, getPresentationDeck, listPresentationSummaries, presentationSummary, searchPresentations } from './presentation-index.js';
import { normalizeMarks } from './research.js';
import { canRetry, recordRetryOutcome, setRetryBudget, getRetryBudget } from './retry-budget.js';
import { maybeCreateRepairProposal } from './presentation-retry.js';

const MAX_IMAGE_BYTES = 1_800_000;

function clip(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function stepLine(step, index) {
  const params = Object.entries(step.params || {})
    .filter(([, value]) => value !== '' && value != null)
    .slice(0, 5)
    .map(([key, value]) => `${key}=${clip(typeof value === 'object' ? JSON.stringify(value) : value, 90)}`)
    .join(', ');
  return `${index + 1}. ${clip(step.name || step.type, 90)} [${step.type}]${params ? ` — ${params}` : ''}`;
}

function runLines(run) {
  const failed = (run.steps || []).filter((step) => step.status === 'failed');
  const lines = [`${run.id}: ${run.status}${run.errorCategory ? ` · ${run.errorCategory}` : ''}`];
  for (const step of failed.slice(0, 4)) lines.push(`  failed: ${clip(step.name, 80)} — ${clip(step.error || 'no error text', 180)}`);
  return lines.join('\n');
}

function auditContext(audit) {
  if (!audit) return 'No flow audit was available.';
  const lines = [
    `Audit verdict: ${audit.verdict} (${audit.confidence}%). ${audit.summary}`,
    `Current screenshot: ${audit.current?.screenshot ? `${audit.current.screenshot.caption} · ${audit.current.screenshot.path} · ${audit.current.screenshot.marks?.length || 0} mark(s)` : 'none'}`,
    `Current step: ${audit.current?.step ? `${audit.current.step.index + 1}. ${audit.current.step.name} (${audit.current.step.status})` : 'no runtime step'}`,
    `Next step: ${audit.current?.next ? `${audit.current.next.index + 1}. ${audit.current.next.name} — expected ${audit.current.next.expected}` : 'none'}`,
  ];
  if (audit.blockers.length) lines.push(`Blockers:\n${audit.blockers.map((item) => `- ${item.label}: ${item.detail}`).join('\n')}`);
  if (audit.warnings.length) lines.push(`Warnings:\n${audit.warnings.map((item) => `- ${item.label}: ${item.detail}`).join('\n')}`);
  if (audit.elements.length) {
    lines.push(
      `Element checks:\n${audit.elements
        .slice(0, 16)
        .map((element) => `- ${element.index + 1}. ${element.expected} · ${element.status} · ${element.detail}`)
        .join('\n')}`
    );
  }
  if (audit.patterns.length) {
    lines.push(
      `Recalled patterns:\n${audit.patterns
        .slice(0, 5)
        .map((pattern) => `- ${pattern.workflowName} · ${pattern.status} · ${pattern.passed}/${pattern.total} steps · ${(pattern.hindrances || [])[0] || 'no recorded hindrance'}`)
        .join('\n')}`
    );
  }
  if (audit.agents.length) {
    lines.push(`Agents:\n${audit.agents.map((agent) => `- ${agent.name} · ${agent.status} · ${agent.enabled ? 'enabled' : 'disabled'}${agent.issue ? ` · issue: ${agent.issue}` : ''}`).join('\n')}`);
  }
  if (audit.suggestions.length) {
    lines.push(`Audit suggestions:\n${audit.suggestions.map((item) => `- ${item.title}: ${item.detail}`).join('\n')}`);
  }
  return lines.join('\n');
}

function buildContext(workflow, mission, focus, audit) {
  const runs = db().runs.filter((run) => run.workflowId === workflow.id && !run.shadow).slice(0, 5);
  const suggestions = db().suggestions.filter((item) => !item.dismissed && (!item.workflowId || item.workflowId === workflow.id)).slice(0, 6);
  const parts = [
    `Workflow: ${workflow.name}`,
    `Description: ${workflow.description || 'none'}`,
    `Status: ${workflow.status || 'draft'} · tags: ${(workflow.tags || []).join(', ') || 'none'}`,
    `Requested focus: ${focus}`,
    `Steps:\n${(workflow.steps || []).map(stepLine).join('\n') || 'No steps yet.'}`,
    auditContext(audit),
  ];
  if (runs.length) parts.push(`Recent runs:\n${runs.map(runLines).join('\n')}`);
  if (mission) {
    parts.push(
      `Session: ${mission.status} · verdict ${mission.verification?.verdict || 'pending'} · ${clip(mission.goal, 220)}`,
      `Verification: ${clip(mission.verification?.summary || 'not available', 500)}`
    );
    const events = (mission.events || []).slice(-14).map((event) => `${event.agent || 'agent'} ${event.kind || 'event'}: ${clip(event.message, 220)}`);
    if (events.length) parts.push(`Session events:\n${events.join('\n')}`);
    if (mission.verification?.findings?.length) parts.push(`Findings: ${mission.verification.findings.map((item) => clip(item, 220)).join('; ')}`);
  }
  if (suggestions.length) parts.push(`Existing suggestions: ${suggestions.map((item) => clip(item.title || item.text || item.message, 180)).join('; ')}`);
  return parts.join('\n').slice(0, 18000);
}

function visualFor(audit) {
  const shot = audit?.current?.screenshot;
  if (!shot?.path) return null;
  const settings = db().settings;
  if (!settings.visionEnabled) return { unavailable: 'Vision is disabled in Settings.' };
  return { shot };
}

async function inspectScreenshot(workflow, audit) {
  const target = visualFor(audit);
  if (!target) return { visual: null, note: 'No screenshot was available for visual inspection.' };
  if (target.unavailable) return { visual: null, note: target.unavailable };
  const models = await listModels();
  const info = models.ok ? models.models.find((model) => model.name === db().settings.model) : null;
  if (!info || !info.capabilities?.includes('vision')) {
    return { visual: null, note: `Model ${db().settings.model} has no vision capability.` };
  }
  const resolved = resolveInside(DATA, target.shot.path);
  if (!resolved) return { visual: null, note: 'The screenshot path is outside the capture store.' };
  let buffer;
  try {
    buffer = fs.readFileSync(resolved);
  } catch {
    return { visual: null, note: 'The screenshot file could not be read.' };
  }
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return { visual: null, note: 'The screenshot is empty or too large for a visual check.' };
  const expected = audit.elements.map((element) => `${element.index + 1}. ${element.expected} (step: ${element.stepName})`).join('\n');
  const reply = await chat(
    [
      {
        role: 'system',
        content:
          'You are a strict visual verifier for a Windows automation workflow. Inspect the supplied screenshot only. ' +
          'For each expected element decide whether it is visibly present, missing, or unclear. Do not infer hidden or off-screen content. ' +
          'If the element is present, include its approximate center as x and y percentages from 0 to 100. ' +
          'Return JSON only: {"summary":"...","elements":[{"index":0,"status":"present|missing|unclear","detail":"what is visible and where","confidence":0.0,"x":0,"y":0}],"nextStep":"..."}',
      },
      {
        role: 'user',
        content: `Workflow: ${workflow.name}\nExpected elements:\n${expected}\n\nOnly use visible evidence in this capture: ${target.shot.caption || target.shot.path}.`,
      },
    ],
    { format: 'json', kind: 'presentation-visual', timeoutMs: 70000, temperature: 0.1, maxTokens: 2500, images: [buffer.toString('base64')] }
  );
  if (!reply.ok) return { visual: null, note: `Visual check failed: ${reply.error}` };
  const parsed = parseJsonLoose(reply.content);
  if (!Array.isArray(parsed?.elements)) return { visual: null, note: 'The visual model did not return element findings.' };
  return {
    visual: {
      model: reply.model,
      summary: clip(parsed.summary || '', 500),
      elements: parsed.elements
        .map((entry) => ({
          index: Number(entry.index),
          status: clip(entry.status, 20).toLowerCase(),
          detail: clip(entry.detail || entry.note || '', 220),
          confidence: Number.isFinite(Number(entry.confidence)) ? Math.max(0, Math.min(1, Number(entry.confidence))) : null,
          ...(Number.isFinite(Number(entry.x)) ? { x: Math.max(0, Math.min(100, Number(entry.x))) } : {}),
          ...(Number.isFinite(Number(entry.y)) ? { y: Math.max(0, Math.min(100, Number(entry.y))) } : {}),
        }))
        .filter((entry) => Number.isInteger(entry.index) && ['present', 'missing', 'unclear'].includes(entry.status)),
    },
    note: '',
  };
}

function evidenceSlide(audit) {
  const shot = audit?.current?.screenshot;
  if (!shot) return null;
  const marks = (shot.marks || []).slice(0, 6);
  return {
    kicker: 'Current screen proof',
    title: 'What the latest capture confirms',
    bullets: [
      `${shot.simulated ? 'Simulated' : 'Live'} capture: ${shot.caption}`,
      marks.length ? `${marks.length} marked element(s): ${marks.map((mark) => mark.label).join(', ')}` : 'No elements are marked on this capture.',
      `${audit.elements.filter((element) => element.status === 'observed' || element.status === 'present').length}/${audit.elements.length || 0} expected element(s) have evidence.`,
    ].slice(0, 3),
    note: shot.at ? `Captured ${shot.at}${audit.current.screenshotAgeHours != null ? ` · ${audit.current.screenshotAgeHours}h old` : ''}.` : '',
    image: {
      path: shot.path,
      url: shot.url,
      caption: shot.caption,
      marks,
      width: shot.width || null,
      height: shot.height || null,
    },
  };
}

function auditSlide(audit) {
  return {
    kicker: 'Flow audit',
    title: audit.verdict === 'ready' ? 'The flow makes sense' : audit.verdict === 'blocked' ? 'Why this flow cannot be trusted' : 'What still needs a human review',
    bullets: [
      audit.summary,
      `${audit.checks.filter((check) => check.ok).length}/${audit.checks.length} structural checks pass.`,
      audit.reasons[0] || 'No blocking reason was found.',
    ],
    note: `Confidence ${audit.confidence}% · ${audit.current.screenshotCount || 0} screenshot(s) considered.`,
  };
}

function nextStepSlide(audit) {
  const next = audit.current?.next;
  const step = audit.current?.step;
  return {
    kicker: 'Next step',
    title: next ? `Verify ${next.name}` : step ? `Resolve ${step.name}` : 'No next step to verify',
    bullets: next
      ? [
          `Expected: ${next.expected}`,
          step ? `Current step is ${step.status}: ${step.name}` : 'No runtime position is available.',
          `Re-test after the target is visible, then compare a new capture.`,
        ]
      : [step?.error || 'The last recorded step has no next action.', 'Add the missing phase or re-plan before running live.'],
    note: audit.current?.screenshot ? `Compared with ${audit.current.screenshot.caption}.` : 'Capture the current screen to ground this claim.',
  };
}

function blockersSlide(audit) {
  const bullets = audit.blockers.slice(0, 4).map((item) => item.detail || item.label);
  return {
    kicker: 'Why it cannot be done yet',
    title: 'Blocking evidence and missing elements',
    bullets: bullets.length ? bullets : ['No blocking issue is recorded; the remaining risk is unverified evidence.'],
    note: audit.warnings[0]?.detail || 'Re-run the flow after repairing the first blocker.',
  };
}

function patternSlide(audit) {
  const top = audit.patterns.slice(0, 4);
  return {
    kicker: 'Reusable patterns',
    title: 'Recall from similar runs',
    bullets: top.length
      ? top.map((pattern) => `${pattern.workflowName}: ${pattern.passed}/${pattern.total} steps, ${pattern.status}${pattern.hindrances?.[0] ? ` — ${pattern.hindrances[0]}` : ''}`)
      : ['No matching workflow memory yet.', 'A passed run will become a reusable pattern for the next deck.'],
    note: `Cross-referenced ${audit.crossRefs?.runIds?.length || 0} run(s) and ${audit.crossRefs?.patternRuns?.length || 0} remembered pattern(s).`,
  };
}

function agentSlide(audit) {
  const agents = audit.agents.slice(0, 4);
  return {
    kicker: 'Agent check',
    title: 'Who is watching the evidence',
    bullets: agents.length
      ? agents.map((agent) => `${agent.name}: ${agent.enabled ? 'enabled' : 'disabled'} · ${agent.status}${agent.issue ? ` · ${agent.issue}` : ''}`)
      : ['No agents are configured for this console.'],
    note: 'Agents add evidence; their findings are warnings, not proof that an element exists.',
  };
}

function strategySlide(audit) {
  const suggestions = audit.suggestions.slice(0, 4);
  return {
    kicker: 'Strategy and suggestions',
    title: 'What the planner should try next',
    bullets: suggestions.map((item) => `${item.title}: ${item.detail}`),
    note: 'These suggestions can be sent to the planner as a proposal for review.',
  };
}

function fallbackDeck(workflow, audit, mission) {
  return {
    title: `${workflow.name} · verified flow review`,
    subtitle: audit.summary,
    theme: audit.verdict === 'ready' ? 'green' : audit.verdict === 'blocked' ? 'amber' : 'slate',
    slides: [
      {
        kicker: 'Verified review',
        title: workflow.name,
        bullets: [
          workflow.description || 'An operator walkthrough built from the current plan and evidence.',
          `${(workflow.steps || []).length} steps · ${audit.verdict} · ${audit.confidence}% confidence.`,
          mission ? `Session: ${mission.goal}` : 'No supervised session selected.',
        ],
        note: 'This deck was assembled deterministically because the presentation model was unavailable.',
      },
      auditSlide(audit),
      evidenceSlide(audit),
      {
        kicker: 'Element verification',
        title: 'What each step expects to see',
        bullets: audit.elements.slice(0, 4).map((element) => `${element.index + 1}. ${element.expected}: ${element.status}`),
        note: 'Observed means a mark or capture at that step supports it. Unverified is not proof of absence.',
      },
      nextStepSlide(audit),
      ...(audit.blockers.length ? [blockersSlide(audit)] : []),
      patternSlide(audit),
      agentSlide(audit),
      strategySlide(audit),
    ].filter(Boolean),
    source: mission ? `session ${mission.id}` : `workflow ${workflow.id}`,
  };
}

function sanitizeSlideImage(image) {
  if (!image || !image.path || !image.url) return null;
  return {
    path: clip(image.path, 300),
    url: clip(image.url, 500),
    caption: clip(image.caption || 'Evidence', 160),
    marks: Array.isArray(image.marks)
      ? image.marks
          .slice(0, 8)
          .map((mark, index) => ({
            number: Number(mark.number) || index + 1,
            label: clip(mark.label || `Mark ${index + 1}`, 60),
            x: Math.max(0, Math.min(100, Number(mark.x) || 0)),
            y: Math.max(0, Math.min(100, Number(mark.y) || 0)),
          }))
      : [],
    width: image.width || null,
    height: image.height || null,
  };
}

function sanitizeDeck(parsed, workflow, mission) {
  const slides = (Array.isArray(parsed?.slides) ? parsed.slides : [])
    .map((slide, index) => ({
      kicker: clip(slide?.kicker || `Slide ${index + 1}`, 40),
      title: clip(slide?.title || slide?.heading, 100),
      bullets: (Array.isArray(slide?.bullets) ? slide.bullets : String(slide?.bullets || '').split('\n'))
        .map((item) => clip(item, 200))
        .filter(Boolean)
        .slice(0, 4),
      note: clip(slide?.note || slide?.caption || '', 280),
      image: sanitizeSlideImage(slide?.image),
    }))
    .filter((slide) => slide.title)
    .slice(0, 9);
  if (!slides.length) return null;
  return {
    title: clip(parsed.title || workflow.name, 110),
    subtitle: clip(parsed.subtitle || workflow.description || 'How this workflow runs', 180),
    theme: ['amber', 'blue', 'green', 'slate'].includes(parsed.theme) ? parsed.theme : 'amber',
    slides,
    source: mission ? `session ${mission.id}` : `workflow ${workflow.id}`,
  };
}

function composeDeck(parsed, workflow, mission, audit, visualNote) {
  const deck = sanitizeDeck(parsed, workflow, mission) || fallbackDeck(workflow, audit, mission);
  if (!audit) return deck;
  const slides = [...deck.slides];
  const hasAudit = slides.some((slide) => /audit|verif|makes sense|why this/i.test(`${slide.kicker} ${slide.title}`));
  if (!hasAudit) slides.splice(1, 0, auditSlide(audit));
  const evidence = evidenceSlide(audit);
  if (evidence) {
    const imageIndex = slides.findIndex((slide) => /screen|evidence|proof|capture/i.test(`${slide.kicker} ${slide.title}`));
    if (imageIndex >= 0) slides[imageIndex] = { ...slides[imageIndex], image: evidence.image, note: slides[imageIndex].note || evidence.note };
    else slides.splice(2, 0, evidence);
  }
  if (audit.blockers.length && !slides.some((slide) => /cannot|block|missing|why/i.test(`${slide.kicker} ${slide.title}`))) {
    slides.push(blockersSlide(audit));
  }
  if (audit.patterns.length && !slides.some((slide) => /pattern|memory|similar|reuse/i.test(`${slide.kicker} ${slide.title}`))) {
    slides.push(patternSlide(audit));
  }
  if (audit.suggestions.length && !slides.some((slide) => /strategy|suggest|next/i.test(`${slide.kicker} ${slide.title}`))) {
    slides.push(strategySlide(audit));
  }
  return {
    ...deck,
    slides: slides.slice(0, 12),
    note: visualNote ? clip(visualNote, 240) : deck.note,
  };
}

function deckSystemPrompt(hasImage) {
  return (
    'You are the presentation producer inside Sightline, a Windows desktop automation console. ' +
    'Create a concise, evidence-led deck for an operator who needs to know whether a workflow makes sense against the current screen, what is missing, and what to try next. ' +
    'Use only the supplied workflow steps, audit checks, screenshot marks, run evidence, session events and findings. Never invent a visible element, a success, an app, a coordinate or a fix. ' +
    (hasImage ? 'A current screenshot is inspected separately; use its supplied visual findings as evidence. ' : 'No visual findings are available; do not claim that an element is visible. ') +
    'Reply with JSON only in this exact shape: ' +
    '{"title":"...","subtitle":"...","theme":"amber|blue|green|slate","slides":[{"kicker":"...","title":"...","bullets":["...","..."],"note":"..."}]}. ' +
    'Write 6-9 slides. Open with the operation, then show the audit verdict, what the current screenshot proves, the ordered next step, why the flow cannot run when blocked, reusable patterns, the agent check, and a prioritized strategy. ' +
    'Each slide: 1-3 bullets, at most 18 words per bullet, no markdown, no URLs, no code fences. If evidence is missing, say what must be observed instead of guessing. ' +
    'Distinguish observed evidence from unverified expectations. A missing screenshot mark is not proof that a control is absent unless a visual finding says so. ' +
    'Use RELATED SAVED DECKS as navigation: reuse a proven explanation or checkpoint, and explicitly avoid a prior deck\'s blocker.'
  );
}

function focusLine(focus) {
  return focus === 'problem'
    ? 'Center the deck on the current blocker, its observable symptom, the missing element, and the safest next test.'
    : focus === 'suggestions'
      ? 'Center the deck on practical improvements and the planner strategy, ordered by risk and expected value.'
      : focus === 'howto'
        ? 'Center the deck on a step-by-step operator walkthrough with screenshot-backed checkpoints.'
        : 'Choose the most useful angle from the audit: how-to when ready, troubleshooting when blocked, review guidance otherwise.';
}

export function listPresentations(workflowId) {
  return listPresentationSummaries(workflowId || '', 30);
}

export function getPresentation(id) {
  return getPresentationDeck(id);
}

export function findRelatedPresentations(query, { workflowId = '', classification = '', limit = 12 } = {}) {
  return searchPresentations({ query, workflowId, classification, limit });
}

function gatherAuditInputs(workflow, mission) {
  const d = db();
  const runs = d.runs.filter((run) => run.workflowId === workflow.id && !run.shadow).slice(0, 20);
  const captures = (d.captures || []).filter(
    (capture) => capture.workflowId === workflow.id || (mission?.id && capture.missionId === mission.id)
  );
  const memories = recallWorkflowMemory({
    goal: String(mission?.goal || workflow.description || workflow.name || ''),
    workflow,
    limit: 6,
  });
  return { runs, captures, agents: d.agents || [], memories };
}

export function auditPresentation(input = {}) {
  const workflow = db().workflows.find((item) => item.id === input.workflowId);
  if (!workflow) throw new Error('Workflow not found');
  const mission = input.missionId ? db().missions.find((item) => item.id === input.missionId) : null;
  if (input.missionId && !mission) throw new Error('Session not found');
  const inputs = gatherAuditInputs(workflow, mission);
  return evaluateFlow({ workflow, mission, ...inputs });
}

async function captureFreshEvidence(workflow, mission) {
  const caption = `Fresh re-test · ${workflow.name}`;
  const live = IS_WINDOWS;
  try {
    const result = await executeStep(
      {
        id: uid('cap'),
        type: 'screenshot',
        name: 'Fresh re-test capture',
        params: { caption },
        timeoutMs: 20000,
        optional: false,
      },
      {
        live,
        runId: null,
        run: { id: `presentation-${workflow.id}` },
        workflow,
        getTool: (toolId) => db().tools.find((tool) => tool.id === toolId),
      }
    );
    const evidence = (result.evidence || []).find((item) => item.path);
    if (!evidence) return { error: 'The capture step returned no image.' };
    const record = {
      id: uid('cap'),
      caption,
      path: evidence.path,
      simulated: Boolean(evidence.simulated),
      width: evidence.width || null,
      height: evidence.height || null,
      createdAt: now(),
      workflowId: workflow.id,
      workflowName: workflow.name,
      missionId: mission?.id || null,
      source: 'presentation-retest',
      marks: [],
    };
    db().captures.unshift(record);
    db().captures = db().captures.slice(0, 80);
    persist();
    logActivity('presentation', `Fresh ${record.simulated ? 'simulated' : 'live'} re-test capture for "${workflow.name}"`, {
      workflowId: workflow.id,
      captureId: record.id,
    });
    return { capture: record };
  } catch (err) {
    return { error: err.message };
  }
}

function applyAutoMarks(audit) {
  const shot = audit?.current?.screenshot;
  const added = autoMarksForAudit(audit);
  if (!shot || !added.length) return { added: 0, marks: shot?.marks || [] };
  const marks = normalizeMarks([...(shot.marks || []), ...added]).slice(0, 12);
  shot.marks = marks;
  const d = db();
  let saved = false;
  for (const capture of d.captures || []) {
    if ((shot.id && capture.id === shot.id) || capture.path === shot.path) {
      capture.marks = marks;
      capture.autoMarksAt = now();
      saved = true;
      break;
    }
  }
  if (!saved) {
    for (const run of d.runs || []) {
      const evidence = (run.evidence || []).find((item) => (shot.id && item.id === shot.id) || item.path === shot.path);
      if (evidence) {
        evidence.marks = marks;
        evidence.autoMarksAt = now();
        saved = true;
        break;
      }
    }
  }
  if (saved) persist();
  return { added: added.length, marks };
}

function relatedDeckContext(workflow) {
  const query = [workflow.description, workflow.name, ...(workflow.patternTags || [])].filter(Boolean).join(' ');
  const related = searchPresentations({ query, limit: 4 });
  if (!related.length) return 'No related saved decks.';
  return related
    .map(
      (deck) =>
        `- ${deck.title} · ${deck.workflowName} · ${deck.profile?.classification?.join('/')} · similarity ${Math.round((deck.similarity || 0) * 100)}% · ${deck.auditSummary?.verdict || 'unknown'} · quality ${deck.quality?.score ?? 'n/a'}${deck.lineage?.parentDeckId ? ` · follows ${deck.lineage.parentDeckId}` : ''}`
    )
    .join('\n');
}

export async function generatePresentation(input = {}) {
  const workflow = db().workflows.find((item) => item.id === input.workflowId);
  if (!workflow) throw new Error('Workflow not found');
  const mission = input.missionId ? db().missions.find((item) => item.id === input.missionId) : null;
  if (input.missionId && !mission) throw new Error('Session not found');
  const focus = ['auto', 'howto', 'problem', 'suggestions'].includes(input.focus) ? input.focus : 'auto';
  let audit = auditPresentation({ workflowId: workflow.id, missionId: mission?.id || null });
  let visualNote = '';
  let model = null;
  try {
    const inspection = await inspectScreenshot(workflow, audit);
    if (inspection.visual) audit = mergeVisualFindings(audit, inspection.visual);
    visualNote = inspection.note || '';
  } catch (err) {
    visualNote = `Visual check could not run: ${err.message}`;
  }
  if (!audit.visual?.available && visualNote) {
    audit = { ...audit, visual: { ...(audit.visual || {}), available: false, note: visualNote } };
  }
  const autoMarks = applyAutoMarks(audit);
  if (autoMarks.added && !visualNote) visualNote = `Auto-drew ${autoMarks.added} visual finding(s) onto the capture.`;
  const context = `${buildContext(workflow, mission, focus, audit)}\n\nRELATED SAVED DECKS (navigation by vector similarity and classification):\n${relatedDeckContext(workflow)}`;
  let deck = null;
  try {
    const reply = await chat(
      [{ role: 'system', content: deckSystemPrompt(Boolean(audit.visual?.available)) }, { role: 'user', content: `${focusLine(focus)}\n\n${context}` }],
      { format: 'json', kind: 'presentation', timeoutMs: 90000, temperature: 0.35 }
    );
    if (reply.ok) {
      model = reply.model;
      deck = composeDeck(parseJsonLoose(reply.content), workflow, mission, audit, visualNote);
    } else {
      visualNote = [visualNote, `Presentation model unavailable: ${reply.error}`].filter(Boolean).join(' ');
    }
  } catch (err) {
    visualNote = [visualNote, `Presentation model unavailable: ${err.message}`].filter(Boolean).join(' ');
  }
  if (!deck) deck = { ...fallbackDeck(workflow, audit, mission), note: visualNote || 'Deterministic fallback deck.' };
  const deckId = uid('deck');
  const previousDeck = (db().presentations || []).find((entry) => entry.workflowId === workflow.id);
  const rootDeckId = previousDeck?.lineage?.rootDeckId || previousDeck?.id || deckId;
  const record = {
    id: deckId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    missionId: mission?.id || null,
    focus,
    ...deck,
    audit,
    review: { status: 'unreviewed', comment: '', at: null },
    rechecks: [],
    proposalId: null,
    control: { paused: false, manual: false, reason: null, at: null },
    attempts: { consecutive: 0, total: 0, maxFailedAttempts: 3, lastAt: null, lastStatus: null },
    watch: null,
    notes: [],
    lineage: {
      rootDeckId,
      parentDeckId: previousDeck?.id || null,
      depth: previousDeck ? Number(previousDeck.lineage?.depth || 0) + 1 : 0,
      events: [{ type: 'generated', at: now(), verdict: audit.verdict, summary: `Generated a ${deck.slides.length}-slide review.` }],
    },
    model: model || 'deterministic-audit',
    createdAt: now(),
    durationSeconds: Math.max(12, Math.min(60, deck.slides.length * 5)),
    autoMarks: autoMarks.added,
  };
  ensureDeckProfile(record);
  record.quality = record.profile.quality;
  record.retryBudget = getRetryBudget(workflow.id);
  record.auditSummary = presentationSummary(record).auditSummary;
  const d = db();
  d.presentations = d.presentations || [];
  d.presentations.unshift(record);
  d.presentations = d.presentations.slice(0, 40);
  compactPresentations({ keep: 8 });
  persist();
  logActivity(
    'presentation',
    `${model ? 'AI' : 'Deterministic'} created a ${deck.slides.length}-slide flow review for "${workflow.name}" · ${audit.verdict}`,
    { deckId: record.id, verdict: audit.verdict }
  );
  return { ...record, auditLoaded: true };
}

function comparisonOf(before, after, run) {
  const beforeElements = new Map((before?.elements || []).map((element) => [element.index, element.status]));
  const afterElements = new Map((after?.elements || []).map((element) => [element.index, element.status]));
  const changed = [];
  for (const element of after?.elements || []) {
    const previous = beforeElements.get(element.index);
    if (previous && previous !== element.status) {
      changed.push({ step: element.stepName, before: previous, after: element.status });
    }
  }
  const beforeObserved = (before?.elements || []).filter((element) => ['observed', 'present'].includes(element.status)).length;
  const afterObserved = (after?.elements || []).filter((element) => ['observed', 'present'].includes(element.status)).length;
  return {
    beforeVerdict: before?.verdict || null,
    afterVerdict: after?.verdict || null,
    blockersDelta: (after?.blockers || []).length - (before?.blockers || []).length,
    warningsDelta: (after?.warnings || []).length - (before?.warnings || []).length,
    observedDelta: afterObserved - beforeObserved,
    changedElements: changed.slice(0, 12),
    run: run
      ? {
          id: run.id,
          status: run.status,
          mode: run.dryRun ? 'simulated' : 'live',
          passed: (run.steps || []).filter((step) => step.status === 'passed').length,
          total: (run.steps || []).length,
          failed: (run.steps || []).filter((step) => step.status === 'failed').map((step) => ({ name: step.name, error: clip(step.error || '', 220) })),
        }
      : null,
    summary:
      `Verdict ${before?.verdict || 'unknown'} → ${after?.verdict || 'unknown'}; ` +
      `blockers ${(before?.blockers || []).length} → ${(after?.blockers || []).length}; ` +
      `evidence ${beforeObserved} → ${afterObserved}; re-test ${run?.status || 'not recorded'}.`,
  };
}

function auditScreenshotRef(audit) {
  const shot = audit?.current?.screenshot;
  if (!shot) return null;
  return {
    id: shot.id || null,
    path: shot.path || null,
    url: shot.url || null,
    caption: shot.caption || '',
    marks: (shot.marks || []).length,
    width: shot.width || null,
    height: shot.height || null,
  };
}

function appendLineage(deck, event) {
  if (!deck) return null;
  deck.lineage = deck.lineage || {
    rootDeckId: deck.id,
    parentDeckId: null,
    depth: 0,
    events: [],
  };
  deck.lineage.events = [event, ...(deck.lineage.events || [])].slice(0, 40);
  return deck.lineage;
}

/** Keep recent decks fully openable and compact older history without losing summaries or rechecks. */
export function compactPresentations({ keep = 8 } = {}) {
  const decks = db().presentations || [];
  let compacted = 0;
  decks.forEach((deck, index) => {
    if (index < keep || deck.compacted) return;
    const summary = presentationSummary(deck);
    deck.auditSummary = summary.auditSummary;
    deck.quality = summary.quality;
    deck.compacted = true;
    deck.compactedAt = now();
    deck.compactedBytes = Buffer.byteLength(JSON.stringify(deck.audit || {}), 'utf8');
    deck.slides = (deck.slides || []).map((slide) => ({
      kicker: slide.kicker,
      title: slide.title,
      bullets: (slide.bullets || []).slice(0, 2),
      note: '',
      image: null,
    }));
    deck.audit = null;
    deck.notes = (deck.notes || []).slice(0, 3);
    deck.rechecks = (deck.rechecks || []).slice(0, 3);
    deck.profile = null;
    compacted += 1;
  });
  if (compacted) {
    persist();
    logActivity('presentation', `Compacted ${compacted} older deck(s); summaries and rechecks kept`, { compacted });
  }
  return { compacted, keep };
}

export async function reapplyPresentation(id) {
  const deck = (db().presentations || []).find((entry) => entry.id === id);
  if (!deck) throw new Error('Presentation not found');
  if (deck.control?.paused) {
    throw new Error(deck.control.reason || 'Re-tests are paused for this deck. Resume them before trying again.');
  }
  const workflow = db().workflows.find((entry) => entry.id === deck.workflowId);
  if (!workflow) throw new Error('The workflow for this presentation no longer exists');
  const budget = canRetry(workflow.id, 'deck');
  if (!budget.ok) throw new Error(budget.reason);
  const mission = deck.missionId ? db().missions.find((entry) => entry.id === deck.missionId) : null;
  const before = deck.audit || auditPresentation({ workflowId: workflow.id, missionId: mission?.id || null });
  const fresh = await captureFreshEvidence(workflow, mission);
  let run = null;
  let testError = fresh.error || '';
  try {
    run = createRun(workflow, {
      trigger: 'presentation-recheck',
      dryRun: true,
      workflowSnapshot: workflow,
      shadowProposalId: deck.id,
      agentRole: 'presentation-auditor',
    });
    run = await waitForRun(run.id, { timeoutMs: 90000, intervalMs: 150 });
  } catch (err) {
    testError = [testError, err.message].filter(Boolean).join(' ');
  }
  let after = auditPresentation({ workflowId: workflow.id, missionId: mission?.id || null });
  let visualNote = '';
  try {
    const inspection = await inspectScreenshot(workflow, after);
    if (inspection.visual) after = mergeVisualFindings(after, inspection.visual);
    visualNote = inspection.note || '';
  } catch (err) {
    visualNote = `Visual check could not run: ${err.message}`;
  }
  if (!after.visual?.available && visualNote) {
    after = { ...after, visual: { ...(after.visual || {}), available: false, note: visualNote } };
  }
  const autoMarks = applyAutoMarks(after);
  if (autoMarks.added && !visualNote) visualNote = `Auto-drew ${autoMarks.added} visual finding(s) onto the fresh capture.`;
  const comparison = comparisonOf(before, after, run);
  comparison.screenshots = {
    before: auditScreenshotRef(before),
    after: auditScreenshotRef(after),
  };
  const failedAttempt = Boolean(testError) || run?.status === 'failed' || after.verdict === 'blocked';
  const maxFailedAttempts = Math.max(1, Number(deck.attempts?.maxFailedAttempts) || 3);
  const consecutive = failedAttempt ? Number(deck.attempts?.consecutive || 0) + 1 : 0;
  deck.attempts = {
    consecutive,
    total: Number(deck.attempts?.total || 0) + 1,
    maxFailedAttempts,
    lastAt: now(),
    lastStatus: testError
      ? 'capture_or_test_error'
      : failedAttempt
        ? after.verdict === 'blocked'
          ? 'blocked'
          : run?.status || 'failed'
        : run?.status || after.verdict,
  };
  if (consecutive >= maxFailedAttempts && !deck.control?.manual) {
    deck.control = {
      paused: true,
      manual: false,
      reason: `Paused after ${consecutive} consecutive failed re-tests. Review the deck, repair the workflow, then resume.`,
      at: now(),
    };
  }
  const recheck = {
    id: uid('rch'),
    at: now(),
    runId: run?.id || null,
    error: testError || null,
    freshCapture: fresh.capture
      ? { id: fresh.capture.id, path: fresh.capture.path, simulated: fresh.capture.simulated, caption: fresh.capture.caption }
      : null,
    visualNote: visualNote || null,
    autoMarks: autoMarks.added,
    comparison,
  };
  deck.audit = after;
  deck.auditSummary = null;
  deck.compacted = false;
  deck.compactedAt = null;
  deck.rechecks = [recheck, ...(deck.rechecks || [])].slice(0, 10);
  deck.review = { status: 'needs_review', comment: '', at: null };
  deck.updatedAt = now();
  deck.retryBudget = recordRetryOutcome(workflow.id, {
    ok: !failedAttempt,
    source: 'deck-recheck',
    reason: testError || run?.failureSignature || comparison.summary,
  });
  appendLineage(deck, {
    type: 'recheck',
    at: recheck.at,
    verdict: after.verdict,
    runId: run?.id || null,
    summary: comparison.summary,
  });
  if (consecutive >= maxFailedAttempts && !deck.control?.manual) {
    const existing = deck.proposalId ? (db().proposals || []).find((entry) => entry.id === deck.proposalId) : null;
    await maybeCreateRepairProposal(deck, {
      consecutive,
      maxFailedAttempts,
      existing,
      create: async () => (await proposalFromPresentation(deck.id)).proposal,
    });
  }
  ensureDeckProfile(deck);
  deck.quality = deck.profile.quality;
  deck.auditSummary = presentationSummary(deck).auditSummary;
  persist();
  logActivity(
    'presentation',
    `Re-tested "${workflow.name}" for deck ${deck.id}: ${comparison.summary}`,
    { deckId: deck.id, runId: run?.id || null, verdict: after.verdict, freshCaptureId: fresh.capture?.id || null }
  );
  return { deck: { ...deck, auditLoaded: true, retryBudget: getRetryBudget(workflow.id) }, recheck };
}

export function setPresentationControl(id, { action = 'pause' } = {}) {
  const deck = (db().presentations || []).find((entry) => entry.id === id);
  if (!deck) throw new Error('Presentation not found');
  const next = String(action || '').toLowerCase();
  if (next === 'pause') {
    deck.control = {
      paused: true,
      manual: true,
      reason: 'Manual pause by the operator. Resume when the workflow or evidence is ready.',
      at: now(),
    };
  } else if (next === 'resume') {
    deck.control = { paused: false, manual: false, reason: null, at: now() };
    deck.autoProposalError = null;
    setRetryBudget(deck.workflowId, { action: 'resume' });
    deck.attempts = {
      consecutive: 0,
      total: Number(deck.attempts?.total || 0),
      maxFailedAttempts: Number(deck.attempts?.maxFailedAttempts) || 3,
      lastAt: deck.attempts?.lastAt || null,
      lastStatus: deck.attempts?.lastStatus || null,
    };
  } else if (next === 'reset') {
    deck.control = { paused: false, manual: false, reason: null, at: now() };
    deck.autoProposalError = null;
    setRetryBudget(deck.workflowId, { action: 'reset' });
    deck.attempts = { consecutive: 0, total: 0, maxFailedAttempts: Number(deck.attempts?.maxFailedAttempts) || 3, lastAt: null, lastStatus: null };
  } else {
    throw new Error('Unknown control action. Use pause, resume or reset.');
  }
  deck.updatedAt = now();
  ensureDeckProfile(deck);
  persist();
  logActivity('presentation', `Deck ${deck.id} retry control: ${next}`, { deckId: deck.id, action: next });
  return { ...deck, auditLoaded: true, retryBudget: getRetryBudget(deck.workflowId) };
}

export async function proposalFromPresentation(id) {
  const deck = (db().presentations || []).find((entry) => entry.id === id);
  if (!deck) throw new Error('Presentation not found');
  const audit = deck.audit || {};
  const goalParts = [
    `Repair and verify "${deck.workflowName}" from a saved presentation audit.`,
    audit.summary || '',
    ...(audit.blockers || []).slice(0, 4).map((blocker) => `Blocker: ${blocker.label} — ${blocker.detail}`),
    ...(audit.suggestions || []).slice(0, 5).map((suggestion) => `Suggestion: ${suggestion.title} — ${suggestion.detail}`),
    'Keep the proven steps and add waits, foreground guards, or an independent verification where the evidence is missing. Do not invent a successful element check.',
  ].filter(Boolean);
  const proposal = await createProposal({
    workflowId: deck.workflowId,
    goal: goalParts.join('\n').slice(0, 1800),
    source: 'presentation-audit',
  });
  deck.proposalId = proposal.id;
  deck.updatedAt = now();
  appendLineage(deck, {
    type: 'proposal',
    at: deck.updatedAt,
    proposalId: proposal.id,
    summary: `Created repair proposal ${proposal.id}.`,
  });
  ensureDeckProfile(deck);
  persist();
  logActivity('presentation', `Created repair proposal ${proposal.id} from deck ${deck.id}`, { deckId: deck.id, proposalId: proposal.id });
  return { deck: { ...deck, auditLoaded: true, retryBudget: getRetryBudget(deck.workflowId) }, proposal };
}

export function reviewPresentation(id, { status = 'reviewed', comment = '' } = {}) {
  const deck = (db().presentations || []).find((entry) => entry.id === id);
  if (!deck) throw new Error('Presentation not found');
  const next = ['reviewed', 'needs_review', 'unreviewed'].includes(status) ? status : 'reviewed';
  deck.review = { status: next, comment: String(comment || '').slice(0, 600), at: now() };
  deck.updatedAt = now();
  appendLineage(deck, { type: 'review', at: deck.review.at, review: next, summary: `Operator review: ${next}.` });
  ensureDeckProfile(deck);
  persist();
  logActivity('presentation', `Marked deck ${deck.id} as ${next}`, { deckId: deck.id });
  return { ...deck, auditLoaded: Boolean(deck.audit), retryBudget: getRetryBudget(deck.workflowId) };
}

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function exportPresentation(id, format = 'md') {
  const deck = (db().presentations || []).find((entry) => entry.id === id);
  if (!deck) throw new Error('Presentation not found');
  const audit = deck.audit || {};
  const summary = presentationSummary(deck);
  const lines = [
    `# ${deck.title || deck.workflowName || deck.id}`,
    '',
    deck.subtitle || '',
    '',
    `- Workflow: ${deck.workflowName || deck.workflowId}`,
    `- Verdict: ${summary.auditSummary.verdict}`,
    `- Quality: ${summary.quality?.score ?? '—'}/100 (${summary.quality?.grade || '—'})`,
    `- Focus: ${deck.focus || 'auto'}`,
    `- Created: ${deck.createdAt || ''}`,
    `- Lineage: root ${summary.lineage?.rootDeckId || deck.id}; parent ${summary.lineage?.parentDeckId || 'none'}`,
    '',
    '## Audit',
    '',
    summary.auditSummary.summary || 'No audit summary.',
    '',
  ];
  for (const [index, slide] of (deck.slides || []).entries()) {
    lines.push(`## ${index + 1}. ${slide.title || ''}`, '', slide.kicker || '', '');
    for (const bullet of slide.bullets || []) lines.push(`- ${bullet}`);
    if (slide.note) lines.push('', slide.note);
    if (slide.image?.caption) lines.push('', `Screenshot: ${slide.image.caption}`);
    lines.push('');
  }
  if ((audit.blockers || []).length) {
    lines.push('## Blockers', '');
    for (const blocker of audit.blockers) lines.push(`- **${blocker.label}**: ${blocker.detail}`);
    lines.push('');
  }
  if ((audit.warnings || []).length) {
    lines.push('## Warnings', '');
    for (const warning of audit.warnings) lines.push(`- **${warning.label}**: ${warning.detail}`);
    lines.push('');
  }
  if ((audit.suggestions || []).length) {
    lines.push('## Suggestions', '');
    for (const suggestion of audit.suggestions) lines.push(`- **${suggestion.title}**: ${suggestion.detail}`);
    lines.push('');
  }
  if ((deck.rechecks || []).length) {
    lines.push('## Re-tests', '');
    for (const recheck of deck.rechecks.slice(0, 5)) lines.push(`- ${recheck.at}: ${recheck.comparison?.summary || recheck.visualNote || 'no summary'}`);
    lines.push('');
  }
  lines.push('## Lineage events', '');
  for (const event of summary.lineage?.events || []) lines.push(`- ${event.at}: ${event.type} — ${event.summary || ''}`);
  const markdown = lines.join('\n');
  if (String(format).toLowerCase() !== 'html') return markdown;
  const slidesHtml = (deck.slides || [])
    .map(
      (slide, index) => `
        <section class="slide">
          <p class="kicker">${htmlEscape(slide.kicker || '')}</p>
          <h2>${index + 1}. ${htmlEscape(slide.title || '')}</h2>
          <ul>${(slide.bullets || []).map((bullet) => `<li>${htmlEscape(bullet)}</li>`).join('')}</ul>
          ${slide.note ? `<p class="note">${htmlEscape(slide.note)}</p>` : ''}
          ${slide.image?.url ? `<img src="${htmlEscape(slide.image.url)}" alt="${htmlEscape(slide.image.caption || 'screenshot')}">` : ''}
        </section>`
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(deck.title || deck.workflowName || deck.id)}</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;background:#0f1115;color:#e8ecf3;margin:0;padding:48px;line-height:1.55}
main{max-width:900px;margin:auto}h1{font-size:34px;margin:0 0 6px}h2{font-size:22px;margin:0 0 10px}.kicker{text-transform:uppercase;letter-spacing:.12em;color:#74d7c4;font-size:12px}
.meta{color:#9aa5b5;margin-bottom:34px}.slide{background:#171b23;border:1px solid #283142;border-radius:16px;padding:24px;margin:18px 0}.note{color:#aab5c5}.slide img{max-width:100%;border-radius:12px;margin-top:12px}
.badge{display:inline-block;padding:3px 10px;border-radius:99px;background:#243244;color:#9fe7d8}.blocker{color:#ff9b9b}.warning{color:#ffd28a}
</style></head><body><main>
<h1>${htmlEscape(deck.title || deck.workflowName || deck.id)}</h1>
<p class="meta">${htmlEscape(deck.subtitle || '')} · <span class="badge">${htmlEscape(summary.auditSummary.verdict)}</span> · quality ${htmlEscape(summary.quality?.score ?? '—')}/100 (${htmlEscape(summary.quality?.grade || '—')})</p>
<p>${htmlEscape(summary.auditSummary.summary || '')}</p>
${slidesHtml}
${(audit.blockers || []).map((blocker) => `<p class="blocker"><strong>${htmlEscape(blocker.label)}</strong>: ${htmlEscape(blocker.detail)}</p>`).join('')}
${(audit.warnings || []).map((warning) => `<p class="warning"><strong>${htmlEscape(warning.label)}</strong>: ${htmlEscape(warning.detail)}</p>`).join('')}
<h2>Lineage</h2><ul>${(summary.lineage?.events || []).map((event) => `<li>${htmlEscape(event.at)} — ${htmlEscape(event.type)}: ${htmlEscape(event.summary || '')}</li>`).join('')}</ul>
</main></body></html>`;
}
