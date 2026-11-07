---
name: map
description: Generate, regenerate or open an interactive HTML flow map of the current repository with FlowLens (API calls, data flow, module dependencies, agent handoffs, with file and line evidence). Use when the user asks to map, visualize or explain how the project's code flows, or to refresh or open the flow map.
argument-hint: "[optional scan options, e.g. --preset backend --relations api,data]"
---

# FlowLens map

FlowLens analyzes the repository locally and read-only, and writes a self-contained HTML map plus the graph JSON. The CLI is on your PATH as `flowlens` while this plugin is enabled. If that command is not found, use `node "${CLAUDE_PLUGIN_ROOT}/engine/flowlens.mjs"` in its place. It needs Node.js 20+; Python 3.8+ is used for Python files when available.

Arguments from the user, if any: `$ARGUMENTS`

## Steps

1. **Show the root.** Run `flowlens root --json` from the current directory and tell the user which root will be scanned (`root`) and where they are inside it (`cwdRelative`). If the user named another project folder, add `--root <dir>` to every command below.
2. **Pick the scope.**
   - If the user's arguments already give scan options (`--preset`, `--include`, `--relations`, `--exclude`), use them and skip to step 3.
   - Otherwise run `flowlens config`. If `saved` is true, go to step 3 and use `flowlens regenerate`.
   - If nothing is saved, run `flowlens presets --json` and ask the user with one question each (use your question tool when available):
     - Scope: "Whole repository", or each preset that resolved to folders (show the folders, e.g. "backend: services/api/"), "Current folder" when `cwdRelative` is not empty, or "Custom folders" (then ask for paths relative to the root). Several presets can be combined.
     - Relationships (multi-select): API calls (`api`), data flow (`data`), module dependencies (`deps`), agent handoffs (`agents`). Default: all.
3. **Scan.** Run one of:
   - `flowlens scan --preset <names> --relations <list> --save`
   - `flowlens scan --include <path1,path2> --relations <list> --save`
   - `flowlens regenerate` (saved settings)
   `--save` stores the choice in `<root>/.flowlens/config.json` so the next run repeats it.
4. **Report.** Tell the user the map path and the graph JSON path from the output, the counts (nodes, edges, inferred, unresolved, scenarios) and any warnings (unsupported frameworks, missing Python, parse problems). Offer to open it with `flowlens open`; run it if they agree or asked to open it.

## Rules

- Do not edit the user's source files. FlowLens only writes inside `.flowlens/` (or `--out`).
- Do not run the analyzed project's code, install its dependencies or start its servers.
- When you describe the map, keep its distinctions: an inferred edge is a plausible link with a stated reason, an unresolved edge has a runtime-decided target, and replays are simulated from source, not recorded runs. Do not present inferred or unresolved links as confirmed.
- To change the scope later, use the `setup` skill (`/flowlens:setup`) or pass new options; filters inside the report switch views without re-scanning.
