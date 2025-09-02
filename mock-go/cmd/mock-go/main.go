package main

import (
    "bufio"
    "encoding/json"
    "flag"
    "fmt"
    "io"
    "log"
    "net"
    "os"
    "strings"
    "time"

    en "mock-go/internal/engine"
    p "mock-go/internal/protocol"
)

type jsonDebugger struct{ w io.Writer; enc *json.Encoder; file string }

func newJSONDebugger(w io.Writer) *jsonDebugger { return &jsonDebugger{w: w, enc: json.NewEncoder(w)} }

func (d *jsonDebugger) ev(name string, body any) {
    _ = d.enc.Encode(p.Event{Type: "event", Event: name, Body: body})
}
func (d *jsonDebugger) OnStopOnEntry(line int, column *int)               { d.ev("stopped", map[string]any{"reason": "entry", "line": line, "column": n2i(column)}) }
func (d *jsonDebugger) OnStopOnStep(line int, column *int)                { d.ev("stopped", map[string]any{"reason": "step", "line": line, "column": n2i(column)}) }
func (d *jsonDebugger) OnStopOnBreakpoint(line int, column *int)          { d.ev("stopped", map[string]any{"reason": "breakpoint", "line": line, "column": n2i(column)}) }
func (d *jsonDebugger) OnStopOnException(line int, ex *string, column *int) { d.ev("stopped", map[string]any{"reason": "exception", "exception": ex, "line": line, "column": n2i(column)}) }
func (d *jsonDebugger) OnStopOnDataBreakpoint(line int, column *int)      { d.ev("stopped", map[string]any{"reason": "dataBreakpoint", "line": line, "column": n2i(column)}) }
func (d *jsonDebugger) OnStopOnInstructionBreakpoint(line int, column *int) {
    d.ev("stopped", map[string]any{"reason": "instructionBreakpoint", "line": line, "column": n2i(column)})
}
func (d *jsonDebugger) OnStopOnPause(line int, column *int)               { d.ev("stopped", map[string]any{"reason": "pause", "line": line, "column": n2i(column)}) }
func (d *jsonDebugger) OnBreakpointValidated(id int, verified bool)       { d.ev("breakpointValidated", map[string]any{"id": id, "verified": verified}) }
func (d *jsonDebugger) OnOutput(category, text, file string, line, column int) {
    d.ev("output", map[string]any{"category": category, "text": text, "file": file, "line": line, "column": column})
}
func (d *jsonDebugger) OnEnd() { d.ev("terminated", map[string]any{}) }

func n2i(p *int) any { if p == nil { return nil }; return *p }

func main() {
    var (
        asServer      = flag.Bool("server", false, "run TCP server")
        host          = flag.String("host", "127.0.0.1", "server host")
        port          = flag.Int("port", 4711, "server port")
        preload       = flag.String("program", "", "preload program path")
        stopOnEntry   = flag.Bool("stop-on-entry", false, "emit stop on entry when preloading")
    )
    flag.Parse()

    if *asServer {
        addr := fmt.Sprintf("%s:%d", *host, *port)
        ln, err := net.Listen("tcp", addr)
        if err != nil { log.Fatalf("listen: %v", err) }
        log.Printf("Listening on %s...", addr)
        for {
            conn, err := ln.Accept()
            if err != nil { log.Printf("accept: %v", err); continue }
            log.Printf("Client connected")
            go func(c net.Conn) {
                defer c.Close()
                handleConn(c, c, *preload, *stopOnEntry)
                log.Printf("Client disconnected")
            }(conn)
        }
    } else {
        handleConn(os.Stdin, os.Stdout, "", false)
    }
}

