package engine

import (
    "bufio"
    "path/filepath"
    "regexp"
    "strings"
)

type Debugger interface {
    OnStopOnEntry(line int, column *int)
    OnStopOnStep(line int, column *int)
    OnStopOnBreakpoint(line int, column *int)
    OnStopOnException(line int, exception *string, column *int)
    OnStopOnDataBreakpoint(line int, column *int)
    OnStopOnInstructionBreakpoint(line int, column *int)
    OnStopOnPause(line int, column *int)
    OnBreakpointValidated(id int, verified bool)
    OnOutput(category, text, file string, line, column int)
    OnEnd()
}

type Breakpoint struct {
    ID       int
    Line     int
    Verified bool
}

type Word struct {
    Name  string
    Line  int
    Index int
}

type Engine struct {
    dbg Debugger

    sourceFile  string
    sourceLines []string

    currentLine  int
    currentCol   *int
    instruction  int
    instructions []Word
    starts       []int
    ends         []int

    nextBpID int
    bps      map[string][]Breakpoint

    namedException  *string
    otherExceptions bool

    dataBps   map[string]string
    instrBps  map[int]struct{}

    variables map[string]struct{}
    locals    map[string]any

    paused bool
}

func New(d Debugger) *Engine {
    return &Engine{
        dbg:        d,
        currentLine: 0,
        bps:        map[string][]Breakpoint{},
        dataBps:    map[string]string{},
        instrBps:   map[int]struct{}{},
        variables:  map[string]struct{}{},
        locals:     map[string]any{},
        nextBpID:   1,
    }
}

func (e *Engine) SourceFile() string { return e.sourceFile }
func (e *Engine) SourceLength() int { return len(e.sourceLines) }

func (e *Engine) LoadSource(path string, contents []byte) {
    e.sourceFile = abs(path)
    e.sourceLines = splitLines(string(contents))
    e.currentLine = 0
    e.currentCol = nil
    e.instructions = e.instructions[:0]
    e.starts = e.starts[:0]
    e.ends = e.ends[:0]
    for i, line := range e.sourceLines {
        _ = i
        e.starts = append(e.starts, len(e.instructions))
        words := getWords(i, line)
        e.instructions = append(e.instructions, words...)
        e.ends = append(e.ends, len(e.instructions))
    }
    if len(e.starts) > 0 {
        e.instruction = e.starts[0]
    } else { e.instruction = 0 }
}

func (e *Engine) Pause() {
    if e.paused {
        return
    }
    e.paused = true
    // if not running a loop, emit immediately
    e.dbg.OnOutput("stdout", strings.TrimSpace(e.getLine(e.currentLine)), e.sourceFile, e.currentLine, 0)
    e.dbg.OnStopOnPause(e.currentLine, e.currentCol)
}

func (e *Engine) Continue(reverse bool) {
    // normalize instruction at start/end of current line
    if e.currentLine >= 0 && e.currentLine < len(e.starts) {
        if reverse {
            end := e.ends[e.currentLine]
            if end > 0 { e.instruction = end-1 } else { e.instruction = 0 }
        } else {
            e.instruction = e.starts[e.currentLine]
        }
    }
    e.paused = false
    for {
        if e.paused {
            e.paused = false
            e.dbg.OnStopOnPause(e.currentLine, e.currentCol)
            return
        }
        if e.executeLine(e.currentLine, reverse) {
            return
        }
        if e.updateCurrentLine(reverse) {
            e.dbg.OnEnd()
            return
        }
        if e.findNextStatement(reverse) {
            return
        }
    }
}

func (e *Engine) Next(reverse bool) {
    if e.currentLine >= 0 && e.currentLine < len(e.starts) {
        if reverse {
            end := e.ends[e.currentLine]
            if end > 0 { e.instruction = end-1 } else { e.instruction = 0 }
        } else {
            e.instruction = e.starts[e.currentLine]
        }
    }
    if !e.executeLine(e.currentLine, reverse) {
        if !e.updateCurrentLine(reverse) {
            e.findNextStatement(reverse)
        }
        e.dbg.OnStopOnStep(e.currentLine, e.currentCol)
    }
}

func (e *Engine) StepIn(targetID *int) {
    if targetID != nil {
        e.currentCol = targetID
    } else {
        if e.currentCol != nil {
            v := *e.currentCol + 1
            e.currentCol = &v
        } else {
            v := 1
            e.currentCol = &v
        }
    }
    e.dbg.OnStopOnStep(e.currentLine, e.currentCol)
}

func (e *Engine) StepOut() {
    if e.currentCol != nil {
        v := *e.currentCol - 1
        if v <= 0 { e.currentCol = nil } else { e.currentCol = &v }
    }
    e.dbg.OnStopOnStep(e.currentLine, e.currentCol)
}

