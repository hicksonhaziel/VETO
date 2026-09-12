import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createReceiver } from '../src/receiver.js';

test('stores a Glacient delivery and returns its raw-body hash', async (context) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'veto-receiver-'));
  const server = createReceiver({
    dataDirectory,
    now: () => new Date('2026-09-12T16:48:10Z'),
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    server.close();
    await once(server, 'close');
    await rm(dataDirectory, { recursive: true });
  });

  const address = server.address();
  assert(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/glacient`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-signature': 'redacted' },
    body: '{"event":"management_fee_change_queued"}',
  });

  assert.equal(response.status, 202);
  const result = (await response.json()) as { accepted: boolean; bodySha256: string };
  assert.equal(result.accepted, true);
  assert.match(result.bodySha256, /^[a-f0-9]{64}$/);

  const stored = JSON.parse(
    (await readFile(path.join(dataDirectory, 'glacient-deliveries.ndjson'), 'utf8')).trim(),
  ) as { bodySha256: string; rawBodyBase64: string; receivedAt: string };
  assert.equal(stored.bodySha256, result.bodySha256);
  assert.equal(
    Buffer.from(stored.rawBodyBase64, 'base64').toString('utf8'),
    '{"event":"management_fee_change_queued"}',
  );
  assert.equal(stored.receivedAt, '2026-09-12T16:48:10.000Z');
});

test('rejects oversized and unrelated requests', async (context) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'veto-receiver-'));
  const server = createReceiver({ dataDirectory, maxBodyBytes: 4 });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    server.close();
    await once(server, 'close');
    await rm(dataDirectory, { recursive: true });
  });

  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${baseUrl}/missing`)).status, 404);
  assert.equal(
    (
      await fetch(`${baseUrl}/webhooks/glacient`, {
        method: 'POST',
        body: '12345',
      })
    ).status,
    413,
  );
});
