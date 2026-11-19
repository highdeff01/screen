/**
 * Two judges, one verdict.
 *
 * A screen check used to be one model call reading a desktop photo. That alone
 * cannot tell the run's own window from a lookalike document, which is how a
 * verify step once passed on text left in an older file. So the same moment is
 * read twice:
 *
 *   facts  — deterministic and free: is the exact window this run opened in
 *            front, and does it contain (or lack) the expected text?
 *   vision — the existing model call, now shown only that window's pixels.
 *
 * The two verdicts are kept side by side. Agreement is a learned habit; a
 * repeated disagreement becomes a review suggestion (a switch or a condition
 * to adopt), and nothing is applied until the operator accepts it. No extra
 * model call is ever made for the second judge.
 */
import { db, persist, now, uid } from './store.js';

export const JUDGE_MODES = ['parallel', 'vision', 'facts', 'strict'];

export const JUDGE_MODE_LABELS = {
  parallel: 'Parallel — both judges, facts gate',
  vision: 'Vision decides',
  facts: 'Facts decide when conclusive',
  strict: 'Strict — both must pass',
};

/** Which window this check is about: the step's own target, else the run's window. */
export function judgeTargetFor(step, run) {
  const p = step?.params || {};
  const asked = String(p.title || p.expected || p.window || '').trim();
  const app = String(p.app || p.expectedApp || p.process || '').trim();
  const last = run?.lastWindow || null;
  const lastHwnd = Number(last?.hwnd) || 0;
  const lastTitle = String(last?.title || '').trim();
  const sameTitle = asked && lastTitle && lastTitle.toLowerCase().includes(asked.toLowerCase());
  // The run opened this window and the step names it too, so the handle is the
  // exact subject — another document with the same title is a different window.
  if (lastHwnd && (!asked || sameTitle)) {
    return { hwnd: lastHwnd, title: lastTitle || asked, process: String(last?.process || app || ''), scoped: true, source: 'run-window' };
  }
  if (asked) return { hwnd: 0, title: asked, process: app, scoped: true, source: 'step' };
  if (app) return { hwnd: 0, title: '', process: app, scoped: true, source: 'step-app' };
  if (lastHwnd || lastTitle) {
    return { hwnd: lastHwnd, title: lastTitle, process: String(last?.process || ''), scoped: true, source: 'run-last-window' };
  }
  return { hwnd: 0, title: '', process: '', scoped: false, source: 'desktop' };
}

/** Whitespace- and placeholder-insensitive so “line one{ENTER}line two” matches real text. */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\{[A-Z0-9]+\}/gi, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Deterministic read of the same moment. `status` is pass, fail or unknown:
 * unknown never blocks, because an app that exposes no text is not evidence
 * that the text is missing.
 */