func (e *Engine) BuildStack(start, end int) (frames []map[string]any, count int) {
    line := e.getLine(e.currentLine)
    words := getWords(e.currentLine, line)
    words = append(words, Word{Name: "BOTTOM", Line: -1, Index: -1})
    column := 0
    if e.currentCol != nil { column = *e.currentCol }
    for i := start; i < min(end, len(words)); i++ {
        frames = append(frames, map[string]any{
            "id":    i,
            "name":  words[i].Name + "(" + itoa(i) + ")",
            "source": map[string]any{"name": basename(e.sourceFile), "path": e.sourceFile},
            "line":  e.currentLine,
            "column": column,
        })
    }
    return frames, len(words)
}

func (e *Engine) SetBreakpoints(path string, lines []int) (res []map[string]any) {
    p := abs(path)
    list := make([]Breakpoint, 0, len(lines))
    e.bps[p] = list
    for _, l := range lines {
        verified := e.verifyLine(p, l)
        bp := Breakpoint{ID: e.nextBpID, Line: l, Verified: verified}
        e.nextBpID++
        e.bps[p] = append(e.bps[p], bp)
        e.dbg.OnBreakpointValidated(bp.ID, verified)
        res = append(res, map[string]any{"id": bp.ID, "verified": verified, "line": l})
    }
    return
}

func (e *Engine) GetBreakpointColumns(_path string, line int) []int {
    cols := []int{}
    for _, w := range getWords(line, e.getLine(line)) {
        if len(w.Name) > 8 { cols = append(cols, w.Index) }
    }
    return cols
}

func (e *Engine) GetBreakpointLines() []int {
    var out []int
    for i := range e.sourceLines {
        if strings.TrimSpace(e.sourceLines[i]) != "" { out = append(out, i) }
    }
    return out
}

func (e *Engine) Disassemble(address, count int) []map[string]any {
    var list []map[string]any
    for a := address; a < address+count; a++ {
        if a >= 0 && a < len(e.instructions) {
            w := e.instructions[a]
            list = append(list, map[string]any{"address": a, "instruction": w.Name, "line": w.Line})
        } else {
            list = append(list, map[string]any{"address": a, "instruction": "nop"})
        }
    }
    return list
}

// Variables & breakpoints APIs
func (e *Engine) GetLocalVariables() []map[string]any {
    out := []map[string]any{}
    for k, v := range e.locals {
        out = append(out, map[string]any{"name": k, "value": v})
    }
    return out
}

func (e *Engine) GetLocalVariable(name string) map[string]any {
    if v, ok := e.locals[name]; ok { return map[string]any{"name": name, "value": v} }
    return nil
}

func (e *Engine) SetVariable(name string, value any) { e.locals[name] = value }

func (e *Engine) GetGlobalVariables() []map[string]any {
    out := []map[string]any{}
    for i := 0; i < 10; i++ { out = append(out, map[string]any{"name": "global_" + itoa(i), "value": i}) }
    return out
}

func (e *Engine) SetExceptionsFilters(named *string, others bool) {
    e.namedException = named
    e.otherExceptions = others
}

func (e *Engine) SetDataBreakpoint(address, access string) bool {
    if access == "readWrite" { access = "read write" }
    if cur, ok := e.dataBps[address]; ok {
        if cur != access { e.dataBps[address] = "read write" }
    } else { e.dataBps[address] = access }
    return true
}
func (e *Engine) ClearAllDataBreakpoints() { e.dataBps = map[string]string{} }

func (e *Engine) SetInstructionBreakpoint(addr int) bool { e.instrBps[addr] = struct{}{}; return true }
func (e *Engine) ClearInstructionBreakpoints() { e.instrBps = map[int]struct{}{} }

// helpers
func (e *Engine) verifyLine(_path string, line int) bool {
    if line < 0 || line >= len(e.sourceLines) { return false }
    return strings.TrimSpace(e.sourceLines[line]) != ""
}

func (e *Engine) getLine(line int) string {
    if line < 0 || line >= len(e.sourceLines) { return "" }
    return e.sourceLines[line]
}

func (e *Engine) updateCurrentLine(reverse bool) bool {
    if reverse {
        if e.currentLine > 0 { e.currentLine-- } else { e.currentLine = 0; e.currentCol = nil; e.dbg.OnStopOnEntry(e.currentLine, e.currentCol); return true }
    } else {
        if e.currentLine < len(e.sourceLines)-1 { e.currentLine++ } else { e.currentCol = nil; return true }
    }
    return false
}

func (e *Engine) findNextStatement(reverse bool) bool {
    for ln := e.currentLine; ; {
        // line bp
        if list, ok := e.bps[e.sourceFile]; ok {
            for _, bp := range list {
                if bp.Line == ln {
                    if !bp.Verified { bp.Verified = true; e.dbg.OnBreakpointValidated(bp.ID, true) }
                    e.currentLine = ln
                    e.dbg.OnStopOnBreakpoint(e.currentLine, e.currentCol)
                    return true
                }
            }
        }
        // instr bp at line start/end
        addr := 0
        if reverse { addr = e.starts[ln] } else { addr = e.ends[ln]-1 }
        if _, ok := e.instrBps[addr]; ok { e.currentLine = ln; e.dbg.OnStopOnInstructionBreakpoint(e.currentLine, e.currentCol); return true }

        line := strings.TrimSpace(e.getLine(ln))
        if line != "" { e.currentLine = ln; break }
        if reverse { if ln <= 0 { break }; ln-- } else { ln++; if ln >= len(e.sourceLines) { break } }
    }
    return false
}

