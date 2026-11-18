import { db, persist, uid, now, logActivity } from './store.js';
import { addSuggestion } from './planner.js';
import { canRetry, setRetryBudget } from './retry-budget.js';
import { proposalVotes, runApplyTrigger, watcherApplyDecision } from './agreement.js';
import { approveProposal } from './proposals.js';

function clip(value, max = 300) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function stepKey(step) {
  return `${step?.type || ''}|${step?.name || ''}|${JSON.stringify(step?.params || {})}`;
}

function latestRunForWorkflow(d, workflowId) {
  return (d.runs || [])
    .filter((run) => run.workflowId === workflowId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
}

export function proposalImplementation(proposal, workflow) {
  if (!proposal) return { implemented: null, missingSteps: [] };
  const current = new Set((workflow?.steps || []).map(stepKey));
  const missingSteps = (proposal.steps || []).filter((step) => !current.has(stepKey(step)));
  return {
    implemented: proposal.status === 'approved' ? missingSteps.length === 0 : null,
    missingSteps,
  };
}

function ensureAgent() {
  const d = db();
  let agent = d.agents.find((entry) => entry.kind === 'presentation');
  if (!agent) {
    agent = {
      id: 'agent_presentation',
      name: 'Deck reviewer',
      kind: 'presentation',
      role: 'sub-agent',
      status: 'idle',
      description: 'Watches saved presentation decks for proposal implementation, review notes, repeated re-test failures and planner suggestions.',
      enabled: true,
      intervalMs: 60000,
      deckCount: 0,
      lastTickAt: null,
      lastRunAt: null,
      log: [],
    };
    d.agents.push(agent);
    persist();
  }
  return agent;
}

export function ensurePresentationAgent() {
  return ensureAgent();
}

function log(agent, message) {
  if (!agent) return;
  agent.log.unshift({ at: now(), message });
  agent.log = agent.log.slice(0, 40);
  persist();
}

function noteFor(deck, kind, text, signature) {
  const note = {
    id: uid('dnote'),
    at: now(),
    kind,
    text: clip(text, 500),
    signature,
  };
  deck.notes = [note, ...(deck.notes || [])].slice(0, 12);
  return note;
}

function writeSharedNote(deck, note) {
  const d = db();
  const title = `Deck review · ${clip(deck.title, 70)}`;
  const body = [
    `Deck: ${deck.id}`,
    `Workflow: ${deck.workflowName} (${deck.workflowId})`,
    `Event: ${note.kind}`,
    '',
    note.text,
    '',
    `Verdict: ${deck.audit?.verdict || deck.auditSummary?.verdict || 'unknown'} · confidence ${deck.audit?.confidence ?? deck.auditSummary?.confidence ?? 'n/a'}%`,
    `Quality: ${deck.quality?.score ?? 'n/a'}/100 · lineage depth ${deck.lineage?.depth || 0}`,
    `Retry budget: ${JSON.stringify(deck.retryBudget || {})}`,
    `Attempts: ${deck.attempts?.consecutive || 0} consecutive / ${deck.attempts?.total || 0} total`,
    `Control: ${deck.control?.paused ? `paused — ${deck.control.reason || 'no reason'}` : 'active'}`,
    `Proposal: ${deck.proposalId || 'none'}${deck.autoProposalId ? ` · auto ${deck.autoProposalId}` : ''}`,
  ].join('\n');
  const record = {
    id: uid('note'),
    title,
    body,
    file: null,
    source: 'presentation-agent',
    workflowId: deck.workflowId,
    deckId: deck.id,
    tags: ['presentation', note.kind],
    createdAt: now(),
  };
  d.notes.unshift(record);
  d.notes = d.notes.slice(0, 60);
  persist();
  return record;
}

/**
 * Review each saved deck once per state change. The watcher records notes in
 * both the deck and the shared note stream, checks whether an approved
 * proposal was actually implemented, applies a pending proposal when the
 * other agents' weighted votes agree (or when the run failed/stalled), and
 * stops automatic re-tests after repeated failures.
 */
export async function watchPresentationDecks(agent = null) {
  const d = db();
  const owner = agent || ensureAgent();
  const decks = (d.presentations || []).slice(0, 40);
  const observed = [];
  const notes = [];
  for (const deck of decks) {
    const proposal = deck.proposalId ? (d.proposals || []).find((entry) => entry.id === deck.proposalId) || null : null;
    const lastRecheck = deck.rechecks?.[0] || null;
    const maxAttempts = Math.max(1, Number(deck.attempts?.maxFailedAttempts) || 3);
    const consecutive = Number(deck.attempts?.consecutive || 0);
    const workflow = d.workflows.find((entry) => entry.id === deck.workflowId) || null;
    const budget = canRetry(deck.workflowId, 'deck-watcher');
    const latestRun = latestRunForWorkflow(d, deck.workflowId);
    const trigger = proposal?.status === 'pending' ? runApplyTrigger(latestRun) : null;
    const votes = proposal?.status === 'pending'
      ? proposalVotes({ proposal, workflow, deck, agents: d.agents, budget, latestRun })
      : [];
    const decision = proposal?.status === 'pending' ? watcherApplyDecision({ proposal, votes, trigger }) : null;
    let applied = null;
    let applyError = null;
    if (decision?.apply) {
      try {
        const result = approveProposal(proposal.id, { mode: 'replace' });
        applied = {
          proposalId: proposal.id,
          at: now(),
          by: 'presentation-watcher',
          rank: decision.agreement.rank,
          score: decision.agreement.score,
          approvals: decision.agreement.approvals,
          voters: decision.agreement.voters,
          trigger: trigger?.trigger || null,
          reason: decision.reason,
          steps: (result?.workflow?.steps || []).length,
        };
        deck.proposalApplied = applied;
        deck.autoApplyError = null;
        deck.updatedAt = now();
        deck.lineage = deck.lineage || { rootDeckId: deck.id, parentDeckId: null, depth: 0, events: [] };
        deck.lineage.events.unshift({
          type: 'proposal-applied',
          at: applied.at,
          proposalId: proposal.id,
          summary: `Watcher applied ${proposal.id}: ${applied.rank} agreement (${applied.score}%)${applied.trigger ? ` after ${applied.trigger}` : ''}.`,
        });
        deck.lineage.events = deck.lineage.events.slice(0, 40);
        log(
          owner,
          `Applied ${proposal.id} to ${deck.workflowName}: ${applied.rank} ${applied.score}%${applied.trigger ? ` · ${applied.trigger}` : ''}.`
        );
        logActivity('agent', `${owner.name} applied proposal ${proposal.id} to ${deck.workflowName}`, {
          deckId: deck.id,
          proposalId: proposal.id,
          workflowId: deck.workflowId,
          rank: applied.rank,
          trigger: applied.trigger,
        });
      } catch (err) {
        applyError = String(err.message || err).slice(0, 300);
        deck.autoApplyError = applyError;
        deck.autoApplyAt = now();
        log(owner, `Could not apply ${proposal.id}: ${applyError}`);
      }
    }
    const implementation = proposalImplementation(proposal, workflow);
    const implemented = implementation.implemented;
    const missingSteps = implementation.missingSteps.slice(0, 6);
    const implementedEvent = proposal?.status === 'approved' && implemented
      ? (deck.lineage?.events || []).find((event) => event.type === 'proposal-implemented' && event.proposalId === proposal.id)
      : null;
    if (proposal?.status === 'approved' && implemented && !implementedEvent) {
      deck.lineage = deck.lineage || { rootDeckId: deck.id, parentDeckId: null, depth: 0, events: [] };
      deck.lineage.events.unshift({
        type: 'proposal-implemented',
        at: now(),
        proposalId: proposal.id,
        summary: `Approved proposal ${proposal.id} is present in the workflow.`,
      });
      deck.lineage.events = deck.lineage.events.slice(0, 40);
      deck.updatedAt = now();
    }
    if (consecutive >= maxAttempts && !deck.control?.paused) {
      deck.control = {
        paused: true,
        manual: false,
        reason: `Deck reviewer paused after ${consecutive} consecutive failed re-tests.`,
        at: now(),
      };
      if (budget.ok) setRetryBudget(deck.workflowId, { action: 'pause' });
    }
    const signature = JSON.stringify({
      proposal: proposal?.status || null,
      review: deck.review?.status || 'unreviewed',
      control: deck.control?.paused || false,
      consecutive,
      recheck: lastRecheck?.id || null,
      implemented,
      missing: missingSteps.length,
      budget: budget.ok ? 'ok' : budget.reason,
      agreement: decision ? `${decision.agreement.rank}:${decision.agreement.score}` : null,
      applied: applied?.proposalId || null,
      trigger: trigger?.trigger || null,
      applyError,
    });
    if (deck.watch?.signature === signature) {
      deck.watch.lastSeenAt = now();
      continue;
    }

    const lines = [];
    if (proposal) {
      if (proposal.status === 'approved') {
        lines.push(
          implemented
            ? `Proposal ${proposal.id} is approved and all ${(proposal.steps || []).length} proposed steps are present in the workflow.`
            : `Proposal ${proposal.id} is approved but ${missingSteps.length} proposed step(s) are not in the workflow: ${missingSteps.map((step) => step.name).join(', ')}.`
        );
      } else {
        lines.push(`Proposal ${proposal.id} is ${proposal.status}; suggestions are waiting for operator review.`);
      }
    }
    if (applied) {
      lines.push(
        `Watcher applied proposal ${proposal.id} with ${applied.rank} agreement (${applied.score}%)${applied.trigger ? ` after ${applied.trigger}` : ''}; the saved steps were overridden.`
      );
    } else if (applyError) {
      lines.push(`Watcher could not apply proposal ${proposal.id}: ${applyError}`);
    } else if (decision) {
      lines.push(`Agreement ${decision.agreement.rank} (${decision.agreement.score}%, ${decision.agreement.approvals}/${decision.agreement.voters}) — not applied: ${decision.reason}`);
    }
    if (!budget.ok) {
      lines.push(`Shared retry budget is paused: ${budget.reason}`);
    }
    if (consecutive >= maxAttempts) {
      lines.push(`Automatic re-tests are paused after ${consecutive}/${maxAttempts} consecutive failures. Review the blockers before resuming.`);
    } else if (consecutive > 0) {
      lines.push(`Re-test attempts: ${consecutive}/${maxAttempts} consecutive failures. Next action is a repair or a fresh capture, not an unchanged retry.`);
    }
    if (lastRecheck?.comparison?.summary) lines.push(`Latest comparison: ${lastRecheck.comparison.summary}`);
    const topSuggestion = (deck.audit?.suggestions || []).find((item) => item.priority === 'high') || deck.audit?.suggestions?.[0];
    if (topSuggestion) lines.push(`Suggestion: ${topSuggestion.title} — ${topSuggestion.detail}`);
    if (!lines.length) lines.push(`Deck is ${deck.review?.status || 'unreviewed'}; verdict ${deck.audit?.verdict || 'unknown'}.`);

    const note = noteFor(deck, proposal ? 'proposal-watch' : 'deck-watch', lines.join(' '), signature);
    writeSharedNote(deck, note);
    notes.push(note.id);
    observed.push(deck.id);
    if (topSuggestion) {
      addSuggestion(
        `Deck ${deck.id} (${deck.workflowName}): ${topSuggestion.title}. ${topSuggestion.detail}`,
        'presentation-deck',
        deck.workflowId,
        lastRecheck?.runId || null
      );
    }
    deck.watch = {
      lastAt: now(),
      lastSeenAt: now(),
      signature,
      proposalStatus: proposal?.status || null,
      implemented,
      missingSteps: missingSteps.map((step) => step.name),
      consecutiveFailures: consecutive,
      paused: Boolean(deck.control?.paused),
      agreement: decision
        ? {
            rank: decision.agreement.rank,
            score: decision.agreement.score,
            approvals: decision.agreement.approvals,
            rejections: decision.agreement.rejections,
            voters: decision.agreement.voters,
          }
        : null,
      proposalApplied: applied?.proposalId || null,
      autoApplyError: deck.autoApplyError || null,
      notes: (deck.notes || []).slice(0, 4),
    };
    log(owner, `Reviewed ${deck.id}: ${clip(lines[0], 180)}`);
  }
  owner.deckCount = decks.length;
  owner.lastRunAt = observed.length ? now() : owner.lastRunAt;
  owner.status = owner.enabled ? 'idle' : 'paused';
  persist();
  if (observed.length) logActivity('agent', `${owner.name} reviewed ${observed.length} deck(s)`, { deckIds: observed });
  return { observed, notes, deckCount: decks.length };
}
