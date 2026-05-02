#!/usr/bin/env node
/**
 * monkeytest CLI
 *
 * Two commands so far:
 *
 *   monkeytest explore <url> [--max 8] [--no-headless] [--out path]
 *     Crawl <url>, summarise pages, write SiteMap + TestPlan to disk and
 *     print a compact summary to the terminal. Useful for verifying the
 *     engine works end-to-end without spinning up the runner service.
 *
 *   monkeytest run <url>
 *     Reserved for v0.2 — will execute the test plan and emit bug reports.
 *     Currently delegates to `explore` so the binary stays useful.
 *
 * Designed to be invokable both as a built binary (after `npm run build`,
 * via `bin.monkeytest` in package.json) and via `tsx src/cli.ts` for fast
 * dev iteration.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Monkey } from './index.js';

interface ParsedArgs {
  command: 'explore' | 'run' | 'help';
  url?: string;
  maxPages: number;
  headless: boolean;
  outDir: string;
  model?: string;
  showHelp: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {

  const args: ParsedArgs = {
    command: 'help',
    maxPages: 8,
    headless: true,
    outDir: '.monkeytest',
    model: process.env.OPENAI_MODEL || process.env.GEMINI_MODEL,
    showHelp: false,
  };

  const [, , cmd, ...rest] = argv;

  if (!cmd || cmd === '-h' || cmd === '--help'){
    args.showHelp = true;
    return args;
  }

  if (cmd !== 'explore' && cmd !== 'run'){
    console.error(`Unknown command: ${cmd}`);
    args.showHelp = true;
    return args;
  }

  args.command = cmd;

  for (let i = 0; i < rest.length; i++){
    const a = rest[i];
    if (a === '--max' || a === '-m'){
      args.maxPages = parseInt(rest[++i], 10);
    } else if (a === '--no-headless'){
      args.headless = false;
    } else if (a === '--out' || a === '-o'){
      args.outDir = rest[++i];
    } else if (a === '--model'){
      args.model = rest[++i];
    } else if (a === '-h' || a === '--help'){
      args.showHelp = true;
    } else if (!args.url){
      args.url = a;
    }
  }

  return args;

}

function printHelp(){
  console.log(`
monkeytest — explore a website and generate an LLM-written test plan

Usage:
  monkeytest explore <url> [options]
  monkeytest run     <url> [options]   (v0.1 currently runs explore)

Options:
  -m, --max <n>       max pages to visit during exploration (default 8)
      --no-headless   show the browser window during the crawl
  -o, --out <dir>     write SiteMap + TestPlan JSON here (default ./.monkeytest)
      --model <id>    override model id (OpenAI or Gemini depending on env)
  -h, --help          show this help

Environment:
  OPENAI_API_KEY      if set, OpenAI is used (default model gpt-4o-mini)
  OPENAI_MODEL        optional override for OpenAI
  GEMINI_API_KEY      use Gemini instead when OPENAI_API_KEY is unset
  GOOGLE_API_KEY      alias for GEMINI_API_KEY
  GEMINI_MODEL        optional — same effect as --model for Gemini

Examples:
  OPENAI_API_KEY=sk-... monkeytest explore https://example.com
  GEMINI_API_KEY=AIza... monkeytest explore https://example.com
  monkeytest explore https://example.com --max 20 --no-headless
`);
}

async function main(){

  const args = parseArgs(process.argv);

  if (args.showHelp || !args.url){
    printHelp();
    if (!args.showHelp) process.exit(1);
    return;
  }

  const useOpenAI = Boolean(process.env.OPENAI_API_KEY);
  if (!useOpenAI && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY){
    console.error(
      'Set OPENAI_API_KEY, or GEMINI_API_KEY (or GOOGLE_API_KEY) for the LLM. '
      + 'OpenAI is used when OPENAI_API_KEY is present (avoids Gemini 503s).'
    );
    process.exit(1);
  }

  const provider = useOpenAI ? 'openai' : 'gemini';
  const defaultModel = useOpenAI
    ? (args.model || process.env.OPENAI_MODEL || 'gpt-4o-mini')
    : (args.model || process.env.GEMINI_MODEL || 'gemini-flash-lite-latest');

  const monkey = new Monkey({
    llm: {
      explorer: { provider, model: defaultModel },
      planner:  { provider, model: defaultModel },
    },
  });

  console.log(`\n→ Exploring ${args.url} (max ${args.maxPages} pages, headless=${args.headless})…\n`);

  const t0 = Date.now();
  const { siteMap, plan } = await monkey.exploreAndPlan(args.url, {
    explore: {
      maxPages: args.maxPages,
      headless: args.headless,
      onPage: (p) => console.log(`  · visited [${p.authGated ? 'auth' : 'open'}] ${p.url} — ${p.summary}`),
    },
  });

  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  // Persist to disk so other tools (and humans) can inspect.
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'sitemap.json'), JSON.stringify(siteMap, null, 2));
  writeFileSync(resolve(outDir, 'plan.json'),    JSON.stringify(plan,    null, 2));

  console.log('\n──────── SiteMap ────────');
  console.log(`  start:    ${siteMap.startUrl}`);
  console.log(`  type:     ${siteMap.siteType}`);
  console.log(`  summary:  ${siteMap.summary}`);
  console.log(`  pages:    ${siteMap.pages.length} visited, ${siteMap.pendingUrls.length} pending, ${siteMap.failedUrls.length} failed`);

  if (siteMap.failedUrls.length){
    console.log('\n  failed:');
    for (const f of siteMap.failedUrls.slice(0, 5)){
      console.log(`    - ${f.url}  (${f.reason})`);
    }
  }

  console.log('\n──────── TestPlan ────────');
  if (plan.flows.length === 0){
    console.log('  (planner produced no flows)');
  } else {
    plan.flows.forEach((f, i) => {
      console.log(`  ${i + 1}. [${f.kind}] ${f.name}  (severity-if-fails: ${f.severityIfFails})`);
      console.log(`        start: ${f.startUrl}`);
      console.log(`        steps:`);
      f.steps.forEach((s, j) => console.log(`          ${j + 1}. ${s.action}${s.expectation ? `  → ${s.expectation}` : ''}`));
      console.log(`        expectation: ${f.expectation}`);
    });
  }
  if (plan.notes) console.log(`\n  notes: ${plan.notes}`);

  console.log(`\n✓ Done in ${dt}s. Wrote ${outDir}/sitemap.json and ${outDir}/plan.json\n`);

}

main().catch((err) => {
  console.error('\n✗ monkeytest failed:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
