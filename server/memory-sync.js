/**
 * Carry goals and missions between two instances of this console.
 *
 * A bundle is plain JSON: goals and missions, each with an id and a timestamp.
 * Merging is newest-wins per id and never deletes: an item that exists only on
 * one side survives, and an incoming copy only replaces a local one when its
 * timestamp is strictly newer. That is the whole conflict rule, so two machines
 * that have both been working converge instead of one overwriting the other.
 *
 * Nothing is merged automatically from a source or an agent. Export and import
 * are explicit actions; a sync loop is the operator's choice.
 */
import { db, now, persist } from './store.js';

function stampOf(item, timeKey) {
  const value = item?.[timeKey] ?? item?.updatedAt ?? item?.at ?? item?.createdAt ?? 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Merge two lists by id. Returns the merged list plus what changed, so the
 * caller can report "3 new, 1 updated, 2 left alone" instead of guessing.
 */
export function mergeById(local = [], incoming = [], { timeKey = 'updatedAt' } = {}) {
  const byId = new Map();
  for (const item of local || []) {
    if (item && item.id) byId.set(item.id, item);
  }
  let added = 0;
  let updated = 0;
  let kept = 0;
  for (const item of incoming || []) {
    if (!item || !item.id) continue;
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      added += 1;
      continue;
    }
    if (stampOf(item, timeKey) > stampOf(existing, timeKey)) {
      byId.set(item.id, item);
      updated += 1;
    } else {
      kept += 1;
    }
  }
  return { items: [...byId.values()], added, updated, kept };
}

/** What this instance would send. */
export function exportBundle({ limit = 500 } = {}) {
  const data = db();
  const goals = Array.isArray(data.goals) ? data.goals.slice(0, limit) : [];
  const missions = Array.isArray(data.missions) ? data.missions.slice(0, limit) : [];
  return {
    version: 1,
    at: now(),
    goals,
    missions,
    counts: { goals: goals.length, missions: missions.length },
  };
}

/**
 * Merge a bundle into this instance. `target` is injectable for tests; in
 * production it is the live database object, which is persisted once at the end.
 */
export function importBundle(bundle, { target = db(), save = persist } = {}) {
  if (!bundle || typeof bundle !== 'object') return { ok: false, why: 'That is not a bundle.' };
  if (!Array.isArray(bundle.goals) && !Array.isArray(bundle.missions)) {
    return { ok: false, why: 'A bundle needs a goals or missions list.' };
  }
  const goals = mergeById(Array.isArray(target.goals) ? target.goals : [], bundle.goals || [], { timeKey: 'updatedAt' });
  const missions = mergeById(Array.isArray(target.missions) ? target.missions : [], bundle.missions || [], { timeKey: 'updatedAt' });
  target.goals = goals.items;
  target.missions = missions.items;
  try {
    save();
  } catch {
    // The caller still learns what the merge decided.
  }
  return {
    ok: true,
    goals: { added: goals.added, updated: goals.updated, kept: goals.kept, total: goals.items.length },
    missions: { added: missions.added, updated: missions.updated, kept: missions.kept, total: missions.items.length },
    message: `Goals: ${goals.added} new, ${goals.updated} updated. Missions: ${missions.added} new, ${missions.updated} updated. Nothing was deleted.`,
  };
}
