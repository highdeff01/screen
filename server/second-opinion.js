/**
 * Second opinions — deliberate multi-viewpoint review.
 *
 * A repair plan drafted from one angle misses things another angle catches, so
 * a queued failure (or a relay review) can be looked at again through a
 * different lens. Each lens is a real review pass with its own framing, not a
 * reworded prompt: the skeptic hunts hidden assumptions, the user lens judges
 * from the person's point of view, the race lens reads it as a concurrency bug,
 * and the operator lens cares about blast radius. Opinions accumulate on the
 * item, so the operator sees several readings before acting.
 */
import { db, logActivity, now, persist, uid } from './store.js';

export const LENSES = {
  practical: {
    label: 'Practical',
    prompt: 'Read the failing run as a plain engineering problem: the most likely root cause, the exact file and function to change, and the smallest change that should make it pass. Say what would prove you wrong.',
  },
  skeptic: {
    label: 'Skeptic',
    prompt: 'Read the failing run hunting for what everyone probably got wrong: hidden assumptions, wrong preconditions, an environment difference, or the test itself being wrong. Question the obvious explanation and offer the alternative.',
  },
  user: {
    label: 'User',
    prompt: 'Read the failing run from the point of view of the person using this app: what would they have experienced, what did the failure take away from them, and which fix would they feel first. Keep the app working while it is fixed.',
  },
  race: {
    label: 'Race & timing',
    prompt: 'Read the failing run as a concurrency and timing problem: async ordering, retries, waits, screens that move under the cursor, and tests that pass alone but fail together. Identify anything that could be order-dependent and how to pin it.',
  },
  operator: {
    label: 'Operator',
    prompt: 'Read the failing run for blast radius: which features and files does a fix touch, what could the fix break, and what should be backed up or verified before touching anything. End with a go/no-go recommendation.',
  },
};

export function lensList() {
  return Object.entries(LENSES).map(([id, lens]) => ({ id, label: lens.label }));
}

/**
 * Add a review pass with one lens to a target item. `kind` picks where the item
 * lives; 'sentinel-failure' is wired now, others follow the same shape.
 */
export async function addSecondOpinion(kind, refId, lens = 'practical', deps = {}) {
  const chosen = LENSES[lens];
  if (!chosen) throw new Error(`Unknown lens: ${lens}. Available: ${Object.keys(LENSES).join(', ')}`);
  const d = db();
  let item = null;
  let subject = null;
  if (kind === 'sentinel-failure') {
    if (!Array.isArray(d.sentinel?.failures)) throw new Error('Failure not found');
    item = d.sentinel.failures.find((entry) => entry.id === refId);
    if (!item) throw new Error('Failure not found');
    subject = `Failing tests:\n${(item.tests || []).map((t) => `- ${t}`).join('\n') || item.fail}\n\nOutput tail:\n${String(item.output || '').slice(-3000)}`;
  } else if (kind === 'relay-review') {
    if (!Array.isArray(d.relay?.reviews)) throw new Error('Review not found');
    item = d.relay.reviews.find((entry) => entry.id === refId);
    if (!item) throw new Error('Review not found');
    subject = `Exchange kind: ${item.kind}\nFiles:\n${(item.files || []).map((f) => `- ${f}`).join('\n')}`;
  } else {
    throw new Error(`No second opinion for kind: ${kind}`);
  }

  let ask = deps.chat || null;
  if (!ask) {
    const mod = await import('./llm.js');
    ask = async (messages) => mod.chat(messages, { timeoutMs: 90000 });
  }
  const opinion = {
    id: uid('op'),
    at: now(),
    lens,
    label: chosen.label,
  };
  try {
    const reply = await ask([
      { role: 'system', content: `You are a senior reviewer doing a focused second-opinion pass. ${chosen.prompt} At most 10 lines of plain text. You are advising; do not claim to have changed anything.` },
      { role: 'user', content: subject },
    ]);
    if (reply?.ok) opinion.text = String(reply.content || '').trim().slice(0, 4000);
    else opinion.error = reply?.error || 'the model is offline';
  } catch (err) {
    opinion.error = err.message;
  }
  if (!Array.isArray(item.opinions)) item.opinions = [];
  item.opinions.unshift(opinion);
  while (item.opinions.length > 5) item.opinions.pop();
  persist();
  logActivity('second-opinion', `A ${chosen.label} second opinion was added`, { kind, refId, opinionId: opinion.id });
  return { item, opinion };
}
