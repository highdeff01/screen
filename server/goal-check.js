/**
 * The per-agent goal checker.
 *
 * Every agent in the console has a standing job, and each action it takes is
 * supposed to move that job forward. This module answers the same five
 * questions about the agent's goal after every action ("command") and every
 * screen change, in one record:
 *
 *   complete          — proved, disproved, or not determined by this evidence
 *   remaining         — the goal requirements the evidence does not cover
 *   wentWrong         — the failure the action actually produced
 *   tryNext           — the concrete next move, derived from what remains
 *   helpfulElements   — controls visible on screen that serve those requirements
 *
 * The goal is read as a short list of requirements (one per clause), and each
 * requirement is looked for in evidence the action already produced: the
 * command's output and exit code, the agent's own recent log, the labels on the
 * screen, the steps of a run. Nothing here guesses: a goal is `complete` only
 * when a command's evidence covers every requirement, `incomplete` when a
 * command or a run step failed, and `unknown` otherwise — a visible Save button
 * proves the goal is actionable, not that it was achieved, so a screen read
 * never claims completion.
 *
 * Pure: no model call, no desktop read, no database. The caller supplies the
 * command result, the screen read and the goal, so a record can be replayed and
 * tested. `recordGoalCheck` / `checkAgentAction` only write to the agent object
 * the caller hands them.
 */

/** Requirements read from one goal. A goal longer than this is a paragraph. */
export const GOAL_CHECK_MAX = 8;
/** Checks kept per agent: enough to see the trend, small enough for every poll. */
export const GOAL_CHECK_TRACE = 8;

/** A requirement counts as covered at this share of its words. */
const COVERED_SHARE = 0.6;

const STOPWORDS = new Set([
  'the', 'and', 'that', 'with', 'for', 'from', 'into', 'then', 'than', 'when', 'what', 'which',
  'this', 'these', 'those', 'their', 'there', 'every', 'each', 'any', 'all', 'has', 'have', 'had',
  'are', 'was', 'were', 'will', 'would', 'should', 'must', 'can', 'could', 'may', 'might', 'not',
  'but', 'its', 'it', 'is', 'to', 'of', 'in', 'on', 'at', 'as', 'by', 'or', 'a', 'an', 'be', 'been',
  'do', 'does', 'did', 'up', 'out', 'if', 'so', 'own', 'via', 'while', 'once', 'until', 'about',
  'your', 'you', 'our', 'we', 'they', 'them', 'his', 'her', 'he', 'she', 'him', 'me', 'my', 'i',
]);

/**
 * What a verb in the goal asks for, as a next move and the control roles that
 * serve it. Used for "what to try next" and for ranking helpful controls; it is
 * advice, never an action the checker takes itself.
 */
const VERB_HINTS = {
  open: { next: 'Bring the app or page forward, then read the window again.', roles: ['button', 'menuitem', 'tab'] },
  launch: { next: 'Launch the app, wait for its window, then read it.', roles: ['button'] },
  start: { next: 'Start the thing the goal names, then confirm the screen changed.', roles: ['button'] },
  go: { next: 'Navigate to the named page and confirm the address.', roles: ['tab', 'link', 'edit'] },
  navigate: { next: 'Navigate to the named page and confirm the address.', roles: ['tab', 'link', 'edit'] },
  click: { next: 'Find the control by its exact label and click it once.', roles: ['button', 'menuitem', 'link', 'tab'] },
  press: { next: 'Press the shortcut the goal names in the focused window.', roles: [] },
  select: { next: 'Choose the named option from the list or menu.', roles: ['combobox', 'listitem', 'menuitem'] },
  choose: { next: 'Choose the named option from the list or menu.', roles: ['combobox', 'listitem', 'menuitem'] },
  type: { next: 'Click the field first, then type the value the goal names.', roles: ['edit', 'document'] },
  enter: { next: 'Click the field, type the value, then submit it.', roles: ['edit', 'document', 'button'] },
  fill: { next: 'Fill the named field, then move to the next one.', roles: ['edit', 'combobox'] },
  write: { next: 'Write the named text where the goal says it belongs.', roles: ['edit', 'document'] },
  search: { next: 'Click the search box, type the query, then submit it.', roles: ['edit', 'button'] },
  save: { next: 'Click Save (or press the save shortcut), then confirm the saved state.', roles: ['button', 'menuitem'] },
  submit: { next: 'Submit the form, then confirm the result page.', roles: ['button'] },
  confirm: { next: 'Confirm the dialog, then read the screen it returns to.', roles: ['button', 'checkbox'] },
  install: { next: 'Run the install step, then verify the installed app on screen.', roles: ['button'] },
  download: { next: 'Run the download step, then verify the file exists.', roles: ['button', 'link'] },
  verify: { next: 'Capture the screen and assert the state the goal names.', roles: [] },
  check: { next: 'Read the state the goal names and record whether it holds.', roles: [] },
  test: { next: 'Run the test and compare its result with the expectation.', roles: [] },
  watch: { next: 'Read the screen again; the watch continues until the goal state shows.', roles: [] },
  monitor: { next: 'Read the screen again and compare it with the last sample.', roles: [] },
  capture: { next: 'Capture the window and keep the frame as evidence.', roles: [] },
  record: { next: 'Record the evidence the goal asks for, then read the result.', roles: [] },
  review: { next: 'Open the item under review and record the decision.', roles: [] },
  triage: { next: 'Open the failed run, read its error, and record the triage.', roles: [] },
  diagnose: { next: 'Read the failure and record the cause before changing a step.', roles: [] },
  note: { next: 'Write the note with the facts the last action produced.', roles: [] },
  keep: { next: 'Leave the working state as it is and re-check after the next action.', roles: [] },
};

