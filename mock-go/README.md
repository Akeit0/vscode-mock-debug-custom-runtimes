# mock-go — Go Mock Runtime (stdio/tcp)

A Go implementation of the Mock Runtime CLI, speaking the same JSON-over-lines protocol described in /PROTOCOL.md.

Build
- `cd mock-go && go build ./cmd/mock-go`

Run
- Stdio: `./mock-go`
- TCP server: `./mock-go --server --host 127.0.0.1 --port 4711 [--program /abs/path.md] [--stop-on-entry]`

Protocol
- UTF-8, one JSON object per line (no Content-Length).
- Envelopes: request, response, event. Zero-based line/column.
- Commands and events follow /PROTOCOL.md.

Notes
- Breakpoint verification: line is verified if non-empty; no line shifting.
- Stop-on-entry: emits a stopped event immediately when requested.
- Engine behavior mirrors C#/TS variants for stepping, data/instruction breakpoints, variables, exceptions, and disassembly.

