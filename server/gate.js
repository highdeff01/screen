/**
 * The approval ladder.
 *
 * The console already scores its own candidates: step thinking samples every
 * prepared move, the two judges agree or disagree, and recovery plans are tested
 * before they are offered. What it lacked was one rule for what a score *means* —
 * a 0.7 candidate was treated almost like a 0.95 one, so a run acted on a guess
 * and paid for it with a failed step and a repair chain.
 *
 * The operator's rule, written down once:
 *
 *   ≥ 90% (or 4 of 5 approvals)  act: the evidence is strong enough to move
 *   ≥ 50%                        replan first, then act on the better option
 *   ≤ 49%                        do not act: take a fresh look, use an alternate
 *                                method only if that look still supports it,
 *                                otherwise replan, and stop if nothing is left
 *
 * Nothing here touches the desktop or the store. The bands are a pure function
 * of the evidence, so the same rule can be tested and quoted in the run log
 * instead of living in whoever wrote the last threshold.
 */

export const APPROVAL = Object.freeze({
  // 90% of the evidence must agree before a move is taken on the first look.
  act: 0.9,
  // Half the evidence is enough to keep trying, but only after a replan.
  replan: 0.5,
  // Four of five ballots is the operator's shorthand for the 90% bar; it is a
  // quorum rather than a second scale, so it can never accept 3 of 5.
  quorum: 0.8,
  quorumVotes: 4,
  quorumBallots: 5,
});

const BAND_ACTIONS = {
  act: 'act',
  replan: 'replan-then-act',
  hold: 'hold',
  unknown: 'observe',
};

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

/** Approval rate of a list of ballots (true/false, or { ok }). Null when empty. */
export function confidenceOf(votes = []) {
  const cast = (votes || []).filter(
    (vote) => vote === true || vote === false || vote?.ok === true || vote?.ok === false
  );
  if (!cast.length) return null;
  const approvals = cast.filter((vote) => vote === true || vote?.ok === true).length;
  return approvals / cast.length;
}

/**
 * Which band a reading falls in. A quorum (4 of 5) is accepted as the operator's
 * wording of the 90% bar; anything else has to clear the number itself.
 */
export function bandOf(confidence, { approvals = null, total = null } = {}) {
  if (!Number.isFinite(confidence)) {
    return { band: 'unknown', confidence: null, quorum: false, threshold: APPROVAL.act };
  }
  const quorum =
    Number.isFinite(approvals) &&
    Number.isFinite(total) &&
    total >= APPROVAL.quorumBallots &&
    approvals >= APPROVAL.quorumVotes &&
    approvals / total >= APPROVAL.quorum;
  if (confidence >= APPROVAL.act || quorum) {
    return { band: 'act', confidence, quorum, threshold: APPROVAL.act };
  }
  if (confidence >= APPROVAL.replan) {
    return { band: 'replan', confidence, quorum, threshold: APPROVAL.replan };
  }
  return { band: 'hold', confidence, quorum, threshold: APPROVAL.replan };
}

/**
 * The one decision a scored candidate gets. `label` is only used to make the log
 * line readable; the decision itself never depends on it.
 */
export function gateDecision({ confidence = null, approvals = null, total = null, source = '', label = '' } = {}) {
  const read = bandOf(confidence, { approvals, total });
  const what = label ? `“${label}”` : 'the prepared move';
  const share = Number.isFinite(read.confidence) ? pct(read.confidence) : '';
  const quorumNote = read.quorum ? ' (4 of 5 approvals)' : '';
  let reason;
  if (read.band === 'unknown') {
    reason = `there is no approval reading for ${what}, so nothing is assumed and it is only observed`;
  } else if (read.band === 'act') {
    reason = `${share}${quorumNote} approval clears the 90% bar, so ${what} acts`;
  } else if (read.band === 'replan') {
    reason = `${share} approval is above the 50% floor but below the 90% bar, so ${what} waits for a better option first`;
  } else {
    reason = `${share} approval is at or below the 49% ceiling, so ${what} does not act`;
  }
  return {
    ...read,
    source,
    label,
    action: BAND_ACTIONS[read.band],
    reason,
  };
}

/**
 * What to do after a hold. The order is the operator's: a fresh screenshot
 * first (the old reading may already be stale), then an alternate method only
 * while that fresh look still supports it, then a replan, and only then stop.
 *
 * `freshLook` is the comparison of the frame the decision was based on with a
 * new one: `{ changed, changedPct, applicable }`.
 */
