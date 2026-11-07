# FlowLens plugin (codex)

FlowLens analyzes the current repository locally and read-only, and writes an interactive, offline HTML flow map. The map shows API calls from client code to server routes, data flow into stores and queues, module dependencies, and agent handoffs. Every edge is labeled observed, inferred or unresolved and links to its file and line, and scenarios can be replayed step by step as simulated replays.

Ask Codex to map the repository with FlowLens, or invoke the `flowlens` skill. The skill calls `scripts/flowlens`.

The engine in `engine/` is the same bundle for every host, built from the repository's `src/` (`npm run build`). Requirements: Node.js 20+, and Python 3.8+ for Python files. See the repository README for options, supported frameworks and limitations. License: MIT.
