/**
 * Relay — direct connections between this app's repository and other apps.
 *
 * A link pairs this folder with another repository (another app of yours, a
 * client install, a sibling project). Through a link you can:
 *
 *   - send files and folders from here to the other repository (a normal push,
 *     or a forced update when the other side runs this console's client and has
 *     granted force)
 *   - take updates from the other repository back into this folder, with the
 *     originals backed up first
 *   - review what moved: every exchange is logged, and anything sensitive goes
 *     through a review item that the model and the operator both look at before
 *     it is applied ("approve" applies it, "deny" drops it)
 *
 * Sending happens in a dedicated staging clone under data/relay/, so neither
 * this working tree nor the remote's history is ever rewritten by accident. The
 * same review queue is the two-way stream: what one side sends, the other side
 * sees, with opinions from the model attached.
 *
 * Git and the model are injectable, so the decisions can be tested without a
 * network.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, db, logActivity, now, persist, resolveInside, ROOT, uid } from './store.js';

const OUTPUT_LIMIT = 4000;
const EXCHANGE_LIMIT = 100;
const REVIEW_LIMIT = 60;
const STAGING = path.join(DATA, 'relay');

function relay() {
  const d = db();
  if (!d.relay || typeof d.relay !== 'object') d.relay = { links: [], exchanges: [], reviews: [] };
  for (const key of ['links', 'exchanges', 'reviews']) {
    if (!Array.isArray(d.relay[key])) d.relay[key] = [];
  }
  return d.relay;
}

export function relayStatus() {
  const r = relay();
  return {
    links: r.links.map((link) => ({ ...link, staging: path.relative(ROOT, stagingDir(link)) })),
    exchanges: r.exchanges.slice(-20).reverse(),
    reviews: r.reviews.filter((review) => review.status === 'open').concat(r.reviews.filter((review) => review.status !== 'open').slice(0, 10)),
    openReviews: r.reviews.filter((review) => review.status === 'open').length,
  };
}

export function findLink(id) {
  const link = relay().links.find((entry) => entry.id === id || entry.name === id);
  if (!link) throw new Error('Link not found');
  return link;
}

export function addLink({ name = '', remote = '', branch = 'main', direction = 'two-way', clientInstalled = false, allowances = {} } = {}) {
  const label = String(name || '').trim().slice(0, 60);
  const url = String(remote || '').trim();
  if (!label) throw new Error('A link needs a name.');
  if (!/^([a-z]+:\/\/|git@|file:\/\/)/i.test(url) && !/^[^/]+\/[^/]+$/.test(url)) {
    throw new Error('A link needs a remote: a URL (https://…, git@…) or owner/repo.');
  }
  const resolved = /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}.git` : url;
  if (relay().links.some((entry) => entry.name === label)) throw new Error('A link with that name already exists.');
  const link = {
    id: uid('link'),
    name: label,
    remote: resolved,
    branch: String(branch || 'main').trim() || 'main',
    direction: ['push', 'pull', 'two-way'].includes(direction) ? direction : 'two-way',
    clientInstalled: clientInstalled === true,
    allowances: {
      send: allowances.send !== false,
      receive: allowances.receive !== false,
      force: allowances.force === true,
      autoReview: allowances.autoReview !== false,
    },
    createdAt: now(),
    lastSyncAt: null,
    lastError: '',
  };
  relay().links.push(link);
  persist();
  logActivity('relay', `Linked repository “${label}”`, { linkId: link.id });
  return link;
}

export function updateLink(id, { direction, clientInstalled, allowances } = {}) {
  const link = findLink(id);
  if (direction && ['push', 'pull', 'two-way'].includes(direction)) link.direction = direction;
  if (clientInstalled !== undefined) link.clientInstalled = clientInstalled === true;
  if (allowances && typeof allowances === 'object') {
    for (const key of ['send', 'receive', 'force', 'autoReview']) {
      if (allowances[key] !== undefined) link.allowances[key] = allowances[key] === true;
    }
  }
  persist();
  return link;
}

export function removeLink(id) {
  const r = relay();
  const index = r.links.findIndex((entry) => entry.id === id || entry.name === id);
  if (index === -1) throw new Error('Link not found');
  const [removed] = r.links.splice(index, 1);
  persist();
  return removed;
}

/* ---------------- git plumbing ---------------- */

