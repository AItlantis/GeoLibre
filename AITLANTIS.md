# AITLANTIS.md — AItlantis fork governance

This file is deliberately **separate from `CLAUDE.md`** — upstream
(`opengeos/GeoLibre`) actively edits `CLAUDE.md` (e.g. PRs #2120, #2133), and
a fork-only governance section inside it would conflict on every upstream
sync and risk leaking AItlantis-internal notes into an upstream PR. Nothing
in this file changes any upstream-tracking convention documented in
`CLAUDE.md` (i18n, Tauri CSP, plugin architecture, coverage floors, the npm
workspace layout, etc.) — it applies only to `AItlantis/GeoLibre`'s own
downstream work on top of `opengeos/GeoLibre`, principally the
`testudo-*`/`Testudo*` integration surface
(`apps/geolibre-desktop/src/lib/testudo-*.ts`, `packages/embed/src/testudo.ts`,
`scripts/build-testudo.mjs`, `docs/testudo-embedding.md`).

## Submodule relationship

This repo is **planned** to be brought into `AItlantis/testudo` as a git
submodule (not yet done as of 2026-09-25 — see
`docs/dev/plans/active/2026-09-25-geolibre-submodule-shared-governance.md`
in the Testudo repo for status and blockers).

## Issue-driven, PR-only governance

The mechanics (linked-issue requirement, dedicated branch per change, no
direct push/merge/fast-forward to `main`) are spelled out in Testudo's
`RULES.md` §9 and §12–§14 (marked `[shared]` there) — that file is the
single canonical source, not duplicated here. If you cannot resolve it by
relative path from this checkout, use `F:\repos\testudo\RULES.md` (local) or
`https://github.com/AItlantis/testudo/blob/default/RULES.md` (canonical).

Summary, so an agent working only in this repo still has the essentials
without loading the other repo's file:
- Non-trivial work needs a linked issue **on `AItlantis/GeoLibre`'s own
  tracker** (github.com/AItlantis/GeoLibre/issues — enabled 2026-09-25
  specifically for this) before implementation starts.
- Work happens on a dedicated branch, never directly on `main`.
- `main` changes ONLY via a merged, reviewed pull request against
  `AItlantis/GeoLibre#main` — never a direct push, merge, or fast-forward.

## `docs/contributing.md` / `CONTRIBUTING.md` are upstream-owned

Those files are the authoritative, upstream-facing PR guide for external
`opengeos/GeoLibre` contributors and point issues/PRs at `opengeos/GeoLibre`.
They are unaffected by this file and must not be edited to describe
AItlantis-internal workflow — do not file AItlantis-internal work against
`opengeos/GeoLibre`'s issue tracker or PR queue.
