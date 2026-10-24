/**
 * The live e2e script hosts the demo fixture in the same process as the
 * parent and then runs the CLI. spawnSync freezes this event loop, so the
 * server cannot accept the crawl and the homepage times out.
 */

import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { startDemoServer } from './fixtures/demo-app/server.ts';

describe('demo server event loop', () => {
  it('answers an async child and does not answer spawnSync', async () => {
    const demo = await startDemoServer({ mode: 'buggy' });
    const script = `
      fetch(process.argv[1])
        .then(res => process.exit(res.status === 200 ? 0 : 1))
        .catch(() => process.exit(2));
    `;
    try {
      const blocked = spawnSync(process.execPath, ['-e', script, `${demo.url}/`], { timeout: 800 });
      expect(blocked.status).not.toBe(0);

      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script, `${demo.url}/`]);
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('async child hung'));
        }, 5_000);
        child.once('error', reject);
        child.once('close', status => {
          clearTimeout(timer);
          resolve(status);
        });
      });
      expect(code).toBe(0);
    } finally {
      await demo.close();
    }
  }, 15_000);
});
