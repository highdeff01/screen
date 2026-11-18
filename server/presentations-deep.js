/**
 * Presentations from deep focus — the re-think becomes a shareable deck.
 *
 * A deep-focus cycle already holds the story of a run: what ran, what failed,
 * what the live desktop looked like during every round, the reflex findings,
 * the reshape diff and the conclusion. This module turns that story into the
 * same deck format the Presentation page already renders, reusing the standard
 * generator for the workflow context and appending the focus rounds as
 * evidence slides — so conclusions travel with their proof, not as a summary
 * without backing.
 */
import { db, logActivity, now, persist, uid } from './store.js';
import { generatePresentation } from './presentations.js';
import { deepFocusStatus } from './deep-focus.js';

/** Build the evidence slides from the focus rounds themselves. */
function focusSlides(focus) {
  const slides = [];
  for (const round of focus.rounds || []) {
    const problems = Object.entries(round.reflexes || {})
      .filter(([, check]) => check.ok === false)
      .map(([name]) => name);
    slides.push({
      kind: 'evidence',
      title: `Focus round ${round.index}`,
      body: [
        `Foreground: ${round.foreground || 'nothing in front'}${round.process ? ` (${round.process})` : ''}`,
        round.caret ? `Caret: ${round.caret}` : '',
        round.note || '',
        problems.length ? `Reflex alerts: ${problems.join(', ')}` : 'Reflexes clear',
      ].filter(Boolean).join(' · '),
      decision: round.decision,
      at: round.at,
      image: null,
    });
  }
  if (focus.diff) {
    slides.push({
      kind: 'evidence',
      title: 'Reshape diff',
      body: [
        `${focus.diff.added.length} added, ${focus.diff.removed.length} removed, ${focus.diff.kept} kept in place`,
        ...(focus.diff.added || []).map((step) => `+ ${step.type}: ${step.name || ''}`),
        ...(focus.diff.removed || []).map((step) => `− ${step.type}: ${step.name || ''}`),
      ].join(' · '),
      decision: 'reshape',
      at: focus.finishedAt || now(),
      image: null,
    });
  }
  if (focus.conclusion) {
    slides.push({
      kind: 'conclusion',
      title: 'Conclusion',
      body: focus.conclusion,
      decision: 'conclude',
      at: focus.finishedAt || now(),
      image: null,
    });
  }
  return slides;
}

/** Generate (or refresh) the deck for this run's workflow and add the focus slides. */
export async function presentationFromDeepFocus(runId) {
  const run = db().runs.find((entry) => entry.id === runId);
  if (!run) throw new Error('Run not found');
  const focus = deepFocusStatus(runId);
  if (!focus) throw new Error('This run has no deep-focus cycle yet — start one first.');
  const workflow = db().workflows.find((entry) => entry.id === run.workflowId);
  if (!workflow) throw new Error('Workflow for this run no longer exists');

  const deck = await generatePresentation({ workflowId: workflow.id, focus: 'problem' });
  const stored = (db().presentations || []).find((entry) => entry.id === deck?.id) || deck;
  stored.deepFocus = {
    runId,
    at: now(),
    slides: focusSlides(focus),
    conclusion: focus.conclusion || '',
  };
  stored.updatedAt = now();
  persist();
  logActivity('deep-focus', `Presentation formed from deep focus on ${run.workflowName}`, { runId, deckId: stored.id });
  return stored;
}

/** Render just the deep-focus slides as markdown — the quick export. */
export function deepFocusMarkdown(runId) {
  const focus = deepFocusStatus(runId);
  if (!focus) throw new Error('This run has no deep-focus cycle.');
  const lines = [`# Deep focus — ${focus.reason || 'run review'}`, ''];
  for (const slide of focusSlides(focus)) {
    lines.push(`## ${slide.title}`, '', slide.body, '');
  }
  return lines.join('\n');
}

export { uid as __uid };
