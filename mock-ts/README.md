mock-ts — TypeScript Mock Runtime (stdio/tcp)

Overview
- Implements the JSON-over-line protocol defined in PROTOCOL.md.
- Provides both stdio mode and a TCP server mode.
- Engine logic is adapted from the original `mockRuntime.ts` so stepping, breakpoints, variables, disassembly, and exception filters behave the same.

Usage
- Build: from repo root, run `cd mock-ts && npm run build` (requires local TypeScript).
- Stdio: `node dist/cli.js`
- TCP server: `node dist/cli.js --server --host 127.0.0.1 --port 4711 [--program /abs/path.md] [--stop-on-entry]`

Protocol
- Line-delimited JSON (UTF-8). One JSON object per line.
- See PROTOCOL.md for request/response/event shapes and commands.

Notes
- `launch` preloads the program and optionally stops on entry.
- `setBreakpoints` replaces existing breakpoints for a path.
- `continue`, `next`, `stepIn`, `stepOut`, `pause`, variables, data/instruction breakpoints, and disassembly are implemented.

