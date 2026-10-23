/**
 * Small local app with four seeded bugs, plus a fixed variant of the same pages.
 *
 *   Save order      click throws an uncaught exception     (page-error)
 *   Track shipment  link targets a missing document        (navigation / http-4xx)
 *   Send message    form POST returns HTTP 500             (network / http-5xx)
 *   Apply coupon    button is disabled                     (interaction / element-disabled)
 *
 * Labels and test ids stay the same in both modes so a recorded trace still
 * hits the control after the fix. POST /__monkeytest/mode with the body
 * `buggy` or `fixed` flips the server without a restart.
 *
 *   npx tsx test/fixtures/demo-app/server.ts --port 4173 --mode buggy
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DemoMode = 'buggy' | 'fixed';

export interface DemoServer {
  url: string;
  port: number;
  getMode: () => DemoMode;
  setMode: (mode: DemoMode) => void;
  close: () => Promise<void>;
}

const COPY = 'Orders, shipment tracking, and the contact form live on this shop. Nothing here calls another site.';

export async function startDemoServer(opts: { port?: number; host?: string; mode?: DemoMode } = {}): Promise<DemoServer> {
  let mode: DemoMode = opts.mode === 'fixed' ? 'fixed' : 'buggy';
  const host = opts.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    handle(req, res, () => mode, (next) => { mode = next; });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolveListen());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('demo server did not bind a TCP port');
  }

  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    getMode: () => mode,
    setMode: (next) => { mode = next === 'fixed' ? 'fixed' : 'buggy'; },
    close: () => new Promise((resolveClose, reject) => {
      server.close(err => err ? reject(err) : resolveClose());
    }),
  };
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  getMode: () => DemoMode,
  setMode: (mode: DemoMode) => void,
): void {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const mode = getMode();

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/__monkeytest/mode') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(mode);
      return;
    }
    if (req.method === 'POST') {
      readBody(req).then(body => {
        const next = body.trim();
        if (next === 'buggy' || next === 'fixed') setMode(next);
        res.writeHead(next === 'buggy' || next === 'fixed' ? 204 : 400);
        res.end();
      }).catch(() => {
        res.writeHead(400);
        res.end();
      });
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/contact') {
    if (mode === 'buggy') {
      sendHtml(res, 500, 'Error', '<p>The contact form could not be saved. Please try again later today.</p>');
    } else {
      sendHtml(res, 200, 'Sent', '<p>Message sent. We will reply to the address you gave us.</p>');
    }
    return;
  }

  if (url.pathname === '/' ) {
    sendHtml(res, 200, 'Shop', `
      <h1>Corner shop</h1>
      <p>${COPY}</p>
      <p><a href="/checkout">Checkout</a></p>
      <p><a href="/contact">Contact</a></p>
    `);
    return;
  }

  if (url.pathname === '/checkout') {
    const bugs = mode === 'buggy';
    sendHtml(res, 200, 'Checkout', `
      <h1>Checkout</h1>
      <p>${COPY}</p>
      <p id="status">Ready for the order.</p>
      <p><button type="button" id="save-order" data-testid="save-order">Save order</button></p>
      <p><a id="track-shipment" data-testid="track-shipment" href="${bugs ? '/missing' : '/tracking'}">Track shipment</a></p>
      <p><button type="button" id="apply-coupon" data-testid="apply-coupon"${bugs ? ' disabled' : ''}>Apply coupon</button></p>
      <p><a href="/">Back home</a> <a href="/contact">Contact</a></p>
      <script>
        window.__MONKEY_BUGS = ${bugs ? 'true' : 'false'};
        document.getElementById('save-order').addEventListener('click', function () {
          if (window.__MONKEY_BUGS) throw new Error('save failed');
          document.getElementById('status').textContent = 'Order saved';
        });
        document.getElementById('apply-coupon').addEventListener('click', function () {
          document.getElementById('status').textContent = 'Coupon applied';
        });
      </script>
    `);
    return;
  }

  if (url.pathname === '/contact') {
    sendHtml(res, 200, 'Contact', `
      <h1>Contact</h1>
      <p>Send a note about an order. We read every message that reaches this desk.</p>
      <form method="post" action="/api/contact" novalidate>
        <label for="email">Email</label>
        <input id="email" name="email" type="email" data-testid="email" />
        <button type="submit" data-testid="send-message">Send message</button>
      </form>
      <p><a href="/">Back home</a></p>
    `);
    return;
  }

  if (url.pathname === '/tracking') {
    sendHtml(res, 200, 'Tracking', '<h1>Tracking</h1><p>Shipment is in transit and scanning at the local depot.</p>');
    return;
  }

  if (url.pathname === '/missing') {
    sendHtml(res, 404, 'Not found', '<h1>Not found</h1><p>That shipment page does not exist. The tracking link pointed here.</p>');
    return;
  }

  sendHtml(res, 404, 'Not found', '<h1>Not found</h1><p>This page is not part of the shop.</p>');
}

function sendHtml(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isDirectRun(): boolean {
  const self = fileURLToPath(import.meta.url);
  return process.argv.some(arg => {
    try { return resolve(arg) === self; }
    catch { return false; }
  });
}

function parseArgs(argv: string[]): { port?: number; mode?: DemoMode } {
  let port: number | undefined;
  let mode: DemoMode | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[++i]);
    if (argv[i] === '--mode') mode = argv[++i] === 'fixed' ? 'fixed' : 'buggy';
  }
  return { port, mode };
}

if (isDirectRun()) {
  const args = parseArgs(process.argv.slice(2));
  startDemoServer(args).then(demo => {
    console.log(`demo app ${demo.getMode()} ${demo.url}`);
  }).catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
