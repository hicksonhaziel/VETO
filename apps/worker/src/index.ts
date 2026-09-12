import { createReceiver } from './receiver.js';

const port = Number.parseInt(process.env.PORT ?? '8787', 10);
const dataDirectory = process.env.VETO_DATA_DIR;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const server = createReceiver({ dataDirectory });

server.listen(port, '127.0.0.1', () => {
  console.info(JSON.stringify({ event: 'worker_started', port }));
});

function shutdown(signal: string) {
  console.info(JSON.stringify({ event: 'worker_stopping', signal }));
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