function runGit(cwd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
        });
      }
    );
  });
}

function stagingDir(link) {
  return path.join(STAGING, link.id);
}

const COPY_SKIP = /(^|[\\/])(\.git|node_modules|\.freebuff|data)([\\/]|$)|\.log$|\.pid$/;

async function ensureClone(link, deps) {
  const run = deps.run || runGit;
  const dir = stagingDir(link);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const clone = await run(dir, ['clone', '--branch', link.branch, link.remote, '.'], 120000);
    if (!clone.ok) {
      link.lastError = clone.stderr || 'clone failed';
      throw new Error(`Could not clone ${link.remote}: ${clone.stderr || clone.stdout || 'clone failed'}`);
    }
  }
  const fetch = await run(dir, ['fetch', 'origin', link.branch], 120000);
  if (!fetch.ok) {
    link.lastError = fetch.stderr || 'fetch failed';
    throw new Error(`Could not reach ${link.remote}: ${fetch.stderr || fetch.stdout || 'fetch failed'}`);
  }
  // The staging tree is a mirror of the remote's branch: nothing local is kept.
  const reset = await run(dir, ['reset', '--hard', `origin/${link.branch}`]);
  if (!reset.ok) {
    link.lastError = reset.stderr || 'reset failed';
    throw new Error(`Could not reset the staging clone: ${reset.stderr || reset.stdout || 'reset failed'}`);
  }
  link.lastError = '';
  link.lastSyncAt = now();
  return dir;
}

/** Copy files/folders from this project into the staging clone, keeping paths. */
async function copyIntoClone(link, paths, deps) {
  const dir = stagingDir(link);
  const copied = [];
  const skipped = [];
  for (const entry of paths) {
    const source = resolveInside(ROOT, String(entry || ''));
    if (!source || source === ROOT) {
      skipped.push({ path: entry, reason: 'outside this project' });
      continue;
    }
    if (!fs.existsSync(source)) {
      skipped.push({ path: entry, reason: 'not found' });
      continue;
    }
    const target = path.join(dir, path.relative(ROOT, source));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      if (fs.statSync(source).isDirectory()) {
        fs.cpSync(source, target, { recursive: true, filter: (from) => !COPY_SKIP.test(from) });
      } else {
        fs.cpSync(source, target);
      }
      copied.push(path.relative(ROOT, source).split(path.sep).join('/'));
    } catch (err) {
      skipped.push({ path: entry, reason: err.message });
    }
  }
  return { copied, skipped };
}

/** Copy received files from the staging clone into this project, backing up first. */
function copyIntoProject(link, relPaths) {
  const dir = stagingDir(link);
  const stamp = now().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(DATA, 'relay-backups', `${link.name}-${stamp}`);
  const applied = [];
  for (const rel of relPaths) {
    const source = path.join(dir, rel);
    if (!fs.existsSync(source)) continue;
    const target = resolveInside(ROOT, rel);
    if (!target || target === ROOT) continue;
    if (fs.existsSync(target)) {
      fs.mkdirSync(path.join(backupDir, path.dirname(rel)), { recursive: true });
      fs.cpSync(target, path.join(backupDir, rel));
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target);
    applied.push(rel.split(path.sep).join('/'));
  }
  return { applied, backupDir: fs.existsSync(backupDir) ? path.relative(ROOT, backupDir).split(path.sep).join('/') : '' };
}

function recordExchange(link, direction, detail) {
  const r = relay();
  r.exchanges.push({ id: uid('ex'), at: now(), linkId: link.id, link: link.name, direction, ...detail });
  if (r.exchanges.length > EXCHANGE_LIMIT) r.exchanges.splice(0, r.exchanges.length - EXCHANGE_LIMIT);
  persist();
}

function openReview(link, kind, detail) {
  const r = relay();
  const review = {
    id: uid('rv'),
    at: now(),
    linkId: link.id,
    link: link.name,
    kind,
    status: 'open',
    opinion: null,
    ...detail,
  };
  r.reviews.push(review);
  while (r.reviews.filter((entry) => entry.status !== 'open').length > 20) {
    const settled = r.reviews.findIndex((entry) => entry.status !== 'open');
    if (settled === -1) break;
    r.reviews.splice(settled, 1);
  }
  if (r.reviews.length > REVIEW_LIMIT) r.reviews.splice(0, r.reviews.length - REVIEW_LIMIT);
  persist();
  logActivity('relay', `Review requested: ${kind} on ${link.name}`, { reviewId: review.id });
  return review;
}