const tidy = (value, max = 0) => {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return max && text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
};

const normalize = (value) => String(value == null ? '' : value).toLowerCase();

function words(text) {
  return normalize(text).match(/[a-z0-9][a-z0-9'’-]*/g) || [];
}

/**
 * The words of one clause worth looking for in evidence. Short words and the
 * clause's own verb are dropped: the verb is checked through the command name
 * and the hint, and a word like "the" would match anything.
 */
function requirementKeywords(clause, verb) {
  const unique = [...new Set(words(clause))];
  // Only the clause's own verb is dropped. A word that can also be a verb is
  // still a noun here: “write a triage note” needs “note” to be looked for.
  const keywords = unique.filter((word) => word.length >= 3 && !STOPWORDS.has(word) && word !== verb);
  return keywords.slice(0, 8);
}

/**
 * Read a goal as requirements. One clause per requirement, each with the verb
 * it starts from and the words that count as evidence that it happened.
 */
export function goalRequirements(goal) {
  const text = tidy(goal, 600);
  if (!text) return [];
  const clauses = text
    .split(/[.;!?\n]+|\s+(?:and|then)\s+|\s*,\s*/i)
    .map((clause) => clause.replace(/^[-•*·\d\s.):]+/, '').replace(/^(?:and|then|next|also|finally)\s+/i, '').trim())
    .filter((clause) => clause.length >= 3 && words(clause).length > 0);
  const seen = new Set();
  const requirements = [];
  for (const clause of clauses) {
    const key = clause.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const tokens = words(clause);
    const verb = tokens.find((token) => VERB_HINTS[token]) || '';
    const keywords = requirementKeywords(clause, verb);
    if (!keywords.length && verb) keywords.push(verb);
    requirements.push({
      id: `req${requirements.length + 1}`,
      text: tidy(clause, 160),
      verb,
      keywords,
      hint: VERB_HINTS[verb]?.next || 'Read the screen and the last result, then record what changed.',
      roles: VERB_HINTS[verb]?.roles || [],
    });
    if (requirements.length >= GOAL_CHECK_MAX) break;
  }
  return requirements;
}

/** Controls the screen read offered, from labels, element records or both. */
export function screenElements(screen) {
  if (!screen || typeof screen !== 'object') return [];
  const list = [];
  const add = (label, role, x, y) => {
    const text = tidy(label, 80);
    if (!text) return;
    if (list.some((entry) => entry.label.toLowerCase() === text.toLowerCase())) return;
    list.push({
      label: text,
      role: tidy(role, 40).toLowerCase(),
      x: Number.isFinite(Number(x)) ? Number(x) : null,
      y: Number.isFinite(Number(y)) ? Number(y) : null,
    });
  };
  for (const entry of Array.isArray(screen.elements) ? screen.elements : []) {
    if (entry && typeof entry === 'object') add(entry.label ?? entry.name ?? entry.text, entry.role ?? entry.controlType, entry.x, entry.y);
    else add(entry);
  }
  for (const label of Array.isArray(screen.labels) ? screen.labels : []) add(label);
  return list.slice(0, 120);
}

function commandEvidence(command) {
  if (!command || typeof command !== 'object') return '';
  // The invocation is not evidence: “winget install VLC” says what was tried,
  // not that VLC was installed. Only what the command produced counts.
  const parts = [
    command.ok === false ? 'failed' : command.ok === true ? 'succeeded ok' : '',
    command.code != null ? `exit ${command.code}` : '',
    command.error,
    command.stderr,
    command.stdout,
    command.output,
    command.summary,
  ];
  if (Array.isArray(command.evidence)) parts.push(...command.evidence);
  return tidy(parts.filter(Boolean).join(' \n '), 6000);
}

function runEvidence(run) {
  if (!run || typeof run !== 'object') return '';
  const steps = Array.isArray(run.steps) ? run.steps : [];
  return tidy(
    [
      run.status,
      run.workflowName,
      run.goal,
      run.analysis?.summary,
      ...(Array.isArray(run.analysis?.nextActions) ? run.analysis.nextActions : []),
      ...steps.map((step) => `${step.name || ''} ${step.type || ''} ${step.status || ''} ${step.error || ''} ${step.output || ''}`),
    ]
      .filter(Boolean)
      .join(' \n '),
    6000
  );
}

/** Does this requirement's own words appear in the evidence? */
function requirementCovered(requirement, evidence) {
  const keywords = Array.isArray(requirement.keywords) ? requirement.keywords : [];
  if (!keywords.length) return false;
  const hits = keywords.filter((keyword) => evidence.includes(keyword)).length;
  return hits / keywords.length >= COVERED_SHARE;
}

/**
 * Rank the visible controls that serve the goal.
 *
 * A label that repeats a remaining requirement's words is the strongest hint; a
 * control whose role matches the requirement's verb (a button for "click", an
 * edit for "type") is weaker but still useful. The order is deterministic: score
 * first, then the label, so the same screen always yields the same list.
 */
function helpfulElements(screen, requirements, goal) {
  const elements = screenElements(screen);
  if (!elements.length) return [];
  const goalWords = new Set(words(goal).filter((word) => word.length >= 3 && !STOPWORDS.has(word)));
  return elements
    .map((element) => {
      const label = normalize(element.label);
      let score = 0;
      const reasons = [];
      for (const requirement of requirements) {
        const terms = Array.isArray(requirement.terms) ? requirement.terms : requirement.keywords || [];
        const hits = terms.filter((keyword) => label.includes(keyword) || keyword.includes(label));
        if (hits.length) {
          score += hits.length * 2;
          reasons.push(`matches “${hits[0]}” in the goal`);
        }
        // The verb is what the control would be used for, so a button that says
        // “Save” for a “save the form” requirement outranks a heading that
        // merely repeats a noun from it.
        if (requirement.verb && hits.includes(requirement.verb)) score += 3;
        if (requirement.roles?.includes(element.role)) {
          score += 1;
          reasons.push(`a ${element.role} the “${requirement.verb || 'next'}” requirement needs`);
        }
      }
      if (!reasons.length) {
        const shared = words(element.label).filter((word) => goalWords.has(word));
        if (shared.length) {
          score += shared.length;
          reasons.push(`mentions “${shared[0]}”`);
        }
      }
      return { element, score, why: reasons[0] || '' };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.element.label.localeCompare(right.element.label))
    .slice(0, 6)
    .map((entry) => ({
      label: entry.element.label,
      role: entry.element.role,
      why: entry.why,
      x: entry.element.x,
      y: entry.element.y,
    }));
}

function summarizeValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return tidy(value, 500);
  try {
    const text = JSON.stringify(value, (key, entry) => {
      if (typeof entry === 'string') return entry.slice(0, 240);
      if (Array.isArray(entry) && entry.length > 6) return [...entry.slice(0, 6), `…${entry.length - 6} more`];
      return entry;
    });
    return tidy(text, 1200);
  } catch {
    return '';
  }
}

/**
 * Where does the goal stand?
 *
 * @param {object} input
 * @param {string} input.goal       the agent's goal, as the operator wrote it
 * @param {'command'|'screen'} [input.trigger]
 * @param {object|null} [input.command]  what the agent just ran and its result
 * @param {object|null} [input.screen]   { title, process, labels, elements, error }
 * @param {object|null} [input.run]      a run whose steps are the evidence
 * @param {string|null} [input.at]       ISO timestamp; the caller owns the clock
 * @param {boolean} [input.allowInference] may covering every requirement by the
 *   evidence mean the goal is complete? False for an agent tick, whose result is
 *   one partial pass over a possibly larger queue: only the agent's own
 *   `goalComplete` may settle it there.
 */
export function checkGoal({
  goal = '',
  trigger = 'command',
  command = null,
  screen = null,
  run = null,
  at = null,
  allowInference = true,
  evidenceSteps = null,
  activity = 'tick',
} = {}) {
  const statedGoal = tidy(goal, 600);
  const requirements = goalRequirements(statedGoal);
  // Only what the action produced counts as evidence that a requirement
  // happened. A label on screen is not proof: the screen is used for what it
  // offers next (helpful controls), and completion stays unknown there.
  const evidence = normalize(
    [commandEvidence(command), runEvidence(run && evidenceSteps ? { ...run, steps: evidenceSteps } : run)]
      .filter(Boolean)
      .join(' \n ')
  );
  const checked = requirements.map((requirement) => ({
    ...requirement,
    // Elements are matched on the verb too: for “save the form”, the Save button
    // is the control that helps, even though the verb is not evidence of the save.
    terms: [...new Set([...(requirement.verb ? [requirement.verb] : []), ...requirement.keywords])],
    covered: requirementCovered(requirement, evidence),
  }));
  const uncovered = checked.filter((requirement) => !requirement.covered);

  const failedCommand = Boolean(
    command &&
      (command.ok === false ||
        (command.code != null && Number(command.code) !== 0) ||
        command.error)
  );
  const skipped = tidy(command?.skipped, 160);
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const failedSteps = steps.filter((step) => String(step?.status || '') === 'failed');
  const settledRun = run && ['passed', 'failed', 'needs_review', 'cancelled'].includes(String(run.status || ''));

  let complete = null;
  if (!statedGoal) complete = null;
  else if (failedCommand || failedSteps.length || String(run?.status || '') === 'failed') complete = false;
  else if (skipped) complete = null;
  else if (typeof command?.complete === 'boolean') complete = command.complete;
  else if (settledRun) complete = run.status === 'passed' && run.presenter?.summary?.goalMet !== false;
  // A screen read shows what could be done next, never that it was done: a
  // visible Save button is not a saved form.
  else if (allowInference && trigger === 'command' && checked.length && !uncovered.length && evidence) complete = true;
  const status = complete === true ? 'complete' : complete === false ? 'incomplete' : 'unknown';

  // A tick that found nothing to do has nothing outstanding right now: the goal
  // is a standing duty, not a checklist item the empty tick failed to close.
  const remaining = skipped
    ? []
    : uncovered.slice(0, GOAL_CHECK_MAX).map((requirement) => ({
        requirement: requirement.id,
        text: requirement.text,
        why: `${requirement.keywords.slice(0, 3).join(', ') || requirement.verb || 'the requirement'} ${
          trigger === 'screen' ? 'is not among the labels on screen' : 'is not in the last result'
        }`,
      }));
  for (const step of skipped ? [] : steps) {
    if (remaining.length >= GOAL_CHECK_MAX) break;
    if (!['pending', 'running', 'failed'].includes(String(step?.status || ''))) continue;
    remaining.push({
      requirement: '',
      text: `Step “${tidy(step.name || step.type, 70)}” ${step.status}`,
      why: tidy(step.error, 160) || 'the run has not finished this step',
    });
  }

  const wentWrong = [];
  if (failedCommand) {
    const detail = tidy(
      [command.stderr, command.error, command.code != null ? `exit ${command.code}` : '', command.stdout]
        .filter(Boolean)
        .join(' · '),
      220
    );
    wentWrong.push({ what: `command “${tidy(command.name || command.label || 'run', 60)}” failed`, detail });
  }
  if (screen?.error) wentWrong.push({ what: 'the screen could not be read', detail: tidy(screen.error, 160) });
  for (const step of failedSteps.slice(0, 3)) {
    wentWrong.push({ what: `step “${tidy(step.name || step.type, 60)}” failed`, detail: tidy(step.error, 200) });
  }
  if (String(run?.status || '') === 'needs_review') {
    wentWrong.push({
      what: 'the run needs review',
      detail: tidy(run.errorSummary || run.analysis?.summary, 200) || 'the steps passed without proving the goal',
    });
  }

  const helpers = helpfulElements(screen, uncovered.length ? uncovered : checked, statedGoal);
  const tryNext = [];
  // A tick that found no work has nothing to try: saying what to do next would
  // invent work the agent just checked for and did not find.
  if (skipped) {
    tryNext.push(`Nothing to do: ${skipped}; the check runs again on the next action or screen change.`);
  } else {
    for (const requirement of uncovered.slice(0, 3)) {
      tryNext.push(`${requirement.hint} (goal: “${tidy(requirement.text, 90)}”)`);
    }
    if (failedCommand) {
      tryNext.push(
        `Fix the failure above before re-running ${tidy(command.name || 'the command', 40)}; the next output is the evidence.`
      );
    }
    if (helpers.length) {
      tryNext.push(`Start with “${helpers[0].label}”${screen?.title ? ` in “${tidy(screen.title, 70)}”` : ''}.`);
    }
  }
  if (!tryNext.length) {
    tryNext.push(
      status === 'complete'
        ? 'Nothing remains; re-check after the next action changes the screen.'
        : 'Read the screen and the last result again — neither proves the goal yet.'
    );
  }

  const proven = checked.filter((requirement) => requirement.covered).length;
  const actor = activity === 'step' ? 'this step' : 'the tick';
  const note = !statedGoal
    ? 'No goal is set for this agent, so there is nothing to check yet.'
    : status === 'complete'
      ? `Goal proved by the last command (${proven}/${checked.length} requirement(s)).`
      : status === 'incomplete'
        ? wentWrong[0]
          ? `Goal not met: ${wentWrong[0].what}.`
          : 'Goal not met: the agent reported it as not finished.'
        : skipped
          ? `Nothing to do: ${skipped}.`
          : !allowInference
            ? proven
              ? `${proven}/${checked.length} requirement(s) have evidence, but ${actor} did not report the goal finished.`
              : `${remaining.length} goal requirement(s) remain; ${actor} did not report the goal finished.`
            : `${proven}/${checked.length} goal requirement(s) have evidence; ${remaining.length} remain.`;

  return {
    at: at || new Date().toISOString(),
    trigger,
    goal: statedGoal,
    status,
    complete,
    proven,
    total: checked.length,
    requirements: checked.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      verb: requirement.verb,
      covered: requirement.covered,
    })),
    remaining,
    wentWrong,
    tryNext: tryNext.slice(0, 5),
    helpfulElements: helpers,
    screen: screen
      ? {
          title: tidy(screen.title, 90),
          process: tidy(screen.process, 60),
          elements: screenElements(screen).length,
          changedPct: Number.isFinite(Number(screen.changedPct)) ? Number(screen.changedPct) : null,
        }
      : null,
    command: command
      ? { name: tidy(command.name || command.label, 60), ok: command.ok !== false, code: command.code ?? null }
      : null,
    note,
  };
}

