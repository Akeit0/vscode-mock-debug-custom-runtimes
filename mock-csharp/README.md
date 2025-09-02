## MockRuntime (C#)

The C# implementation of the Mock Debug runtime. It exposes a simple engine and a CLI that speaks a line‑delimited JSON protocol (see `/PROTOCOL.md`).

Positions are zero‑based in this protocol; adapters translate to/from DAP’s 1‑based values.

### Projects
- `MockRuntime.Core/` — Engine (`Engine.cs`) and `IMockDebugger` callbacks.
- `MockRuntime.Protocols/` — MessageProtocols.
- `MockRuntime.Cli/` — Unified CLI (stdio by default; `--server` for TCP). Optional if you prefer a single entry.

### Build
- From repo root (or this folder): `dotnet build mock-csharp -c Debug`

### Run
- Stdio CLI (recommended for adapters):
  - `dotnet run --project mock-csharp/MockRuntime.Cli --`
  - Reads `request` JSON per line from stdin; writes `response`/`event` per line to stdout.
- TCP server CLI:
  - `dotnet run --project mock-csharp/MockRuntime.Cli -- --server --host 127.0.0.1 --port 4711 --program /abs/path.md [--stop-on-entry]`
  - Accepts a single client at a time; echoes inbound lines to console for debugging.

### Protocol Summary
- Transport: UTF‑8, one JSON object per `\n` line; no Content‑Length framing.
- Envelopes:
  - `request`: `{ type, id, command, args? }`
  - `response`: `{ type, id, success, body?, message? }`
  - `event`: `{ type, event, body? }`
- See `/PROTOCOL.md` for complete commands, payloads, and examples.

### Engine Features
- Stepping: `continue` (forward/reverse), `next` (over), `stepIn`, `stepOut`.
- Breakpoints: source (line), data (variable read/write), instruction (word index).
- Exceptions: named and “other” filters.
- Stack/disassembly: frames/instructions derived from words of the current line.
- Variables: locals (`$name` or `$name=...`) and simple globals.
- Events: `stopped` (reasons: `entry|breakpoint|step|dataBreakpoint|instructionBreakpoint|exception|pause`), `output`, `terminated`.

### Semantics
- Breakpoint verification: a line breakpoint is “verified” if the target line is non‑empty; lines are not shifted up/down by the engine.
- Stop‑on‑entry: if `launch.stopOnEntry` is true, the CLI emits a stopped `entry` event immediately at the current location.
- Line/column values in all events are zero‑based.

### IMockDebugger callbacks
- `OnStopOnEntry(line, column?)`, `OnStopOnStep(line, column?)`, `OnStopOnBreakpoint(line, column?)`
- `OnStopOnException(line, exception?, column?)`, `OnStopOnDataBreakpoint(line, column?)`, `OnStopOnInstructionBreakpoint(line, column?)`
- `OnBreakpointValidated(id, verified)`
- `OnOutput(category, text, file, line, column)`
- `OnEnd()`

### Notes
- You can use the other runtimes for side‑by‑side behavior comparison; both speak the same protocol.
- The VS Code example extension (`/vscode-mock-debug`) is useful for adapter testing with either CLI.