/* ---------------- sending ---------------- */

/**
 * Send files/folders from this project to the linked repository. With `force`
 * and a client that has granted it, the update can rewrite the other side's
 * branch; otherwise a refused push is reported instead of guessed at.
 */
export async function sendToLink(id, { paths = [], message = '', force = false } = {}, deps = {}) {
  const link = findLink(id);
  const run = deps.run || runGit;
  if (link.allowances.send === false) return { ok: false, status: 'not-allowed', message: 'Sending is switched off for this link.' };
  if (!paths.length) return { ok: false, status: 'no-paths', message: 'Name at least one file or folder to send.' };
  const wantsForce = force === true;
  if (wantsForce && (!link.clientInstalled || link.allowances.force === false)) {
    return { ok: false, status: 'force-denied', message: 'Force needs the client feature installed and force granted on this link.' };
  }
  let dir;
  try {
    dir = await ensureClone(link, deps);
  } catch (err) {
    persist();
    return { ok: false, status: 'unreachable', message: err.message };
  }
  const { copied, skipped } = await copyIntoClone(link, paths);
  if (!copied.length) {
    return { ok: false, status: 'nothing-to-send', skipped, message: `Nothing could be staged${skipped.length ? `: ${skipped.map((s) => `${s.path} (${s.reason})`).join(', ')}` : ''}.` };
  }
  await run(dir, ['add', '-A']);
  const commit = await run(dir, ['commit', '-m', message || 'Update from this console']);
  if (!commit.ok && !/nothing to commit/i.test(`${commit.stdout}\n${commit.stderr}`)) {
    link.lastError = commit.stderr || commit.stdout || 'commit failed';
    persist();
    return { ok: false, status: 'commit-failed', message: link.lastError };
  }
  const push = await run(dir, wantsForce ? ['push', '--force', 'origin', link.branch] : ['push', 'origin', link.branch], 120000);
  if (!push.ok) {
    const rejected = /rejected|non-fast-forward/i.test(push.stderr);
    link.lastError = push.stderr || push.stdout || 'push failed';
    persist();
    const review = rejected && link.allowances.autoReview ? openReview(link, 'force-push', { files: copied, note: 'The remote refused a fast-forward; a forced update needs review.' }) : null;
    return {
      ok: false,
      status: rejected ? 'rejected' : 'push-failed',
      review: review ? { id: review.id } : null,
      message: rejected ? 'The remote has commits this send would overwrite — sent to review (force or merge there first).' : link.lastError,
    };
  }
  recordExchange(link, 'push', { files: copied, skipped, message: message || '(no message)', forced: wantsForce });
  logActivity('relay', `Sent ${copied.length} path(s) to ${link.name}`, { linkId: link.id, files: copied });
  return { ok: true, status: wantsForce ? 'forced' : 'sent', copied, skipped, message: `Sent ${copied.length} path(s) to ${link.remote}.` };
}

/* ---------------- receiving ---------------- */

/**
 * Take updates from the linked repository. What changed since the last receive
 * either lands here directly (autoReview off) or goes to the review queue, where
 * the model drafts an opinion and the operator approves or denies.
 */
export async function receiveFromLink(id, deps = {}) {
  const link = findLink(id);
  const run = deps.run || runGit;
  if (link.allowances.receive === false) return { ok: false, status: 'not-allowed', message: 'Receiving is switched off for this link.' };
  let dir;
  try {
    dir = await ensureClone(link, deps);
  } catch (err) {
    persist();
    return { ok: false, status: 'unreachable', message: err.message };
  }
  const since = link.lastReceivedSha || '';
  const range = since ? `${since}..origin/${link.branch}` : `origin/${link.branch}`;
  const changed = await run(dir, ['diff', '--name-only', range]);
  if (!changed.ok) {
    link.lastError = changed.stderr || 'diff failed';
    persist();
    return { ok: false, status: 'diff-failed', message: link.lastError };
  }
  const files = String(changed.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!files.length) return { ok: true, status: 'up-to-date', files: [], message: `${link.name} has nothing new since the last receive.` };
  const sha = (await run(dir, ['rev-parse', `origin/${link.branch}`])).stdout.slice(0, 40);
  if (link.allowances.autoReview) {
    const review = openReview(link, 'receive', { files, sha });
    return { ok: true, status: 'review', review: { id: review.id, files }, message: `${files.length} changed file(s) from ${link.name} are waiting for review.` };
  }
  const { applied, backupDir } = copyIntoProject(link, files);
  link.lastReceivedSha = sha;
  recordExchange(link, 'pull', { files: applied });
  return { ok: true, status: 'applied', files: applied, backupDir, message: `Applied ${applied.length} file(s) from ${link.name}${backupDir ? `; originals in ${backupDir}` : ''}.` };
}

