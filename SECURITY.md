# Security policy

## Supported versions

We aim to patch security issues in the latest **minor** release line of
`@monkeytestai/monkeytest-core`. Older majors may not receive fixes.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| &lt; 0.2 | :x:                |

## Reporting a vulnerability

**Please do not** open a public GitHub issue for security reports.

Instead, email **security@monkeytest.ai** with:

- A short description of the issue and its impact
- Steps to reproduce (or a proof-of-concept), if possible
- Affected versions / commit range, if known

We will acknowledge receipt within **5 business days** where possible and work
with you on a coordinated disclosure timeline before any public announcement.

## Scope

In scope for this program:

- The `monkeytest-core` TypeScript package and its published CLI
- Documented public APIs (`Monkey`, `EventBus`, `explore`, `plan`, `runPlan`, etc.)

Out of scope (report to the appropriate project):

- Issues in consumer applications (e.g. your SaaS dashboard) unless they stem
  from a documented misuse of this library
- Playwright / Chromium bugs upstream
- LLM provider outages or API key leaks caused by user misconfiguration

## Safe usage reminders

- Never commit API keys; use environment variables or a secrets manager.
- Run browser automation in isolated environments in production (containers,
  dedicated workers, least-privilege network policies).
- Review AGPL obligations if you modify the engine and offer it as a network
  service—see the [license FAQ](https://docs.monkeytest.ai/guide/license-and-saas).
