# Publishing plan (deferred)

Both packages (`unbash-walker` and `@cad0p/pi-steering-hooks`) are currently `private: true` in their `package.json`. This is intentional.

## Gate criteria

Before the first npm publish, both of these must be true:

1. **PR [#1](https://github.com/cad0p/pi-steering-hooks/pull/1) is reviewed and merged** to `master` (currently draft; awaiting human review).
2. One of:
   a. The extraction proposal has been filed on [`jdiamond/pi-guard`](https://github.com/jdiamond/pi-guard) and jdiamond has responded (accept/decline/defer), OR
   b. Two weeks have elapsed since the proposal was filed.

The two-week timeout exists to keep the publishing decision unblocked when upstream maintainers are busy or on leave; it isn't a deadline for jdiamond.

## What changes at publish time

- `packages/unbash-walker/package.json`: drop `"private": true`, bump version from `0.0.0-poc.0` to `0.1.0`.
- `packages/pi-steering-hooks/package.json`: same change; swap `"unbash-walker": "workspace:*"` to `"unbash-walker": "^0.1.0"` once `unbash-walker` (or its jdiamond-owned equivalent) is on npm.
- Add GitHub Actions workflows from [`cad0p/semver-calver-release/examples/basic-npm-package`](https://github.com/cad0p/semver-calver-release/tree/main/examples/basic-npm-package) (adjust `main` → `master` in branch triggers).
- Detach the fork relationship from [`samfoy/pi-steering-hooks`](https://github.com/samfoy/pi-steering-hooks) on GitHub (the packages no longer share code).

## Known pre-publish cleanups

- None at this time — the review-fix loops across Phases 0–3 have addressed all known blockers. Any issues surfaced during PR #1 review will be listed here as they come up.