/** Apply a reviewed receive (or push decision). */
export async function approveReview(id, deps = {}) {
  const r = relay();
  const review = r.reviews.find((entry) => entry.id === id);
  if (!review) throw new Error('Review not found');
  if (review.status !== 'open') return { ok: false, status: 'settled', message: 'This review is already settled.' };
  const link = relay().links.find((entry) => entry.id === review.linkId);
  if (!link) throw new Error('The linked repository is gone');
  const run = deps.run || runGit;
  let dir;
  if (review.kind === 'receive') {
    try {
      dir = await ensureClone(link, deps);
    } catch (err) {
      return { ok: false, status: 'unreachable', message: err.message };
    }
    const { applied, backupDir } = copyIntoProject(link, review.files || []);
    link.lastReceivedSha = review.sha;
    review.status = 'approved';
    review.settledAt = now();
    recordExchange(link, 'pull', { files: applied, reviewId: review.id });
    persist();
    return { ok: true, status: 'applied', files: applied, backupDir, message: `Applied ${applied.length} file(s)${backupDir ? `; originals in ${backupDir}` : ''}.` };
  }
  if (review.kind === 'force-push') {
    const push = await run(stagingDir(link), ['push', '--force', 'origin', link.branch], 120000);
    review.status = push.ok ? 'approved' : 'failed';
    review.settledAt = now();
    if (push.ok) recordExchange(link, 'push', { files: review.files || [], forced: true, reviewId: review.id });
    persist();
    return push.ok
      ? { ok: true, status: 'forced', message: 'Forced update pushed.' }
      : { ok: false, status: 'push-failed', message: push.stderr || push.stdout || 'push failed' };
  }
  return { ok: false, status: 'unknown-kind', message: `Nothing to apply for a ${review.kind} review.` };
}

export function denyReview(id, { reason = '' } = {}) {
  const r = relay();
  const review = r.reviews.find((entry) => entry.id === id);
  if (!review) throw new Error('Review not found');
  review.status = 'denied';
  review.settledAt = now();
  review.note = String(reason || '').slice(0, 400);
  persist();
  return review;
}

/** The model's read of a review: apply, adjust or deny, with reasons. */
export async function reviewOpinion(id, deps = {}) {
  const review = relay().reviews.find((entry) => entry.id === id);
  if (!review) throw new Error('Review not found');
  let ask = deps.chat || null;
  if (!ask) {
    const mod = await import('./llm.js');
    ask = async (messages) => mod.chat(messages, { timeoutMs: 90000 });
  }
  const reply = await ask([
    {
      role: 'system',
      content:
        'You are reviewing an exchange between two connected apps. Reply in at most 8 lines: what the change appears to do, risks (especially anything that deletes, overwrites or breaks this app), and a clear recommendation: APPLY, ADJUST (with the adjustment), or DENY (with the reason). You are advising a human; you are not applying anything.',
    },
    {
      role: 'user',
      content: `Kind: ${review.kind}\nFiles:\n${(review.files || []).map((f) => `- ${f}`).join('\n')}\n${review.note ? `Note: ${review.note}\n` : ''}${review.output ? `Output tail:\n${String(review.output).slice(-1500)}` : ''}`,
    },
  ]);
  review.opinion = reply?.ok
    ? { at: now(), text: String(reply.content || '').trim().slice(0, 3000) }
    : { at: now(), error: reply?.error || 'the model is offline' };
  persist();
  return review;
}

export function findReview(id) {
  const review = relay().reviews.find((entry) => entry.id === id);
  if (!review) throw new Error('Review not found');
  return review;
}