/**
 * Keep the check on the agent. The latest record is what the panel shows; the
 * short trace keeps the last few so a reader can see the goal move.
 */
export function recordGoalCheck(agent, check, { max = GOAL_CHECK_TRACE } = {}) {
  if (!agent || !check) return null;
  const previous = agent.goalCheck || null;
  const record = {
    ...check,
    agentId: agent.id || '',
    agentName: agent.name || agent.workflowName || '',
    previousStatus: previous?.status || null,
  };
  agent.goalCheck = record;
  const trace = Array.isArray(agent.goalChecks) ? agent.goalChecks : [];
  agent.goalChecks = [record, ...trace].slice(0, Math.max(1, Math.floor(Number(max) || GOAL_CHECK_TRACE)));
  return record;
}

/** The goal as the checker reads it: the declared one, else the agent's job. */
export function agentGoal(agent) {
  return tidy(agent?.goal, 600) || tidy(agent?.description, 600);
}

/**
 * Check an agent right after one of its actions.
 *
 * A tick that had nothing to do is recorded as unknown, not as a failure: the
 * agent did its job by finding no work, and claiming the goal is complete from
 * an empty tick would be a guess.
 *
 * The same rule covers a tick that did *some* of the work. A supervisor handles
 * two failed runs per tick by design, and its result only names those two; the
 * words match the goal, but the third run is still queued. So completion here
 * comes from one place only: the agent saying `goalComplete` itself.
 */
