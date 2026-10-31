/**
 * Sign-in-first SPA used by the 0.7.0-beta.1 crawl tests.
 *
 *   GET /                  307 → /?mode=signin
 *   GET /?mode=signin      React-style form (no method) plus an OAuth link
 *   GET /?mode=signup      sign-up form, never submitted by the engine
 *   GET /forgot-password   email field only
 *   GET /robots.txt        Allow paths and a sitemap pointer
 *   GET /sitemap.xml       the two public auth routes
 *   POST /api/login        always an in-page failure, HTTP 200, counted
 *
 * No real credentials. The wrong-password check is the only POST.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface SigninSpa {
  url: string;
  port: number;
  loginPosts: () => number;
  close: () => Promise<void>;
}

export async function startSigninSpa(opts: { port?: number; host?: string } = {}): Promise<SigninSpa> {
  let loginPosts = 0;
  const host = opts.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    handle(req, res, () => { loginPosts += 1; });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolveListen());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('signin fixture did not bind a TCP port');
  }

  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    loginPosts: () => loginPosts,
    close: () => new Promise((resolveClose, reject) => {
      server.close(err => err ? reject(err) : resolveClose());
    }),
  };
}

function handle(req: IncomingMessage, res: ServerResponse, countLogin: () => void): void {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const origin = `http://${req.headers.host || '127.0.0.1'}`;

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end([
      'User-agent: *',
      'Allow: /forgot-password',
      'Allow: /?mode=signup',
      `Sitemap: ${origin}/sitemap.xml`,
      '',
    ].join('\n'));
    return;
  }

  if (url.pathname === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>${origin}/?mode=signup</loc></url>
  <url><loc>${origin}/forgot-password</loc></url>
</urlset>`);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    countLogin();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Incorrect email or password' }));
    return;
  }

  if (url.pathname === '/' && !url.search) {
    res.writeHead(307, { location: '/?mode=signin' });
    res.end();
    return;
  }

  if (url.pathname === '/forgot-password') {
    sendHtml(res, 'Forgot password', `
      <h1>Forgot password</h1>
      <p>Tell us the email on the account and we will send a reset link. This form is not submitted by the test.</p>
      <form id="forgot">
        <label for="reset-email">Email</label>
        <input id="reset-email" name="email" type="email" />
        <button type="button">Send reset link</button>
      </form>
    `);
    return;
  }

  if (url.pathname === '/' && url.searchParams.get('mode') === 'signup') {
    sendHtml(res, 'Create account', `
      <h1>Create account</h1>
      <p>Sign up for a casting account. The test must not submit this form.</p>
      <form id="signup">
        <label for="signup-email">Email</label>
        <input id="signup-email" name="email" type="email" />
        <button type="button">Create account</button>
      </form>
      <p><a href="/?mode=signin">Sign in</a></p>
    `);
    return;
  }

  if (url.pathname === '/' && url.searchParams.get('mode') === 'signin') {
    const toggle = url.searchParams.get('notoggle') === '1'
      ? ''
      : '<button type="button" id="toggle-password">Show password</button>';
    sendHtml(res, 'Sign in', `
      <h1>Sign in</h1>
      <p>Enter the email and password for your casting account. Public pages are not available until you sign in.</p>
      <p id="alert" role="alert"></p>
      <form id="signin" novalidate>
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" />
        ${toggle}
        <button type="submit">Sign in</button>
      </form>
      <p><a href="/forgot-password">Forgot password</a></p>
      <p><a href="/?mode=signup">Sign up</a></p>
      <p><span role="link" data-href="/forgot-password">Reset link</span></p>
      <p><a href="https://accounts.google.com/o/oauth2/v2/auth">Continue with Google</a></p>
      <script>
        var toggle = document.getElementById('toggle-password');
        if (toggle) {
          toggle.addEventListener('click', function () {
            var field = document.getElementById('password');
            var showing = field.type === 'text';
            field.type = showing ? 'password' : 'text';
            toggle.textContent = showing ? 'Show password' : 'Hide password';
          });
        }
        document.getElementById('signin').addEventListener('submit', function (event) {
          event.preventDefault();
          var email = document.getElementById('email').value.trim();
          var alert = document.getElementById('alert');
          if (!email) {
            alert.textContent = 'Email is required';
            return;
          }
          if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
            alert.textContent = 'Enter a valid email';
            return;
          }
          fetch('/api/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: email }),
          }).then(function (response) { return response.json(); }).then(function (body) {
            alert.textContent = body.error || 'Incorrect email or password';
          });
        });
      </script>
    `);
    return;
  }

  sendHtml(res, 'Not found', '<h1>Not found</h1><p>This fixture has no such page.</p>', 404);
}

function sendHtml(res: ServerResponse, title: string, body: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
}
