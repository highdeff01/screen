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
 * The two verdicts are kept side by side as evidence, but they produce one
 * answer. One switch, two positions: `gate` (the model decides and a
 * conclusive fact check can veto) and `facts` (a conclusive fact check decides,
 * so a check still means something when the model is slow or offline). Repeat
 * disagreement may draft a review, and nothing is applied until the operator
 * accepts it. No extra model call is ever made for the second judge.
 */
import { db, persist, now, uid } from './store.js';

export const JUDGE_MODES = ['gate', 'facts'];

export const JUDGE_MODE_LABELS = {
  gate: 'Facts can veto the model',
  facts: 'Facts decide when conclusive',
};

/**
 * Retired names map onto the two positions that survived. `parallel` was the
 * gate under another name; `vision` and `strict` both meant "let the model
 * through even when the window check says otherwise", which is how a lookalike
 * document once passed a screen check.
 */
const LEGACY_MODES = { parallel: 'gate', vision: 'gate', strict: 'gate' };

/** Which window this check is about: the step's own target, else the run's window. */
export function judgeTargetFor(step, run) {
  const p = step?.params || {};
  const asked = String(p.title || p.expected || p.window || '').trim();
  const app = String(p.app || p.expectedApp || p.process || '').trim();
  const askedHandle = Math.max(0, Number(p.handle || p.hwnd || p.windowHandle) || 0);
  const last = run?.lastWindow || null;
  const lastHwnd = Number(last?.hwnd) || 0;
  const lastTitle = String(last?.title || '').trim();
  const sameTitle = asked && lastTitle && lastTitle.toLowerCase().includes(asked.toLowerCase());
  // A check that names a handle means that exact window, even after the window
  // renamed itself (typing into an untitled document does that). Looking it up
  // by a title that stopped matching would turn the subject into “whatever is
  // in front” — the wrong window, or a lookalike behind it.
  if (askedHandle) {
    const sameHandle = lastHwnd === askedHandle;
    return {
      hwnd: askedHandle,
      title: asked || (sameHandle ? lastTitle : ''),
      process: app || (sameHandle ? String(last?.process || '') : ''),
      scoped: true,
      source: 'step-handle',
    };
  }
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
  const mode = String(settings.verifyJudgeMode || '').trim();
  if (JUDGE_MODES.includes(mode)) return mode;
  return LEGACY_MODES[mode] || 'gate';
}

/**
 * Combine the two readings into one verdict. `gate` keeps the free fact check
 * as a veto, so a model that passes the wrong window cannot manufacture a
 * success. `facts` lets a conclusive deterministic reading decide, so a check
 * still means something when the model is unsure or offline.
 */
export function mergeJudgement({ mode = 'gate', facts = { status: 'unknown' }, vision = { pass: false } } = {}) {
  const factsStatus = ['pass', 'fail', 'unknown'].includes(facts?.status) ? facts.status : 'unknown';
  const visionPass = vision?.pass === true;
  const normalised = JUDGE_MODES.includes(mode) ? mode : 'gate';
  let pass = false;
  let decidedBy = 'vision';
  if (normalised === 'facts' && (factsStatus === 'pass' || factsStatus === 'fail')) {
    pass = factsStatus === 'pass';
    decidedBy = 'facts';
  } else {
    // Facts may block, but an unknown fact never stands in for proof.
    pass = visionPass && factsStatus !== 'fail';
    decidedBy = factsStatus === 'fail' ? 'facts' : factsStatus === 'pass' ? 'both' : 'vision';
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
    mode: normalised,
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

function suggestionFor(kind) {
  if (kind === 'facts-only-pass') {
    return {
      kind: 'mode',
      mode: 'facts',
      title: 'Let the deterministic check decide',
      detail: `${REVIEW_AFTER} checks where the window facts passed and the model did not. Facts mode accepts the deterministic proof even when the model is unsure or offline.`,
    };
  }
  return {
    kind: 'condition',
    mode: null,
    setting: 'verifyJudgeRequireScope',
    value: true,
    title: 'Require every screen check to name its window',
    detail: `${REVIEW_AFTER} checks ran without any window scope, so both judges read the whole desktop. Accepting makes an unscoped check fail with a clear reason instead of judging whatever is in front.`,
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
    mode: entry.mode || 'gate',
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

  // A vision-only pass needs no review: the gate already blocked it. Only a
  // habit worth changing (facts winning, or checks naming no window) is drafted.
  if (kind && ['facts-only-pass', 'unscoped'].includes(kind)) {
    if (!j.streaks || typeof j.streaks !== 'object') j.streaks = {};
    const runs = (Number(j.streaks[kind]) || 0) + 1;
    j.streaks[kind] = runs;
    if (runs % REVIEW_AFTER === 0) {
      const suggestion = suggestionFor(kind);
      const pending = j.reviews.find((review) => review.status === 'pending' && review.kind === kind);
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
          workflowId: record.workflowId || null,
          title: suggestion.title,
          detail: suggestion.detail,
          suggestion: {
            kind: suggestion.kind,
            mode: suggestion.mode || null,
            ...(suggestion.setting ? { setting: suggestion.setting, value: suggestion.value } : {}),
          },
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
    d.settings.verifyJudgeMode = review.suggestion.mode;
  }
  if (action === 'accept' && review.suggestion?.setting === 'verifyJudgeRequireScope') {
    d.settings.verifyJudgeRequireScope = true;
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
    requireScope: db().settings.verifyJudgeRequireScope === true,
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