export function windowFacts({
  target = {},
  foreground = {},
  expectedApp = '',
  expectedText = '',
  absentText = '',
  windowText = '',
  textSource = '',
} = {}) {
  const checks = [];
  const foregroundHwnd = Number(foreground.hwnd || foreground.handle || 0) || 0;
  const title = String(foreground.title || '');
  const processName = String(foreground.process || '');
  const wantedTitle = String(target.title || '').trim();
  const wantedProcess = String(target.process || expectedApp || '').trim();

  if (target.hwnd) {
    if (!foregroundHwnd) {
      checks.push({ id: 'window', status: 'unknown', detail: 'the foreground window handle could not be read' });
    } else if (foregroundHwnd === Number(target.hwnd)) {
      checks.push({ id: 'window', status: 'pass', detail: `the run's window (hwnd ${target.hwnd}) is in front` });
    } else {
      checks.push({
        id: 'window',
        status: 'fail',
        detail: `a different window is in front (hwnd ${foregroundHwnd}, “${title || 'untitled'}”), not the run's window (hwnd ${target.hwnd})`,
      });
    }
  } else if (wantedTitle) {
    checks.push(
      title.toLowerCase().includes(wantedTitle.toLowerCase())
        ? { id: 'window', status: 'pass', detail: `“${title}” matches the requested title` }
        : { id: 'window', status: 'fail', detail: `the foreground window is “${title || '(untitled)'}”, not “${wantedTitle}”` }
    );
  } else if (wantedProcess) {
    const seen = `${processName} ${title}`.toLowerCase();
    checks.push(
      seen.includes(wantedProcess.toLowerCase())
        ? { id: 'window', status: 'pass', detail: `“${processName || title}” matches the requested app` }
        : { id: 'window', status: 'fail', detail: `the foreground window is “${title || processName || 'unknown'}”, not “${wantedProcess}”` }
    );
  } else {
    checks.push({ id: 'window', status: 'unknown', detail: 'no window was named, so the whole desktop was judged' });
  }

  const haystack = normalizeText(windowText);
  const expected = normalizeText(expectedText);
  if (expected) {
    if (!haystack) {
      checks.push({ id: 'text', status: 'unknown', detail: 'the window exposed no readable text' });
    } else if (haystack.includes(expected)) {
      checks.push({ id: 'text', status: 'pass', detail: `the expected text is present${textSource ? ` (${textSource})` : ''}` });
    } else {
      checks.push({ id: 'text', status: 'fail', detail: `the expected text “${String(expectedText).slice(0, 80)}” is not in the window` });
    }
  }
  const absent = normalizeText(absentText);
  if (absent && haystack) {
    checks.push(
      haystack.includes(absent)
        ? { id: 'text-absent', status: 'fail', detail: `“${String(absentText).slice(0, 80)}” is still on screen` }
        : { id: 'text-absent', status: 'pass', detail: 'the stale text is gone' }
    );
  }

  const status = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.every((check) => check.status === 'pass')
      ? 'pass'
      : 'unknown';
  return {
    status,
    checks,
    detail: checks.map((check) => check.detail).join('; '),
    target: { hwnd: Number(target.hwnd) || 0, title: wantedTitle, process: wantedProcess },
  };
}

export function judgeMode(settings = {}) {
  const mode = String(settings.verifyJudgeMode || 'parallel');
  return JUDGE_MODES.includes(mode) ? mode : 'parallel';
}

/** Per-workflow override wins over the global switch, but only when it is valid. */
export function judgeModeFor(workflow, settings) {
  const local = String(workflow?.judgeMode || '');
  if (JUDGE_MODES.includes(local)) return local;
  return judgeMode(settings || db().settings || {});
}

/**
 * Combine the two readings. `parallel` and `strict` keep the free fact check as
 * a gate: a model that passes the wrong window can no longer manufacture a
 * success. `vision` and `facts` exist so the operator can compare the methods
 * and learn which one to trust for a given workflow.
 */
export function mergeJudgement({ mode = 'parallel', facts = { status: 'unknown' }, vision = { pass: false } } = {}) {
  const factsStatus = ['pass', 'fail', 'unknown'].includes(facts?.status) ? facts.status : 'unknown';
  const visionPass = vision?.pass === true;
  let pass = false;
  let decidedBy = 'vision';
  switch (mode) {
    case 'vision':
      pass = visionPass;
      decidedBy = 'vision';
      break;
    case 'facts':
      if (factsStatus === 'pass' || factsStatus === 'fail') {
        pass = factsStatus === 'pass';
        decidedBy = 'facts';
      } else {
        pass = visionPass;
        decidedBy = 'vision';
      }
      break;
    case 'strict':
      pass = visionPass && factsStatus === 'pass';
      decidedBy = 'both';
      break;
    case 'parallel':
    default:
      // Facts may block, but an unknown fact never stands in for proof.
      pass = visionPass && factsStatus !== 'fail';
      decidedBy = factsStatus === 'fail' ? 'facts' : factsStatus === 'pass' ? 'both' : 'vision';
      break;
  }
  const agreement =
    factsStatus === 'unknown'
      ? 'partial'
      : factsStatus === 'pass' && visionPass
        ? 'agree'
        : factsStatus === 'fail' && !visionPass
          ? 'agree'
          : 'disagree';
  return {
    pass,
    mode,
    decidedBy,
    agreement,
    factsStatus,
    visionPass,
    detail:
      agreement === 'disagree'
        ? `the judges disagree: window facts say ${factsStatus}, vision says ${visionPass ? 'pass' : 'fail'}`
        : `both judges ${agreement === 'agree' ? 'agree' : 'were consulted'}`,
  };
}

