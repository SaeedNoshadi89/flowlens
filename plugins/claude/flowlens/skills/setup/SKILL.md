---
name: setup
description: Choose or change what FlowLens scans in this repository (whole project, backend, frontend, agents presets or custom folders, and which relationships) and save it as the project's flow map settings. Use when the user wants to change the flow map scope or relationships.
---

# FlowLens setup

The CLI is on your PATH as `flowlens` (fallback: `node "${CLAUDE_PLUGIN_ROOT}/engine/flowlens.mjs"`). `flowlens setup` itself is an interactive terminal prompt, so in this conversation do the same steps with your question tool instead:

1. Run `flowlens root --json` and show the resolved root to the user. Confirm it is the project they mean; if not, ask for the folder and add `--root <dir>` to the commands below.
2. Run `flowlens config` to see the current saved settings, and `flowlens presets --json` to see the folders each preset resolves to, with the reason for each.
3. Ask the user:
   - Scope: whole repository, one or more presets (show the folders each one resolves to), the current folder, or custom folders. Let them edit the folder list.
   - Relationships (multi-select): `api`, `data`, `deps`, `agents`.
   - Optional extra exclusions (gitignore patterns). Dependency, build, binary and secret-like files are always skipped.
4. Save and scan: `flowlens scan --include <folders> --relations <list> [--exclude <patterns>] --save` (or `--preset <names>` when the user picked presets unchanged). For the whole repository use `--preset whole`.
5. Report the saved settings file, the map path and the graph path, and offer `flowlens open`.
