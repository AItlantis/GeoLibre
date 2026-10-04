# GeoLibre fast and extended CI tiers

Tracking issue: https://github.com/AItlantis/GeoLibre/issues/3

## Goal

Give pull requests fast, feature-focused feedback while preserving full-suite coverage in scheduled and explicitly requested runs. This document proposes CI scope only; it does not change workflow files.

## Required pull request checks

- Lint only changed TypeScript/JavaScript files, with existing repository-wide lint retained where its runtime is already within the fast budget.
- Run focused unit and contract tests selected from the changed paths. For scenario comparison, include `tests/scenario-comparison-data.test.ts`, `tests/scenario-comparison-timeline.test.ts`, `tests/testudo-protocol.test.ts`, and `tests/embed-client.test.ts`.
- Build the affected deliverable: `npm run build:embed` for the embedded viewer and `npm run build -w geolibre-desktop` for desktop code.
- Run one short browser smoke covering the touched user flow. Comparison changes should cover the built embedded viewer selecting the scenario/time and rendering the comparison state.
- Keep focused regression tests required even when their broader suite moves to the extended tier.

## Extended checks

- Run full frontend coverage, worker checks, backend coverage, and Rust checks nightly or on demand.
- Run core Playwright E2E nightly or on demand; use the existing full-e2e opt-in for the larger feature suite.
- Make extended results visible on the PR and retain a clear manual opt-in before merge.

## Rollout and safeguards

1. Record baseline duration and failure rate for the current PR jobs.
2. Add the focused checks as required PR jobs before moving full suites out of the required path.
3. Run both tiers together for a transition period and compare coverage and regressions.
4. Move only long-running broad suites to the extended tier after owners confirm the focused suite covers changed behavior.
5. Document the commands and triggers in the CI workflow and contributor guide.

## Acceptance

- Required PR feedback completes within the agreed fast budget and includes lint, focused tests, relevant builds, and one short browser smoke.
- The full frontend/worker/backend/Rust suite and core E2E remain runnable on demand and on a schedule.
- No existing assertion coverage is deleted; moved suites remain visible and failures notify maintainers.
- CI tier definitions have clear job names and branch-protection requirements.