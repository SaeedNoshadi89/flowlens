---
name: flowlens
description: Generate, regenerate or open an interactive HTML flow map of the current repository with FlowLens (API calls, data flow, module dependencies, agent handoffs, with file and line evidence), or change what it scans. Use when the user asks to map, visualize or explain how the project's code flows, or to refresh, open or re-scope the flow map.
---

# FlowLens map

FlowLens analyzes the repository locally and read-only, and writes a self-contained HTML map plus the graph JSON. It needs Node.js 20+; Python 3.8+ is used for Python files when available.

The CLI ships with this plugin. Its wrapper is `scripts/flowlens` in the plugin root, which is two folders above this SKILL.md file (`../../scripts/flowlens` relative to this file). Call it by its absolute path; below it is written as `flowlens`. If the wrapper cannot run, use `node <plugin root>/engine/flowlens.mjs`.

## Steps

1. **Show the root.** Run `flowlens root --json` from the user's current directory and tell the user which root will be scanned (`root`) and where they are inside it (`cwdRelative`). If they named another project folder, add `--root <dir>` to every command below.
2. **Pick the scope.**
   - If the user already gave scan options (`--preset`, `--include`, `--relations`, `--exclude`), use them.
   - Otherwise run `flowlens config`. If `saved` is true and the user did not ask to change the scope, use `flowlens regenerate`.
   - If nothing is saved, or the user wants to change it, run `flowlens presets --json` and ask the user:
     - Scope: whole repository, presets that resolved to folders (show the folders, e.g. "backend: services/api/"), the current folder when `cwdRelative` is not empty, or custom folders relative to the root. Presets can be combined and the folder list edited.
     - Relationships: API calls (`api`), data flow (`data`), module dependencies (`deps`), agent handoffs (`agents`). Default: all.
3. **Scan.** `flowlens scan --preset <names> --relations <list> --save`, or `flowlens scan --include <path1,path2> --relations <list> --save`, or `flowlens regenerate`. `--save` stores the choice in `<root>/.flowlens/config.json`.
4. **Report.** Give the map path and the graph JSON path from the output, the counts (nodes, edges, inferred, unresolved, scenarios) and any warnings. Offer to open it with `flowlens open` (or the user can open the file in any browser; it works offline).

## Rules

- Do not edit the user's source files. FlowLens only writes inside `.flowlens/` (or `--out`).
- Do not run the analyzed project's code, install its dependencies or start its servers.
- Keep the map's distinctions when you describe it: inferred edges are plausible links with a stated reason, unresolved edges have a runtime-decided target, and replays are simulated from source, not recorded runs.