function ensureJudgement(d) {
  if (!d.judgement || typeof d.judgement !== 'object') d.judgement = {};
  const j = d.judgement;
  if (!j.stats || typeof j.stats !== 'object') j.stats = {};
  if (!Array.isArray(j.reviews)) j.reviews = [];
  if (!Array.isArray(j.history)) j.history = [];
  return j;
}

const REVIEW_AFTER = 3;

function suggestionFor(kind, workflowId, mode) {
  if (kind === 'vision-only-pass') {
    return {
      kind: 'mode',
      mode: 'parallel',
      title: 'Keep window facts as a gate',
      detail: `${REVIEW_AFTER} checks where vision passed but the window facts did not. Parallel mode fails those instead of accepting a lookalike window.`,
    };
  }
  if (kind === 'facts-only-pass') {
    return {
      kind: 'mode',
      mode: 'facts',
      workflowId: workflowId || null,
      title: 'Trust the deterministic check for this workflow',
      detail: `${REVIEW_AFTER} checks where the window facts passed and vision did not. Facts mode accepts deterministic proof even when the model is unsure.`,
    };
  }
  return {
    kind: 'condition',
    mode: null,
    title: 'Name the window or text this check expects',
    detail: `${REVIEW_AFTER} checks ran without any window scope. Adding a title or expected text lets both judges read the same subject.`,
  };
}

/**
 * Record one check without changing any behaviour on its own. Repeated
 * disagreement is where the console earns a habit: it drafts a suggestion the
 * operator reviews first, then applies by accepting it.
 */