export function backupPlan({ band = 'hold', alternatives = [], freshLook = null, canReplan = true } = {}) {
  if (band === 'act' || band === 'replan') {
    return { decision: band === 'act' ? 'act' : 'replan-then-act', steps: [] };
  }
  if (band === 'unknown') {
    return { decision: 'observe', steps: [] };
  }
  if (!freshLook) {
    return {
      decision: 're-read',
      steps: [
        {
          kind: 'fresh-look',
          why: 'The reading is below the act bar and may be stale, so a new screenshot decides whether it still applies.',
        },
      ],
    };
  }
  if (freshLook.changed === true) {
    return {
      decision: 're-read',
      steps: [
        {
          kind: 'fresh-look',
          why: `The screen changed by ${Number(freshLook.changedPct) || 0}% since the reading, so the old evidence no longer describes it.`,
        },
      ],
    };
  }
  if (freshLook.applicable === false) {
    return {
      decision: 'replan',
      steps: [
        { kind: 'fresh-look', why: 'The fresh screenshot was compared and the move no longer applies.' },
        { kind: 'replan', why: 'Nothing on screen still matches the move, so the plan is rebuilt instead of forced.' },
      ],
    };
  }
  const usable = (alternatives || []).filter((entry) => entry && entry.ok !== false);
  if (usable.length) {
    return {
      decision: 'alt-method',
      steps: [
        { kind: 'fresh-look', why: 'The fresh screenshot still shows the move, so a backup method may be tried.' },
        ...usable.map((entry) => ({
          kind: 'alt-method',
          why: entry.why || `Try ${entry.name || entry.id || 'the alternate method'}.`,
          alternative: entry,
        })),
      ],
    };
  }
  if (canReplan) {
    return {
      decision: 'replan',
      steps: [
        { kind: 'fresh-look', why: 'The move still applies, but no backup method is prepared.' },
        { kind: 'replan', why: 'The plan is rebuilt from the fresh screenshot and the notes before anything acts.' },
      ],
    };
  }
  return {
    decision: 'abort',
    steps: [
      { kind: 'fresh-look', why: 'The move still applies and no backup or replan is available.' },
      { kind: 'abort', why: 'Stopping here is better than acting on a reading under 50%.' },
    ],
  };
}

/** Per-band counts for the run record, so the rule is visible after the fact. */
export function gateSummary(decisions = []) {
  const rows = (decisions || []).filter(Boolean);
  const count = (band) => rows.filter((entry) => entry.band === band).length;
  return {
    total: rows.length,
    acted: count('act'),
    replanned: count('replan'),
    held: count('hold'),
    unknown: count('unknown'),
    actRate: rows.length ? Math.round((count('act') / rows.length) * 100) : null,
    recent: rows.slice(-8).map((entry) => ({
      band: entry.band,
      confidence: entry.confidence,
      label: entry.label || '',
      reason: entry.reason || '',
    })),
  };
}

/**
 * Settings the evidence argues for. This never changes a setting: a run that
 * keeps holding, or one that keeps acting and failing, is evidence a human
 * should see, and the console's rule is that learning proposes and the operator
 * accepts. Returned for the run summary and the review queue.
 */
export function adaptiveAdvice({ decisions = [], outcomes = [], settings = {} } = {}) {
  const rows = (decisions || []).filter(Boolean);
  if (!rows.length) return [];
  const held = rows.filter((entry) => entry.band === 'hold').length;
  const acted = rows.filter((entry) => entry.band === 'act').length;
  const failedAfterAct = (outcomes || []).filter((entry) => entry.band === 'act' && entry.ok === false).length;
  const advice = [];
  if (held >= 3 && acted === 0) {
    advice.push({
      setting: 'autoApplyMinConfidence',
      value: 0.5,
      why: `${held} reading(s) were held and none reached the act bar; the prepared moves are too weak to offer as-is.`,
    });
  }
  if (acted >= 4 && failedAfterAct >= 2) {
    advice.push({
      setting: 'autoApplyMinConfidence',
      value: 0.95,
      why: `${failedAfterAct} of ${acted} acted moves still failed, so the act bar is too low for this workflow.`,
    });
  }
  if (!advice.length && Number(settings.autoApplyMinConfidence) < APPROVAL.replan && acted > 0) {
    advice.push({
      setting: 'autoApplyMinConfidence',
      value: APPROVAL.replan,
      why: `The run acted on readings below the 50% floor (${settings.autoApplyMinConfidence}); raising it keeps the ladder honest.`,
    });
  }
  return advice;
}
