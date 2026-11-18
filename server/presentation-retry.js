const fallbackNow = () => new Date().toISOString();

export function shouldCreateRepairProposal({
  consecutive = 0,
  maxFailedAttempts = 3,
  manual = false,
  existingStatus = null,
} = {}) {
  if (manual) return { create: false, reuse: false, reason: 'manual-control' };
  if (Number(consecutive) < Number(maxFailedAttempts)) return { create: false, reuse: false, reason: 'below-threshold' };
  if (existingStatus && existingStatus !== 'rejected') {
    return { create: false, reuse: true, reason: `existing-${existingStatus}` };
  }
  return { create: true, reuse: false, reason: 'threshold-reached' };
}

export async function maybeCreateRepairProposal(
  deck,
  {
    consecutive = 0,
    maxFailedAttempts = 3,
    existing = null,
    create = null,
    now = fallbackNow,
  } = {}
) {
  const decision = shouldCreateRepairProposal({
    consecutive,
    maxFailedAttempts,
    manual: Boolean(deck?.control?.manual),
    existingStatus: existing?.status || null,
  });
  if (!decision.create && !decision.reuse) return { ...decision, proposal: null };
  if (decision.reuse) {
    deck.autoProposalId = existing.id;
    return { ...decision, proposal: existing };
  }
  if (typeof create !== 'function') return { ...decision, proposal: null, reason: 'no-creator' };
  try {
    const proposal = await create(deck);
    deck.autoProposalId = proposal.id;
    deck.autoProposalAt = now();
    deck.autoProposalError = null;
    deck.lineage = deck.lineage || { rootDeckId: deck.id, parentDeckId: null, depth: 0, events: [] };
    deck.lineage.events = [
      {
        type: 'repair-proposal',
        at: deck.autoProposalAt,
        proposalId: proposal.id,
        summary: `Auto-created repair proposal after ${consecutive} failed re-tests.`,
      },
      ...(deck.lineage.events || []),
    ].slice(0, 40);
    deck.updatedAt = deck.autoProposalAt;
    return { ...decision, proposal };
  } catch (err) {
    deck.autoProposalError = String(err?.message || err).slice(0, 300);
    return { ...decision, proposal: null, error: deck.autoProposalError };
  }
}
