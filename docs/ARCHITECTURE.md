# Architecture

FlowLens is one engine with several front doors. The CLI, the Claude Code plugin and the Codex plugin all run the same bundled `engine/flowlens.mjs`.

```text
 host packages            plugins/claude/flowlens (skills + bin/flowlens)
                          plugins/codex/flowlens  (skill + scripts/flowlens)
                                      │  both exec node engine/flowlens.mjs
 CLI                      src/cli/main.ts        scan · regenerate · setup · presets · open · render · validate
                                      │
 scope                    src/scan/root.ts       repository root (.git walk-up or --root)
                          src/scan/walker.ts     read-only walk: ignore files, exclusions, secrets, binaries, symlinks
                          src/config/presets.ts  presets → folders (manifests, folder names, imports)
                          src/config/settings.ts per-project .flowlens/config.json
                                      │  files in scope
 adapters (replaceable)   src/analyze/python/    pyfacts.py (stdlib ast, python3 -I) → FileFacts
                          src/analyze/js/        @babel/parser → FileFacts
                                      │  FileFacts[] (src/analyze/facts.ts, language-neutral)
 linker                   src/analyze/link.ts    imports, calls, routes, requests, stores, agents → nodes + edges with evidence and provenance
 scenarios                src/analyze/scenarios.ts  ordered walks with branch alternatives (simulated replays)
                                      │  FlowGraph (src/graph/schema.ts, versioned)
 renderer                 src/render/html.ts     one self-contained HTML file (CSP, escaped JSON)
                          src/render/assets/     core.js (pure view, layout, replay, URL state) + app.js (DOM) + app.css
```

Each layer can be tested on its own. The adapters do no linking, the linker never reads files, the renderer only reads a `FlowGraph`, and `flowlens render graph.json` re-renders a graph without analyzing anything.

## Graph schema (`flowlens.graph`, version 1.0.0)

Defined in `src/graph/schema.ts` and checked by `src/graph/validate.ts` (`flowlens validate`).

| Field | Content |
| --- | --- |
| `nodes[]` | `id` (stable, readable), `kind` (module, function, endpoint, request, store, queue, external, agent, tool, unknown), `label`, `layer` (frontend, backend, agents, data, external, shared), repository-relative `path` and `line`, `feature`, owning `module`, `adapter`, `attrs` |
| `edges[]` | `kind` (imports, calls, requests, routes_to, handles, reads, writes, enqueues, external_call, handoff, invokes_tool, implemented_by), derived `relation` (api, data, deps, agents, calls), `provenance` (observed, inferred, unresolved), `evidence[]` (path, line, optional column, analyzer note), `reason` (required unless observed), optional `data`, `condition`, `branchGroup` |
| `scenarios[]` | `kind` (entry-flow, api-flow, endpoint-flow, agent-flow), `entry`, `replay: "simulated"`, `basis: "static-analysis"`, ordered `steps[]` (edge, depth, optional `branch` with option/of/condition) |
| `scope` | preset, include, exclude, analyzed relations, top-level folders with `scanned` true/false |
| `coverage` | files considered and analyzed, skipped counts by reason, languages, adapter status, parse errors, inferred and unresolved counts, unsupported frameworks |
| `diagnostics[]` | warnings and notes with optional location |
| `traces` | always empty in 1.0.0; reserved for runtime traces, which must stay separate from static evidence |

Rules that the validator and tests enforce:

- An observed edge has at least one evidence location.
- An inferred or unresolved edge has a reason.
- Paths are repository-relative POSIX paths.
- A relation always matches its edge kind.
- Every scenario is `simulated`.

IDs are built from the readable key, for example `fn:api/app/store/orders_repo.py#save_order`. A key that had to be cleaned, or that is too long, gets a short hash appended, so different keys never share an ID and the same code always produces the same ID.

## Adding an adapter

1. Implement `LanguageAdapter` (`src/analyze/facts.ts`): declare the file extensions it handles, an `available()` check (for example, that an interpreter exists) and `extract(files) → FileFacts[]`.
2. Fill the language-neutral records: imports, functions, calls, routes, routers and mounts, requests with a `UrlShape`, stores, graphs, SDK agents, tools and commands. Report literals only when they are route paths, URL paths, table names or node names.
3. Register the adapter in `src/analyze/index.ts`. If it is unavailable at run time, it shows up in Coverage and Diagnostics instead of failing.
4. Add a fixture-based test. The linker, scenarios and renderer need no changes.

A framework that fits an existing language (for example Django URLconf) goes into that language's extractor as new facts. A framework that needs a new relationship type needs a new edge kind in the schema and a minor version bump.