export function checkAgentAction(agent, result, { at = null } = {}) {
  if (!agent) return null;
  const skipped = result && typeof result === 'object' ? tidy(result.skipped, 160) : '';
  const command = {
    name: agent.kind || 'agent',
    label: agent.name || '',
    ok: !(result && typeof result === 'object' && result.error),
    error: tidy(result?.error, 300),
    stdout: summarizeValue(result),
    skipped: skipped || undefined,
    complete: result?.goalComplete === true ? true : result?.goalComplete === false ? false : undefined,
  };
  return recordGoalCheck(
    agent,
    checkGoal({ goal: agentGoal(agent), trigger: 'command', command, at, allowInference: false })
  );
}

/**
 * Should a screen change run this agent's check? Screen watching is opt-in: an
 * agent without a declared goal keeps the live map as cheap as it was, and a
 * check that just ran waits out the gap rather than paying for OCR per sample.
 */
export function shouldCheckScreen(
  agent,
  sample,
  { at = Date.now(), minChangePct = 2, minGapMs = 4000 } = {}
) {
  if (!agent || !sample) return false;
  if (!tidy(agent.goal, 600)) return false;
  if (agent.enabled === false) return false;
  if (sample.reused || sample.error) return false;
  if (Math.abs(Number(sample.changedPct) || 0) < minChangePct) return false;
  const last = Date.parse(agent.screenCheckedAt || '') || 0;
  return at - last >= minGapMs;
}