func handleConn(r io.Reader, w io.Writer, preload string, stopOnEntry bool) {
    dbg := newJSONDebugger(w)
    eng := en.New(dbg)

    if preload != "" {
        data, err := os.ReadFile(preload)
        if err == nil {
            eng.LoadSource(preload, data)
            if stopOnEntry { dbg.OnStopOnEntry(0, nil) } else { go eng.Continue(false) }
        }
    }

    enc := json.NewEncoder(w)
    scanner := bufio.NewScanner(r)
    buf := make([]byte, 0, 1024*1024)
    scanner.Buffer(buf, 1024*1024)
    for scanner.Scan() {
        line := scanner.Text()
        if strings.TrimSpace(line) == "" { continue }
        var req p.Request
        if err := json.Unmarshal([]byte(line), &req); err != nil { _ = enc.Encode(p.Fail(-1, "invalid json")); continue }
        if !strings.EqualFold(req.Type, "request") { continue }

        switch req.Command {
        case "initialize":
            _ = enc.Encode(p.Ok(req.ID, map[string]any{"capabilities": map[string]any{}}))
        case "attach":
            stop := getArgBool(req.Args, "stopOnAttach")
            _ = enc.Encode(p.Ok(req.ID, map[string]any{"program": eng.SourceFile(), "sourceLength": eng.SourceLength()}))
            if stop { eng.Pause() }
        case "launch":
            program := getArgString(req.Args, "program")
            stop := getArgBool(req.Args, "stopOnEntry")
            data, err := os.ReadFile(program)
            if err != nil { _ = enc.Encode(p.Fail(req.ID, "cannot read program")); break }
            eng.LoadSource(program, data)
            _ = enc.Encode(p.OkEmpty(req.ID))
            if stop { dbg.OnStopOnEntry(0, nil) } else { go eng.Continue(false) }
        case "setBreakpoints":
            path := getArgString(req.Args, "path")
            lines := getArgIntSlice(req.Args, "lines")
            res := eng.SetBreakpoints(path, lines)
            _ = enc.Encode(p.Ok(req.ID, map[string]any{"breakpoints": res}))
        case "continue":
            reverse := getArgBool(req.Args, "reverse")
            _ = enc.Encode(p.OkEmpty(req.ID))
            go eng.Continue(reverse)
        case "disconnect":
            _ = enc.Encode(p.OkEmpty(req.ID))
            return
        case "pause":
            _ = enc.Encode(p.OkEmpty(req.ID))
            eng.Pause()
        case "next":
            reverse := getArgBool(req.Args, "reverse")
            _ = enc.Encode(p.OkEmpty(req.ID))
            eng.Next(reverse)
        case "stepIn":
            var tgt *int
            if v, ok := req.Args["targetId"]; ok {
                if f, ok2 := toInt(v); ok2 { tgt = &f }
            }
            _ = enc.Encode(p.OkEmpty(req.ID))
            eng.StepIn(tgt)
        case "stepOut":
            _ = enc.Encode(p.OkEmpty(req.ID))
            eng.StepOut()
        case "stackTrace":
            start := getArgInt(req.Args, "startFrame", 0)
            levels := getArgInt(req.Args, "levels", 1000)
            frames, count := eng.BuildStack(start, start+levels)
            _ = enc.Encode(p.Ok(req.ID, map[string]any{"stackFrames": frames, "totalFrames": count}))
        case "breakpointLocations":
            path := getArgString(req.Args, "path")
            _ = path // not used for computation here
            line := getArgInt(req.Args, "line", 0)
            cols := eng.GetBreakpointColumns(path, line)
            arr := make([]map[string]int, 0, len(cols))
            for _, c := range cols { arr = append(arr, map[string]int{"column": c}) }
            _ = enc.Encode(p.Ok(req.ID, map[string]any{"breakpoints": arr}))
        case "breakpointLines":
            lines := eng.GetBreakpointLines()
            _ = enc.Encode(p.Ok(req.ID, map[string]any{"lines": lines}))
        case "disassemble":
            address := getArgInt(req.Args, "address", 0)
            count := getArgInt(req.Args, "instructionCount", 32)
            list := eng.Disassemble(address, count)
            _ = enc.Encode(p.Ok(req.ID, map[string]any{"instructions": list}))
        case "getLocalVariables":
            _ = enc.Encode(p.Ok(req.ID, map[string]any{"variables": eng.GetLocalVariables()}))
        case "getLocalVariable":
            name := getArgString(req.Args, "name")
            _ = enc.Encode(p.Ok(req.ID, map[string]any{"variable": eng.GetLocalVariable(name)}))
        case "setVariable":
            name := getArgString(req.Args, "name")
            val, _ := req.Args["value"]
            eng.SetVariable(name, val)
            _ = enc.Encode(p.OkEmpty(req.ID))
        case "getGlobalVariables":
            _ = enc.Encode(p.Ok(req.ID, map[string]any{"variables": eng.GetGlobalVariables()}))
        case "setExceptionBreakpoints":
            var named *string
            if v, ok := req.Args["namedException"]; ok {
                if s, ok2 := v.(string); ok2 && s != "" { named = &s }
            }
            others := getArgBool(req.Args, "otherExceptions")
            eng.SetExceptionsFilters(named, others)
            _ = enc.Encode(p.OkEmpty(req.ID))
        case "setDataBreakpoint":
            addr := getArgString(req.Args, "address")
            access := getArgString(req.Args, "accessType")
            ok := eng.SetDataBreakpoint(addr, access)
            _ = enc.Encode(p.Ok(req.ID, map[string]any{"verified": ok}))
        case "clearAllDataBreakpoints":
            eng.ClearAllDataBreakpoints()
            _ = enc.Encode(p.OkEmpty(req.ID))
        case "setInstructionBreakpoint":
            addr := getArgInt(req.Args, "address", -1)
            ok := eng.SetInstructionBreakpoint(addr)
            _ = enc.Encode(p.Ok(req.ID, map[string]any{"verified": ok}))
        case "clearInstructionBreakpoints":
            eng.ClearInstructionBreakpoints()
            _ = enc.Encode(p.OkEmpty(req.ID))
        default:
            _ = enc.Encode(p.Fail(req.ID, "unknown command: "+req.Command))
        }
        // Small delay to avoid event-response interleaving in some consoles
        time.Sleep(0)
    }
}

// arg helpers
func getArgString(m map[string]any, k string) string {
    if m == nil { return "" }
    if v, ok := m[k]; ok { if s, ok2 := v.(string); ok2 { return s } }
    return ""
}
func getArgBool(m map[string]any, k string) bool {
    if m == nil { return false }
    if v, ok := m[k]; ok {
        switch t := v.(type) {
        case bool: return t
        case float64: return t != 0
        case string: return t == "true" || t == "1"
        }
    }
    return false
}
func getArgInt(m map[string]any, k string, d int) int { if m == nil { return d }; if v, ok := m[k]; ok { if i, ok2 := toInt(v); ok2 { return i } }; return d }
func toInt(v any) (int, bool) {
    switch t := v.(type) {
    case float64: return int(t), true
    case int: return t, true
    case int32: return int(t), true
    case int64: return int(t), true
    case string: var i int; _, err := fmt.Sscanf(t, "%d", &i); return i, err == nil
    default: return 0, false
    }
}
func getArgIntSlice(m map[string]any, k string) []int {
    res := []int{}
    if m == nil { return res }
    if v, ok := m[k]; ok {
        if arr, ok2 := v.([]any); ok2 {
            for _, el := range arr { if i, ok := toInt(el); ok { res = append(res, i) } }
        }
    }
    return res
}

