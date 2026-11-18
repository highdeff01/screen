/**
 * Inbox — the way any connected agent or app asks the person at the desk a
 * question, and gets the answer back without someone relaying it.
 *
 * An agent POSTs a question (optionally with choices); the console shows it on
 * the Relay page until it is answered or cancelled. The asking side can wait on
 * the answer with a long poll (`GET /api/inbox/:id/wait`) or poll the item.
 * Everything is small and stored in the console database, so the CLI, the UI and
 * remote agents all see the same queue.
 */
import { db, logActivity, now, persist, uid } from './store.js';

const LIMIT = 100;

function inbox() {
  const d = db();
  if (!Array.isArray(d.inbox)) d.inbox = [];
  return d.inbox;
}

const open = (item) => item.status === 'open';

export function ask({ question = '', from = 'agent', choices = [], runId = null, context = '' } = {}) {
  const text = String(question || '').trim().slice(0, 2000);
  if (!text) throw new Error('A request needs a question.');
  const item = {
    id: uid('ask'),
    at: now(),
    question: text,
    from: String(from || 'agent').slice(0, 60),
    runId: runId || null,
    context: String(context || '').slice(0, 2000),
    choices: (Array.isArray(choices) ? choices : []).map((choice) => String(choice).slice(0, 120)).filter(Boolean).slice(0, 6),
    status: 'open',
    answer: null,
    answeredBy: null,
    answeredAt: null,
  };
  const list = inbox();
  list.push(item);
  while (list.length > LIMIT) {
    const settled = list.findIndex((entry) => !open(entry));
    list.splice(settled === -1 ? 0 : settled, 1);
  }
  persist();
  logActivity('inbox', `${item.from} asked: ${text.slice(0, 80)}`, { askId: item.id, runId: item.runId });
  return item;
}

export function listInbox({ status = 'open', limit = 30 } = {}) {
  const list = inbox();
  const wanted = status && status !== 'all' ? list.filter(open) : list;
  return wanted.slice(-Math.max(1, Math.min(LIMIT, Number(limit) || 30))).reverse();
}

export function findRequest(id) {
  const item = inbox().find((entry) => entry.id === id);
  if (!item) throw new Error('Request not found');
  return item;
}

export function answerRequest(id, { answer = '', by = 'operator' } = {}) {
  const item = findRequest(id);
  const text = String(answer || '').trim().slice(0, 4000);
  if (!text) throw new Error('An answer needs some text.');
  if (!open(item)) throw new Error(`This request is already ${item.status}.`);
  item.answer = text;
  item.answeredBy = String(by || 'operator').slice(0, 60);
  item.answeredAt = now();
  item.status = 'answered';
  persist();
  logActivity('inbox', `Answered ${item.from}'s question`, { askId: item.id });
  return item;
}

export function cancelRequest(id) {
  const item = findRequest(id);
  if (!open(item)) throw new Error(`This request is already ${item.status}.`);
  item.status = 'cancelled';
  item.answeredAt = now();
  persist();
  return item;
}

/**
 * Long poll for the asking side: resolves when the request is answered or
 * cancelled, or after the wait budget (the caller then re-polls).
 */
export function waitRequest(id, { timeoutMs = 30000 } = {}) {
  const budget = Math.max(1000, Math.min(120000, Number(timeoutMs) || 30000));
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let item;
      try {
        item = findRequest(id);
      } catch {
        clearInterval(timer);
        return resolve({ ok: false, status: 'not-found' });
      }
      if (!open(item) || Date.now() - started > budget) {
        clearInterval(timer);
        resolve({ ok: true, item });
      }
    }, 500);
    if (timer.unref) timer.unref();
  });
}
