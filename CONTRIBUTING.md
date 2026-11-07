# Contributing

Thanks for helping. FlowLens is MIT licensed, and by contributing you agree that your work is released under the same license.

## Setup

```sh
npm install
npm run check
```

`npm run check` runs the TypeScript typecheck, builds the bundle, runs all tests (including the headless-Chrome report tests when Chrome or Chromium is installed; set `CHROME_PATH` otherwise), reruns the CLI tests against the bundle, and verifies both plugin packages.

Node.js 22.18+ runs the TypeScript sources directly (`npm run dev -- scan …`). The built bundle needs Node.js 20+.

## Workflow

- `main` is the only long-lived branch. Work on a short-lived branch from `main` and open a pull request against `main`.
- Keep the layers separate (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). Adapters produce facts, the linker builds the graph, and the renderer reads only the graph.
- Every new relationship an adapter emits needs evidence. If the target is not written in source, emit an `unresolved` edge with a reason, or an `inferred` edge with the rule that joins two observed facts. Never create an edge from naming similarity alone.
- Do not put raw source text or configuration values in the graph or the report.
- Add or extend a fixture test for every new pattern. Fixtures are synthetic and must never contain real data or real credentials.
- After changing `src/`, run `npm run build` and commit the refreshed `plugins/*/flowlens/engine/` folders. CI checks that they match the build: run `npm run build` and then `git diff --exit-code plugins`.
- Run `npm run demo` when the report or analysis output changes, and commit the regenerated `examples/`.
- Update the README (supported patterns, limitations) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (schema) in the same change.

## Releasing

Bump `version` in `package.json`, `plugins/claude/flowlens/.claude-plugin/plugin.json`, `plugins/codex/flowlens/plugin.json` and `plugins/codex/flowlens/.codex-plugin/plugin.json`, and `ENGINE_VERSION` in `src/analyze/index.ts`. Then run `npm run check`. `scripts/verify-packages.ts` fails when the versions disagree.

## Reporting security issues

Report problems such as a secret leaking into a report, a path escaping the root or code execution privately to the maintainers instead of in a public issue.
