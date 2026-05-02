/**
 * Smoke test that exercises the Playwright + scrape pipeline without needing
 * a real LLM key. Stubs the LLM with canned responses, points the explorer
 * at example.com, and prints the resulting SiteMap + TestPlan.
 *
 * Run with:  node scripts/smoke.mjs
 */

import { explore } from '../dist/explorer/index.js';
import { plan } from '../dist/planner/index.js';

const stubLLM = {
  providerLabel: 'stub',
  async generateJSON({ label }) {
    if (label === 'explorer.summarisePage'){
      return {
        summary: 'Static placeholder page used as the canonical example domain.',
        authGated: false,
        interactive: [
          { kind: 'link', label: 'More information...' },
        ],
      };
    }
    if (label === 'explorer.summariseSite'){
      return {
        siteType: 'placeholder',
        summary: 'A single-page documentation placeholder reserved by IANA for examples.',
      };
    }
    if (label === 'planner.generate'){
      return {
        flows: [
          {
            id: 'visit-example',
            name: 'Visit the example.com homepage',
            description: 'A user lands on the homepage and reads the placeholder text.',
            kind: 'happy_path',
            startUrl: 'https://example.com/',
            steps: [
              { action: 'Navigate to https://example.com/', expectation: 'The placeholder page loads with the heading "Example Domain".' },
              { action: 'Click the "More information..." link', expectation: 'Browser navigates to iana.org.' },
            ],
            expectation: 'Page loads and the link is clickable.',
            severityIfFails: 'minor',
          },
        ],
        notes: 'Stub plan from smoke test.',
      };
    }
    throw new Error(`stub LLM has no canned response for ${label}`);
  },
};

const t0 = Date.now();
const siteMap = await explore('https://example.com', stubLLM, {
  maxPages: 1,
  headless: true,
  onPage: (p) => console.log('  · visited', p.url, '—', p.summary),
});
console.log('\n[explore] done in', ((Date.now() - t0) / 1000).toFixed(1), 's');
console.log('  pages:', siteMap.pages.length, 'failures:', siteMap.failedUrls.length);
console.log('  siteType:', siteMap.siteType);

const testPlan = await plan(siteMap, stubLLM);
console.log('\n[plan] flows:', testPlan.flows.length);
for (const f of testPlan.flows){
  console.log(`  - [${f.kind}] ${f.name} (${f.steps.length} steps)`);
}

console.log('\nOK — engine pipeline is wired correctly.');
