# Repository Guidelines

## Architecture Overview
- Core (`mock-csharp/MockRuntime.Core`): C# engine (stepping, breakpoints, variables).
- CLI (`mock-csharp/MockRuntime.Cli`): JSON‑over‑stdio bridge for the adapter.
- Debug client (`mock-csharp/MockRuntime.Debug`): No‑JSON console harness for quick checks.
- Adapter proxy (`vscode-mock-debug-csharp/src/runtimeSelector.ts`): Spawns CLI, maps requests/events to the adapter, and mirrors TS mock behavior (stack, disassembly, step targets).
- Reference (`vscode-mock-debug`): Original TypeScript mock for comparison (DO NOT EDIT).

### Diagram
```mermaid
flowchart LR
  subgraph VSCode[VS Code]
    A[Extension Host<br/>(vscode-mock-debug-csharp)]
    subgraph Adapter[Adapter Layer]
      AP[runtimeSelector.ts<br/>Proxy]
      MD[mockDebug.ts]
    end
  end

  subgraph Runtime[Mock Runtime (C#)]
    CLI[MockRuntime.Cli<br/>(JSON over stdio)]
    CORE[MockRuntime.Core<br/>(Engine + IMockDebugger)]
    DBG[MockRuntime.Debug<br/>(Console client)]
  end

  subgraph Docs[Docs]
    ST[Status.md]
    PR[PROTOCOL.md]
    MR[mock-csharp/README.md]
    TD[vscode-mock-debug-csharp/TODO.md]
  end

  A -->|DAP| MD
  MD <-->|RuntimeLike| AP
  AP -->|spawn dotnet| CLI
  CLI <-->|JSON lines| AP
  CLI --> CORE
  DBG --> CORE

  AP -. reads .env / fallback .-> CLI
  ST -. overview .- Docs
  PR -. protocol .- CLI
  MR -. engine/cli .- CORE
  TD -. plan .- AP
```

## Project Structure
- `vscode-mock-debug/`: Extension variant using the C# runtime. Source in `src/`, bundle to `dist/`. Uses `.env` `MOCK_RUNTIME_PATH` or auto‑discovers CLI.
- `mock-csharp/`: .NET solution with `MockRuntime.Core`, `MockRuntime.Cli`, `MockRuntime.Debug`, and `sample/` inputs.
- Key docs: `Status.md` (current features), `PROTOCOL.md` (CLI protocol), `mock-csharp/README.md` (engine/CLI), `vscode-mock-debug-csharp/TODO.md` (work plan).

## Build, Run, Test
- Adapter (TS): `cd vscode-mock-debug-csharp && npm install && npm run build`.
- C# runtime: `dotnet build mock-csharp -c Debug`.
- Debug client: `dotnet run --project mock-csharp/MockRuntime.Debug -- --program mock-csharp/sample/test.md`.

## Coding Style
- TS: 2‑space indent, semicolons, ESLint (`npm run lint`).
- C#: .NET 8, nullable enabled, prefer explicit names and small, testable methods.

## Notes & Conventions
- Variables: `$name=...` creates locals; globals `global_0..9`. Debug Console edits persist to engine.
- Stepping: over/back skips empty lines; instruction/data breakpoints and exception filters supported.
- Disassembly: provided synchronously by the adapter from source words; instruction bps in engine.

## Commit & PRs
- Use clear, imperative messages; link issues. Ensure TS builds (`npm run build`) and C# builds (`dotnet build`) before review.
