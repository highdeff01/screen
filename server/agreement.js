/**
 * Agreement ranking for repair proposals.
 *
 * The console already runs several agents with different jobs. Instead of one
 * watcher deciding alone, each enabled agent votes from its own evidence. The
 * weighted result is a rank the watcher can act on: unanimous, strong,
 * majority, split or blocked. Pure so the policy is testable without a desktop.
 */

const WEIGHTS = {
  supervisor: 3,
  watchdog: 2,
  observer: 2,
  scheduler: 2,
  continuity: 1,
  companion: 1,
};

/** A running step older than this is treated as a stalled agent. */
export const APPLY_STALL_MS = 120000;

function clip(value, max = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function blockingLint(proposal) {
  return (proposal?.lint?.issues || []).some((issue) => issue.severity === 'error');
}

function vote(agent, value, reason) {
  return {
    agentId: agent.id || null,
    name: agent.name || agent.kind,
    kind: agent.kind,
    vote: value,
    weight: WEIGHTS[agent.kind] || 1,
    reason: clip(reason),
  };
}

function agentVote(agent, { proposal, workflow, budget }) {
  const steps = Array.isArray(proposal?.steps) ? proposal.steps : [];
  switch (agent.kind) {
    case 'supervisor':
      if (!workflow) return vote(agent, 'reject', 'The workflow no longer exists.');
      if (blockingLint(proposal)) return vote(agent, 'reject', 'Blocking lint errors are unresolved.');
      if (!steps.length) return vote(agent, 'reject', 'The proposal has no steps.');
      return vote(agent, 'approve', `${steps.length} step(s) rebuild the operator goal.`);
    case 'scheduler':
      if (!steps.length) return vote(agent, 'reject', 'The proposal has no steps.');
      if (budget && budget.ok === false) {
        return vote(agent, 'reject', `Retry budget is paused: ${budget.reason || 'no retries left in the window'}.`);
      }
      return vote(agent, 'approve', 'The shared retry budget allows one repair.');
    case 'watchdog':
      if (!steps.length) return vote(agent, 'reject', 'The proposal has no steps.');
      if (blockingLint(proposal)) return vote(agent, 'reject', 'Blocking lint errors are unresolved.');
      if (proposal.shadowTest?.ok === false) {
        return vote(agent, 'reject', `Shadow test failed at ${proposal.shadowTest.score ?? 0}%.`);
      }
      if (proposal.shadowTest?.ok === true) {
        return vote(agent, 'approve', `Shadow test passed at ${proposal.shadowTest.score ?? 0}%.`);
      }
      return vote(agent, 'abstain', 'No shadow test yet; evidence is not strong enough to vote.');
    case 'observer': {
      if (!steps.length) return vote(agent, 'reject', 'The proposal has no steps.');
      const changed = Number(proposal.changes?.changed || 0);
      return changed > 0
        ? vote(agent, 'approve', `${changed} step change(s) close the missing prerequisite.`)
        : vote(agent, 'abstain', 'The proposal matches the current steps; there is nothing to correct.');
    }
    case 'continuity':
      if (!workflow) return vote(agent, 'reject', 'The workflow no longer exists.');
      if (!steps.length) return vote(agent, 'abstain', 'No steps to verify.');
      return vote(agent, 'approve', 'A complete step list keeps the workflow continuable.');
    case 'companion':
      return vote(agent, 'abstain', 'The companion has no proposal-specific evidence.');
    default:
      return vote(agent, 'abstain', 'No agreement policy for this agent.');
  }
}

/** One vote per enabled agent kind; the first agent of a kind represents it. */
export function proposalVotes({ proposal, workflow = null, deck = null, agents = [], budget = null, latestRun = null }) {
  const seen = new Set();
  const votes = [];
  for (const agent of agents || []) {
    if (!agent?.enabled || !WEIGHTS[agent.kind] || seen.has(agent.kind)) continue;
    seen.add(agent.kind);
    votes.push(agentVote(agent, { proposal, workflow, deck, budget, latestRun }));
  }
  return votes;
}

export function rankProposalVotes(votes = []) {
  const cast = votes.filter((entry) => entry.vote === 'approve' || entry.vote === 'reject');
  const approvals = cast.filter((entry) => entry.vote === 'approve');
  const rejections = cast.filter((entry) => entry.vote === 'reject');
  const abstentions = votes.filter((entry) => entry.vote === 'abstain');
  const approvalWeight = approvals.reduce((total, entry) => total + (entry.weight || 1), 0);
  const castWeight = cast.reduce((total, entry) => total + (entry.weight || 1), 0);
  const score = castWeight ? Math.round((approvalWeight / castWeight) * 100) : 0;

  let rank = 'split';
  if (rejections.length) rank = 'blocked';
  else if (!approvals.length) rank = 'split';
  else if (cast.length >= 3 && approvals.length === cast.length) rank = 'unanimous';
  else if (approvals.length >= 2 && score >= 75) rank = 'strong';
  else if (approvals.length >= 2 && score > 50) rank = 'majority';

  return {
    rank,
    approved: rank === 'unanimous' || rank === 'strong' || rank === 'majority',
    score,
    approvals: approvals.length,
    rejections: rejections.length,
    abstentions: abstentions.length,
    voters: cast.length,
    votes,
  };
}

/**
 * A failed step, or a step that has been running longer than APPLY_STALL_MS,
 * counts as the other agent stalling or failing the work.
 */
export function runApplyTrigger(latestRun, nowMs = Date.now()) {
  if (!latestRun) return null;
  const steps = latestRun.steps || [];
  const failed = steps.find((step) => step.status === 'failed');
  if (failed && latestRun.status === 'failed') {
    return { trigger: 'step-failed', detail: `${failed.name || failed.type || 'step'}: ${clip(failed.error || 'failed', 160)}` };
  }
  const running = steps.find((step) => step.status === 'running');
  const startedAt = running?.startedAt ? Date.parse(running.startedAt) : NaN;
  if (running && Number.isFinite(startedAt) && nowMs - startedAt >= APPLY_STALL_MS) {
    return { trigger: 'agent-stalled', detail: `${running.name || running.type || 'step'} running for ${Math.round((nowMs - startedAt) / 1000)}s` };
  }
  return null;
}

/**
 * The watcher applies a pending proposal when the agents agree, or when the
 * run failed/stalled and at least one agent still approves. A rejection (for
 * example a paused retry budget) stops the override regardless of the trigger.
 */
export function watcherApplyDecision({ proposal = null, votes = [], trigger = null } = {}) {
  const agreement = rankProposalVotes(votes);
  const base = { agreement, trigger, apply: false, reason: '' };
  if (!proposal) return { ...base, reason: 'No proposal to apply.' };
  if (proposal.status !== 'pending') return { ...base, reason: `Proposal is ${proposal.status}.` };
  if (!(proposal.steps || []).length) return { ...base, reason: 'Proposal has no steps.' };
  if (agreement.rejections > 0) {
    const rejection = agreement.votes.find((entry) => entry.vote === 'reject');
    return { ...base, reason: `${agreement.rejections} agent rejection(s): ${rejection?.name || 'agent'} — ${rejection?.reason || 'rejected'}.` };
  }
  if (agreement.approved) {
    return {
      ...base,
      apply: true,
      reason: `${agreement.rank} agreement (${agreement.score}%, ${agreement.approvals}/${agreement.voters} agents).`,
    };
  }
  if (trigger && agreement.approvals >= 1 && agreement.score >= 50) {
    return {
      ...base,
      apply: true,
      reason: `${trigger.trigger} override with ${agreement.rank} agreement (${agreement.score}%).`,
    };
  }
  return {
    ...base,
    reason: `${agreement.rank} agreement (${agreement.score}%, ${agreement.approvals}/${agreement.voters} agents) is below the apply threshold.`,
  };
}