export function recordJudgement(entry = {}, deps = {}) {
  const d = deps.db || db();
  const save = deps.persist || persist;
  const j = ensureJudgement(d);
  const factsStatus = entry.facts?.status || entry.factsStatus || 'unknown';
  const visionPass = entry.vision?.pass === true || entry.visionPass === true;
  const kind =
    factsStatus === 'fail' && visionPass
      ? 'vision-only-pass'
      : factsStatus === 'pass' && !visionPass
        ? 'facts-only-pass'
        : entry.target?.scoped === false || entry.scoped === false
          ? 'unscoped'
          : null;
  const stats = j.stats;
  stats.total = (Number(stats.total) || 0) + 1;
  if (visionPass) stats.visionPass = (Number(stats.visionPass) || 0) + 1;
  if (factsStatus === 'pass') stats.factsPass = (Number(stats.factsPass) || 0) + 1;
  if (factsStatus === 'fail') stats.factsFail = (Number(stats.factsFail) || 0) + 1;
  if (factsStatus === 'unknown') stats.factsUnknown = (Number(stats.factsUnknown) || 0) + 1;
  if (entry.agreement === 'agree') stats.agree = (Number(stats.agree) || 0) + 1;
  if (entry.agreement === 'disagree') stats.disagree = (Number(stats.disagree) || 0) + 1;
  if (kind === 'vision-only-pass') stats.visionOnlyPass = (Number(stats.visionOnlyPass) || 0) + 1;
  if (kind === 'facts-only-pass') stats.factsOnlyPass = (Number(stats.factsOnlyPass) || 0) + 1;
  if (kind === 'unscoped') stats.unscoped = (Number(stats.unscoped) || 0) + 1;

  const record = {
    at: now(),
    mode: entry.mode || 'parallel',
    factsStatus,
    visionPass,
    confidence: entry.vision?.confidence ?? null,
    agreement: entry.agreement || 'partial',
    decidedBy: entry.decidedBy || 'vision',
    pass: entry.pass === true,
    kind,
    workflowId: entry.workflowId || null,
    runId: entry.runId || null,
    stepId: entry.stepId || null,
    question: String(entry.question || '').slice(0, 200),
    detail: String(entry.detail || entry.facts?.detail || '').slice(0, 300),
    target: entry.target || null,
  };
  j.history.unshift(record);
  j.history = j.history.slice(0, 80);

  if (kind && ['vision-only-pass', 'facts-only-pass', 'unscoped'].includes(kind)) {
    if (!j.streaks || typeof j.streaks !== 'object') j.streaks = {};
    const runs = (Number(j.streaks[kind]) || 0) + 1;
    j.streaks[kind] = runs;
    if (runs % REVIEW_AFTER === 0) {
      const suggestion = suggestionFor(kind, record.workflowId, record.mode);
      const pending = j.reviews.find((review) => review.status === 'pending' && review.kind === kind && (review.workflowId || null) === (suggestion.workflowId || null));
      if (pending) {
        pending.count = (Number(pending.count) || 1) + 1;
        pending.lastAt = record.at;
      } else {
        j.reviews.unshift({
          id: uid('jrev'),
          at: record.at,
          lastAt: record.at,
          count: 1,
          status: 'pending',
          kind,
          workflowId: suggestion.workflowId || null,
          title: suggestion.title,
          detail: suggestion.detail,
          suggestion: { kind: suggestion.kind, mode: suggestion.mode || null, workflowId: suggestion.workflowId || null },
        });
        j.reviews = j.reviews.slice(0, 20);
      }
      record.suggested = suggestion.title;
    }
    record.repeat = runs;
  }

  save();
  return {
    pass: record.pass,
    mode: record.mode,
    decidedBy: record.decidedBy,
    agreement: record.agreement,
    factsStatus,
    visionPass,
    detail: record.detail,
  };
}

/** Accepting a suggestion is the only thing that changes the switch. */
export function resolveJudgementReview(id, action = 'dismiss', deps = {}) {
  const d = deps.db || db();
  const save = deps.persist || persist;
  const j = ensureJudgement(d);
  const review = j.reviews.find((entry) => entry.id === id);
  if (!review) throw new Error('Judgement review not found');
  if (review.status !== 'pending') return review;
  if (action === 'accept' && review.suggestion?.kind === 'mode' && JUDGE_MODES.includes(review.suggestion.mode)) {
    if (review.suggestion.workflowId) {
      const workflow = (d.workflows || []).find((entry) => entry.id === review.suggestion.workflowId);
      if (workflow) workflow.judgeMode = review.suggestion.mode;
    } else {
      d.settings.verifyJudgeMode = review.suggestion.mode;
    }
  }
  review.status = action === 'accept' ? 'accepted' : 'dismissed';
  review.resolvedAt = now();
  save();
  return review;
}

export function judgementSummary(settings) {
  const j = ensureJudgement(db());
  const mode = judgeMode(settings || db().settings || {});
  const total = Number(j.stats.total) || 0;
  return {
    mode,
    modes: JUDGE_MODES.map((id) => ({ id, label: JUDGE_MODE_LABELS[id] })),
    stats: {
      ...j.stats,
      total,
      agreementRate: total && (Number(j.stats.agree) || 0) ? Math.round(((Number(j.stats.agree) || 0) / total) * 100) : null,
    },
    reviews: j.reviews.filter((review) => review.status === 'pending'),
    reviewCount: j.reviews.filter((review) => review.status === 'pending').length,
    recent: j.history.slice(0, 12),
  };
}