var (
    wordRe   = regexp.MustCompile(`[a-zA-Z]+`)
    rwVarRe  = regexp.MustCompile(`\$([a-zA-Z][a-zA-Z0-9]*)(=(false|true|[0-9]+(\.[0-9]+)?|\".*\"|\{.*\}))?`)
    logRe    = regexp.MustCompile(`(log|prio|out|err)\(([^\)]*)\)`)
    excName  = regexp.MustCompile(`exception\((.*)\)`)
    excToken = regexp.MustCompile(`\bexception\b`)
)

func (e *Engine) executeLine(ln int, reverse bool) bool {
    // instruction breakpoints first
    start := e.starts[ln]
    end := e.ends[ln]
    if reverse {
        for e.instruction >= start {
            e.instruction--
            if _, ok := e.instrBps[e.instruction]; ok { e.dbg.OnStopOnInstructionBreakpoint(ln, e.currentCol); return true }
        }
    } else {
        for e.instruction < end {
            e.instruction++
            if _, ok := e.instrBps[e.instruction]; ok { e.dbg.OnStopOnInstructionBreakpoint(ln, e.currentCol); return true }
        }
    }

    text := strings.TrimSpace(e.getLine(ln))

    // variable read/write; data breakpoints
    ms := rwVarRe.FindAllStringSubmatchIndex(text, -1)
    for _, idx := range ms {
        name := text[idx[2]:idx[3]]
        hasAssign := idx[4] >= 0
        var access *string
        if hasAssign {
            if _, ok := e.variables[name]; ok { s := "write"; access = &s }
            e.variables[name] = struct{}{}
            // capture value token if present; set locals loosely
            if idx[6] >= 0 {
                token := text[idx[6]:idx[7]]
                e.locals[name] = parseToken(token)
            }
        } else {
            if _, ok := e.variables[name]; ok { s := "read"; access = &s }
        }
        if access != nil {
            if flg, ok := e.dataBps[name]; ok && strings.Contains(flg, *access) {
                e.dbg.OnStopOnDataBreakpoint(ln, e.currentCol)
                return true
            }
        }
    }

    // outputs
    for _, m := range logRe.FindAllStringSubmatchIndex(text, -1) {
        if len(m) >= 6 {
            cat := text[m[2]:m[3]]
            payload := text[m[4]:m[5]]
            e.dbg.OnOutput(cat, payload, e.sourceFile, ln, m[0])
        }
    }

    // exceptions
    if m := excName.FindStringSubmatch(text); len(m) == 2 {
        ex := strings.TrimSpace(m[1])
        if e.namedException != nil && *e.namedException == ex { e.dbg.OnStopOnException(ln, &ex, e.currentCol); return true }
        if e.otherExceptions { e.dbg.OnStopOnException(ln, nil, e.currentCol); return true }
    } else {
        if excToken.MatchString(text) && e.otherExceptions { e.dbg.OnStopOnException(ln, nil, e.currentCol); return true }
    }

    return false
}

// utils
func splitLines(s string) []string {
    sc := bufio.NewScanner(strings.NewReader(s))
    lines := []string{}
    for sc.Scan() { lines = append(lines, sc.Text()) }
    // append last empty line? not needed for our semantics
    return lines
}

func getWords(l int, line string) []Word {
    out := []Word{}
    for _, m := range wordRe.FindAllStringSubmatchIndex(line, -1) {
        out = append(out, Word{Name: line[m[0]:m[1]], Line: l, Index: m[0]})
    }
    return out
}

func parseToken(t string) any {
    switch {
    case t == "true":
        return true
    case t == "false":
        return false
    case strings.HasPrefix(t, "\"") && strings.HasSuffix(t, "\""):
        return strings.Trim(t, "\"")
    case strings.HasPrefix(t, "{"):
        return []map[string]any{{"name": "fBool", "value": true}, {"name": "fInteger", "value": 123}, {"name": "fString", "value": "hello"}, {"name": "flazyInteger", "value": 321}}
    default:
        // try int/float
        // keep as string if parse not needed; adapter treats primitives loosely
        return t
    }
}

func abs(p string) string { a, _ := filepath.Abs(p); return a }
func basename(p string) string { return filepath.Base(p) }
func min(a, b int) int { if a < b { return a } ; return b }
func itoa(i int) string { return strconvItoa(i) }

// tiny itoa without importing strconv everywhere
func strconvItoa(i int) string {
    // simple base-10 conversion
    if i == 0 { return "0" }
    neg := false
    if i < 0 { neg = true; i = -i }
    var buf [20]byte
    bp := len(buf)
    for i > 0 { bp--; buf[bp] = byte('0' + (i % 10)); i /= 10 }
    if neg { bp--; buf[bp] = '-' }
    return string(buf[bp:])
}
