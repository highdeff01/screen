import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShareLink, downgradeLiveRun, lanAddress } from '../server/share.js';

test('the share link carries the token and the right host', () => {
  assert.equal(
    buildShareLink({ token: 'abc123', port: 4318, host: '192.168.1.112' }),
    'http://192.168.1.112:4318/?token=abc123'
  );
  assert.equal(
    buildShareLink({ token: 'abc123', port: 4318, publicUrl: 'https://example.trycloudflare.com' }),
    'https://example.trycloudflare.com/?token=abc123'
  );
  assert.equal(buildShareLink({ token: '' }), '');
});

test('the LAN address skips loopback and internal interfaces', () => {
  assert.equal(lanAddress({}), '127.0.0.1');
  assert.equal(
    lanAddress({
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      eth: [
        { family: 'IPv6', internal: false, address: 'fe80::1' },
        { family: 'IPv4', internal: false, address: '10.0.0.5' },
      ],
    }),
    '10.0.0.5'
  );
});

test('a shared visitor can never ask for a live run', () => {
  const downgraded = JSON.parse(downgradeLiveRun('/api/workflows/wf_1/runs', '{"mode":"live","trigger":"manual"}'));
  assert.equal(downgraded.mode, 'dry');
  assert.equal(downgraded.sharedDowngrade, true);

  const dry = '{"mode":"dry"}';
  assert.equal(downgradeLiveRun('/api/workflows/wf_1/runs', dry), dry);

  // Other routes and unparseable bodies are left exactly as they arrived.
  assert.equal(downgradeLiveRun('/api/workflows', '{"mode":"live"}'), '{"mode":"live"}');
  assert.equal(downgradeLiveRun('/api/workflows/wf_1/runs', 'not json'), 'not json');
});
