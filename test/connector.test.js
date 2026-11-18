import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-relay-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const relay = await load('server/connector.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

/**
 * A scripted stand-in for git with a working directory: the first matching
 * fragment decides the reply. `clone` really creates the staging folder, so the
 * file copying that the connector does is exercised for real.
 */
function scripted(rules) {
  const calls = [];
  return {
    calls,
    run: async (cwd, args) => {
      const line = args.join(' ');
      calls.push(`${path.basename(cwd)}$ ${line}`);
      const rule = rules.find(([fragment]) => line.includes(fragment));
      if (line.startsWith('clone ')) {
        const target = args[3] === '.' ? cwd : args[3];
        fs.mkdirSync(path.join(target, '.git'), { recursive: true });
      }
      const reply = rule ? rule[1] : { ok: true, stdout: '', stderr: '' };
      return typeof reply === 'function' ? reply(cwd, args, line) : { ok: true, stdout: '', stderr: '', ...reply };
    },
  };
}

test('a link needs a name and a remote, and owner/repo is expanded', () => {
  assert.throws(() => relay.addLink({ name: '', remote: 'https://x' }), /needs a name/);
  assert.throws(() => relay.addLink({ name: 'x', remote: '   ' }), /needs a remote/);
  const link = relay.addLink({ name: 'client', remote: 'you/other-app' });
  assert.equal(link.remote, 'https://github.com/you/other-app.git');
  assert.equal(link.allowances.autoReview, true);
  assert.throws(() => relay.addLink({ name: 'client', remote: 'you/other-app' }), /already exists/);
});

test('sending stages real files into the clone and records the exchange', async () => {
  const { run, calls } = scripted([
    ['push origin main', { ok: true, stdout: 'to github' }],
  ]);
  const link = relay.relayStatus().links[0];
  fs.writeFileSync(path.join(process.cwd(), 'report.md'), 'hello from this app');
  const result = await relay.sendToLink(link.id, { paths: ['report.md'], message: 'send a report' }, { run });
  assert.equal(result.ok, true);
  assert.deepEqual(result.copied, ['report.md']);
  assert.ok(calls.some((line) => line.includes('commit -m send a report')));
  assert.ok(calls.some((line) => line.includes('push origin main') && !line.includes('--force')));
  const staged = fs.readFileSync(path.join(process.cwd(), 'data', 'relay', link.id, 'report.md'), 'utf8');
  assert.equal(staged, 'hello from this app');
  const status = relay.relayStatus();
  assert.equal(status.exchanges[0].direction, 'push');
  assert.equal(status.exchanges[0].message, 'send a report');
});

test('force is refused unless the client is installed and force is granted', async () => {
  const { run } = scripted([]);
  const link = relay.relayStatus().links[0];
  const denied = await relay.sendToLink(link.id, { paths: ['report.md'], force: true }, { run });
  assert.equal(denied.status, 'force-denied');
  relay.updateLink(link.id, { clientInstalled: true });
  const stillDenied = await relay.sendToLink(link.id, { paths: ['report.md'], force: true }, { run });
  assert.equal(stillDenied.status, 'force-denied');
  relay.updateLink(link.id, { allowances: { force: true } });
  const granted = await relay.sendToLink(link.id, { paths: ['report.md'], force: true }, { run });
  assert.equal(granted.ok, true);
  assert.equal(granted.status, 'forced');
});

test('a refused push becomes a review instead of a guess', async () => {
  const { run } = scripted([
    ['push origin main', { ok: false, stderr: "! [rejected] main -> main (non-fast-forward)" }],
  ]);
  const link = relay.relayStatus().links[0];
  const result = await relay.sendToLink(link.id, { paths: ['report.md'] }, { run });
  assert.equal(result.status, 'rejected');
  assert.ok(result.review?.id, 'the refusal opened a review');
});

test('a receive goes to review, and approving applies the files with backups', async () => {
  const link = relay.relayStatus().links[0];
  const staging = path.join(process.cwd(), 'data', 'relay', link.id);
  // The staging clone "received" a new version of the file from the remote.
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'report.md'), 'updated by the other app');
  const { run } = scripted([
    ['diff --name-only', { ok: true, stdout: 'report.md\nnotes/new.md' }],
    ['rev-parse origin/main', { ok: true, stdout: 'abc123def' }],
  ]);
  fs.writeFileSync(path.join(process.cwd(), 'report.md'), 'local original');
  const received = await relay.receiveFromLink(link.id, { run });
  assert.equal(received.status, 'review');
  const review = relay.findReview(received.review.id);
  assert.deepEqual(review.files, ['report.md', 'notes/new.md']);

  // The model's opinion is advice only; approving is the operator's call.
  const withOpinion = await relay.reviewOpinion(review.id, {
    chat: async () => ({ ok: true, content: 'The change updates the report. Risk: overwrites a local edit. Recommendation: APPLY.' }),
  });
  assert.match(withOpinion.opinion.text, /APPLY/);

  const approved = await relay.approveReview(review.id, { run });
  assert.equal(approved.ok, true);
  assert.equal(fs.readFileSync(path.join(process.cwd(), 'report.md'), 'utf8'), 'updated by the other app');
  assert.ok(fs.existsSync(path.join(process.cwd(), 'notes', 'new.md')), 'the new file was applied');
  const status = relay.relayStatus();
  assert.ok(status.exchanges.some((entry) => entry.direction === 'pull' && entry.reviewId === review.id));
});

test('deny closes a review without applying anything', () => {
  const open = relay.relayStatus().reviews.find((review) => review.status === 'open');
  if (open) {
    const denied = relay.denyReview(open.id, { reason: 'not this time' });
    assert.equal(denied.status, 'denied');
    assert.equal(denied.note, 'not this time');
  }
});
