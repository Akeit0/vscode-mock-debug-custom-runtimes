## C# Runtime Protocol

### Transport
- Encoding: UTF-8, line-delimited JSON (one message per `\n`).
- Channel: stdin/stdout of `dotnet <MOCK_RUNTIME_PATH>`. No Content-Length framing.
- Each message is a single JSON object per line. Newlines inside strings must be escaped.

### Envelope
- `request`: `{ "type": "request", "id": <int>, "command": <string>, "args"?: { ... } }`
- `response`: `{ "type": "response", "id": <int>, "success": <bool>, "body"?: { ... }, "message"?: <string> }`
- `event`: `{ "type": "event", "event": <string>, "body"?: { ... } }`
- Line/column semantics: zero-based in this protocol. The VS Code adapter converts from/to DAP’s 1-based values.

### Core Commands
- `initialize` → Response body: `{ "capabilities": { } }` (reserved for future flags).
- `launch` → Args: `{ "program": <abs path>, "stopOnEntry"?: <bool> }`. If `stopOnEntry` is true, emit `stopped { reason: "entry" }` after the OK response; otherwise begin running.
- `setBreakpoints` → Args: `{ "path": <abs path>, "lines": [<int>] }`. Response body: `{ "breakpoints": [{ "id": <int>, "verified": <bool>, "line": <int> }] }`.
- `continue` → Args: `{ "reverse"?: <bool> }`. Respond OK, then run until breakpoint/exception/end. Emits `stopped { reason: "breakpoint"|"exception" }` or `terminated`.
- `next` (step over) → Args: `{ "reverse"?: <bool> }`. Respond OK, then emit `stopped { reason: "step" }`.
- `stepIn` → Args: `{ "targetId"?: <int> }`. Respond OK; engine emits `stopped { reason: "step" }`.
- `stepOut` → No args. Respond OK; engine emits `stopped { reason: "step" }`.
- `attach` → Args: `{ "stopOnAttach"?: <bool> }`. Respond OK; if `stopOnAttach` is true, engine pauses and emits `stopped { reason: "pause" }`.
- `pause` → No args. Respond OK; engine emits `stopped { reason: "pause" }` promptly.
- `disconnect` → No args. Respond OK and close the connection (server detaches; stdio exits).
- `stackTrace` → Args: `{ "startFrame"?: <int>, "levels"?: <int> }`. Response body: `{ "stackFrames": [{ "id": <int>, "name": <string>, "source": { "name": <string>, "path": <abs path> }, "line": <int>, "column": <int> }], "totalFrames": <int> }`.

### Variables
- `getLocalVariables` → Response body: `{ "variables": [{ "name": <string>, "value": <primitive | array> }] }`. Array values are an array of `{ name, value }` pairs.
- `getLocalVariable` → Args: `{ "name": <string> }`. Response body: `{ "variable": { "name": <string>, "value": <...> } }`.
- `setVariable` → Args: `{ "name": <string>, "value": <primitive | array> }`. Updates the variable in the engine.
- `getGlobalVariables` → Response body: `{ "variables": [{ "name": "global_0", "value": 0 }, ...] }`.

### Events
- `stopped` body: `{ "reason": "entry"|"breakpoint"|"step"|"exception", "line"?: <int>, "column"?: <int> }`.
  - Additional reason: `"pause"` for user-initiated pause or stop-on-attach.
- `output` body: `{ "category": "stdout"|"stderr"|"console", "text": <string>, "file": <abs path>, "line": <int>, "column": <int> }`.
- `terminated` body: `{}`.

### Breakpoints & Disassembly
- `breakpointLocations` → Args: `{ "path": <abs path>, "line": <int> }`. Response: `{ "breakpoints": [{ "column": <int> }] }`.
- `breakpointLines` → Args: `{ "path": <abs path> }`. Response: `{ "lines": [<int>] }` (all valid source lines for breakpoints).
- `disassemble` → Args: `{ "address": <int>, "instructionCount": <int> }`. Response: `{ "instructions": [{ "address": <int>, "instruction": <string>, "line"?: <int> }] }`.

### Error Handling
- Unknown/invalid command: `response.success=false` with a `message`.
- Runtime failures should not crash the process; emit a failed response and continue.

### Example Session
- Adapter → `{ "type":"request", "id":1, "command":"initialize" }`
- Runtime ← `{ "type":"response", "id":1, "success":true, "body":{ "capabilities":{} } }`
- Adapter → `{ "type":"request", "id":2, "command":"launch", "args":{ "program":"/abs/path/test.md", "stopOnEntry":true } }`
- Runtime ← `{ "type":"response", "id":2, "success":true }`
- Runtime ← `{ "type":"event", "event":"stopped", "body":{ "reason":"entry" } }`
- Adapter → `{ "type":"request", "id":3, "command":"setBreakpoints", "args":{ "path":"/abs/path/test.md", "lines":[1,3] } }`
- Runtime ← `{ "type":"response", "id":3, "success":true, "body":{ "breakpoints":[{"id":1,"verified":true,"line":1},{"id":2,"verified":false,"line":3}] } }`
- Adapter → `{ "type":"request", "id":4, "command":"continue" }`
- Runtime ← `{ "type":"response", "id":4, "success":true }`
- Runtime ← `{ "type":"event", "event":"output", "body":{ "category":"stdout","text":"...","file":"/abs/path/test.md","line":0,"column":1 } }`
- Runtime ← `{ "type":"event", "event":"stopped", "body":{ "reason":"breakpoint" } }`
