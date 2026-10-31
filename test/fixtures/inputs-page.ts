/**
 * Local copy of the inputs example on the-internet.herokuapp.com/inputs.
 *
 * That page has one unlabeled `<input type=number>`, a heading "Inputs",
 * and the preceding text "Number". No checkbox, no text input, no `<label>`.
 * The footer line is only there so the crawler sees enough text to settle.
 * A tiny recorder stores the number the runner types, so a test can read it
 * back without sharing the browser.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export const INPUTS_MARKUP = `<!DOCTYPE html>
<html>
  <head>
    <title>The Internet</title>
  </head>
  <body>
    <div class="row">
      <div id="content" class="large-12 columns">
        <div class="row">
          <div class="large-6 small-12 columns large-centered">
            <h3>Inputs</h3>
            <div class="example">
              <p>Number</p>
              <input type=number>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="page-footer" class="row">
      <div class="large-6 large-centered columns">
        <hr>
        <div style="text-align: center;">Powered by Elemental Selenium and Sauce Labs</div>
      </div>
    </div>
    <script>
      var field = document.querySelector('input[type=number]');
      field.addEventListener('input', function () {
        fetch('/__value', { method: 'POST', body: field.value });
      });
    </script>
  </body>
</html>`;

export interface InputsServer {
  url: string;
  value: () => string;
  close: () => Promise<void>;
}

export async function startInputsServer(): Promise<InputsServer> {
  let value = '';
  const server = createServer((req, res) => handle(req, res, () => value, (next) => { value = next; }));
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('inputs fixture did not bind a port');
  return {
    url: `http://127.0.0.1:${address.port}/inputs`,
    value: () => value,
    close: () => new Promise((resolveClose, reject) => {
      server.close(err => err ? reject(err) : resolveClose());
    }),
  };
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  getValue: () => string,
  setValue: (value: string) => void,
): void {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/__value' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      setValue(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(204);
      res.end();
    });
    return;
  }
  if (url.pathname === '/__value') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(getValue());
    return;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(INPUTS_MARKUP);
}
