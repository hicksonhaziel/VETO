import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import path from 'node:path';

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const WEBHOOK_PATH = '/webhooks/glacient';

type ReceiverOptions = {
  dataDirectory?: string;
  maxBodyBytes?: number;
  now?: () => Date;
};

type StoredDelivery = {
  id: string;
  receivedAt: string;
  bodySha256: string;
  headers: IncomingHttpHeaders;
  rawBodyBase64: string;
};

function sendJson(
  response: import('node:http').ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(
  request: import('node:http').IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBodyBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

async function persistDelivery(dataDirectory: string, delivery: StoredDelivery) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const file = await open(path.join(dataDirectory, 'glacient-deliveries.ndjson'), 'a', 0o600);

  try {
    await file.appendFile(`${JSON.stringify(delivery)}\n`, { encoding: 'utf8' });
  } finally {
    await file.close();
  }
}

export function createReceiver(options: ReceiverOptions = {}): Server {
  const dataDirectory = options.dataDirectory ?? path.resolve(process.cwd(), '../../.local-data');
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const now = options.now ?? (() => new Date());

  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method !== 'POST' || request.url !== WEBHOOK_PATH) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    try {
      const rawBody = await readBody(request, maxBodyBytes);
      const delivery: StoredDelivery = {
        id: randomUUID(),
        receivedAt: now().toISOString(),
        bodySha256: createHash('sha256').update(rawBody).digest('hex'),
        headers: request.headers,
        rawBodyBase64: rawBody.toString('base64'),
      };

      await persistDelivery(dataDirectory, delivery);
      console.info(
        JSON.stringify({
          event: 'glacient_delivery_stored',
          id: delivery.id,
          receivedAt: delivery.receivedAt,
          bodySha256: delivery.bodySha256,
          headerNames: Object.keys(delivery.headers).sort(),
        }),
      );
      sendJson(response, 202, {
        accepted: true,
        id: delivery.id,
        bodySha256: delivery.bodySha256,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'BODY_TOO_LARGE') {
        sendJson(response, 413, { error: 'body_too_large' });
        return;
      }

      console.error(
        JSON.stringify({
          event: 'glacient_delivery_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        }),
      );
      sendJson(response, 500, { error: 'storage_failed' });
    }
  });
}