/**
 * Check a run's goal after one of its steps.
 *
 * The evidence is what the run has actually done so far. Pending steps are left
 * out of it on purpose: a step named “Click Save” would put the goal's own words
 * into the evidence before it ran, and a plan that has not run is not a plan that
 * did. They still appear in `remaining`, which is where the operator wants them.
 *
 * Completion is never inferred from a step's covering words, for the same reason
 * an agent tick does not: one step of a longer plan finishing is not the goal.
 * A failed step does settle it, in the negative.
 */
export function checkRunStep(run, step, { goal = '', at = null } = {}) {
  if (!run || !step) return null;
  const settled = (Array.isArray(run.steps) ? run.steps : []).filter((entry) =>
    ['passed', 'failed', 'skipped', 'superseded', 'unverified'].includes(String(entry?.status || ''))
  );
  const command = {
    name: step.name || step.type || 'step',
    label: step.type || 'step',
    ok: String(step.status || '') !== 'failed',
    error: String(step.status || '') === 'failed' ? tidy(step.error, 300) : '',
    stdout: tidy([step.output, step.error].filter(Boolean).join(' '), 2000),
  };
  return runGoalCheck(run, { goal, at, command, evidenceSteps: settled, step });
}

/** The verdict's own check: the run is settled, so it can say yes or no. */
export function checkRunGoal(run, { goal = '', at = null } = {}) {
  if (!run) return null;
  return runGoalCheck(run, { goal, at });
}

function runGoalCheck(run, { goal = '', at = null, command = null, evidenceSteps = null, step = null }) {
  const record = recordGoalCheck(
    run,
    checkGoal({
      goal: tidy(goal, 600) || tidy(run.goal, 600) || tidy(run.workflowGoal, 600) || tidy(run.workflowName, 600),
      trigger: 'command',
      command,
      run,
      evidenceSteps,
      at,
      allowInference: false,
      activity: 'step',
    })
  );
  if (record) {
    record.runId = run.id || '';
    record.workflowName = run.workflowName || '';
    record.stepId = step?.id || '';
    record.stepName = step ? step.name || step.type || '' : '';
    record.stepStatus = step?.status || '';
  }
  return record;
}

/** One line for a log or a toast. */
export function describeGoalCheck(check) {
  if (!check) return '';
  const label = check.status === 'complete' ? 'complete' : check.status === 'incomplete' ? 'not complete' : 'unproven';
  return `Goal ${label}: ${tidy(check.note, 200)}`;
}

export const __goalCheck = { VERB_HINTS, STOPWORDS, COVERED_SHARE, summarizeValue };
