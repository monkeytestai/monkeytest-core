/**
 * Evidence collected while a step runs, and the product oracles that turn a
 * Playwright "success" into a failed step.
 *
 * A click that throws in the page, follows a link to a 404, or submits a form
 * that returns 500 still resolves the Playwright call. Disabled controls time
 * out inside Playwright and would otherwise be skipped. Both the runner and
 * replay consult this module so verify sees the same failures the run did.
 */

import type { ConsoleMessage, Page, Request, Response } from 'playwright';
import type { ConsoleErrorEvidence, NetworkFailureEvidence } from '../types.js';
import type { ActionOutcome } from './actions.js';

const ACTION_RESOURCE_TYPES = new Set(['document', 'xhr', 'fetch']);

export interface StepEvidence {
  stepIndex: number;
  consoleByStep: Map<number, ConsoleErrorEvidence[]>;
  networkByStep: Map<number, NetworkFailureEvidence[]>;
  pageErrorsByStep: Map<number, string[]>;
}

export interface StepOracle {
  error: string;
  observation: string;
}

export function attachStepEvidence(page: Page): StepEvidence {
  const state: StepEvidence = {
    stepIndex: 0,
    consoleByStep: new Map(),
    networkByStep: new Map(),
    pageErrorsByStep: new Map(),
  };

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    push(state.consoleByStep, state.stepIndex, {
      message: msg.text().slice(0, 500),
      level: msg.type() === 'error' ? 'error' : 'warning',
      url: msg.location()?.url,
      lineNumber: msg.location()?.lineNumber,
    });
  });

  page.on('pageerror', (err: Error) => {
    const message = (err?.message || String(err)).slice(0, 500);
    push(state.pageErrorsByStep, state.stepIndex, message);
    push(state.consoleByStep, state.stepIndex, { message, level: 'error' });
  });

  page.on('requestfailed', (req: Request) => {
    if (req.url().startsWith('ws:') || req.url().startsWith('wss:')) return;
    push(state.networkByStep, state.stepIndex, {
      url: req.url(),
      method: req.method(),
      failureText: req.failure()?.errorText,
      resourceType: req.resourceType(),
    });
  });

  page.on('response', (res: Response) => {
    const status = res.status();
    const resourceType = res.request().resourceType();
    const documentMiss = status === 404 && resourceType === 'document';
    if (status < 500 && !documentMiss) return;
    push(state.networkByStep, state.stepIndex, {
      url: res.url(),
      method: res.request().method(),
      status,
      resourceType,
    });
  });

  return state;
}

/**
 * Let the page deliver `pageerror` / response events that were queued during
 * the action before we read the buffers.
 */
export async function flushStepEvents(page: Page): Promise<void> {
  await page.evaluate(() => true).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 50));
}

/**
 * Priority: uncaught page error, then an action HTTP 5xx, then a document
 * 404. Image, font, and other non-action 5xx responses stay evidence only.
 * A 404 that is not the document (favicon, for example) is ignored.
 */
export function oracleFromEvidence(
  pageErrors: string[],
  network: NetworkFailureEvidence[],
): StepOracle | null {
  if (pageErrors.length > 0) {
    return {
      error: 'pageerror',
      observation: `Uncaught page error: ${truncate(pageErrors[0], 160)}`,
    };
  }

  const serverError = network.find(item => isActionServerError(item));
  if (serverError?.status) {
    return {
      error: `http-${serverError.status}`,
      observation: `${serverError.method} ${serverError.url} returned HTTP ${serverError.status}.`,
    };
  }

  const missing = network.find(item => item.status === 404 && item.resourceType === 'document');
  if (missing) {
    return {
      error: 'http-404',
      observation: `Document ${missing.method} ${missing.url} returned HTTP 404.`,
    };
  }

  return null;
}

export async function applyPassedOracles(
  page: Page,
  evidence: StepEvidence,
  stepIndex: number,
  outcome: ActionOutcome,
): Promise<ActionOutcome> {
  if (outcome.status !== 'passed') return outcome;
  await flushStepEvents(page);
  const hit = oracleFromEvidence(
    evidence.pageErrorsByStep.get(stepIndex) ?? [],
    evidence.networkByStep.get(stepIndex) ?? [],
  );
  if (!hit) return outcome;
  return {
    status: 'failed',
    observation: `${outcome.observation} ${hit.observation}`.trim(),
    error: hit.error,
  };
}

export function isActionServerError(item: NetworkFailureEvidence): boolean {
  if ((item.status ?? 0) < 500) return false;
  if (!item.resourceType) return true;
  return ACTION_RESOURCE_TYPES.has(item.resourceType);
}

function push<T>(map: Map<number, T[]>, stepIndex: number, item: T): void {
  const arr = map.get(stepIndex) ?? [];
  arr.push(item);
  map.set(stepIndex, arr);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
