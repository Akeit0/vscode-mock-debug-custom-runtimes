using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MockRuntime;

public sealed partial class RuntimeEngine(IMockDebugger? debugger = null)
{
    string sourceFile = string.Empty;
    string[] sourceLines = Array.Empty<string>();
    int currentLine; // zero-based
    int? currentColumn; // 0-based when set

    readonly Dictionary<string, List<Breakpoint>> bps = new(StringComparer.OrdinalIgnoreCase);
    int nextBpId = 1;

    // Instruction stream and per-line ranges
    readonly List<Word> instructions = new();
    readonly List<int> starts = new();
    readonly List<int> ends = new();
    int instruction;
    volatile bool paused;

    // Data/instruction breakpoints and exception filters
    readonly HashSet<int> instructionBreakpoints = new();
    readonly Dictionary<string, string> breakAddresses = new(StringComparer.OrdinalIgnoreCase);
    string? namedException;
    bool otherExceptions;

    // Simple variable tracking for read/write detection
    readonly HashSet<string> variables = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, object?> locals = new(StringComparer.OrdinalIgnoreCase);
    IMockDebugger? debugger = debugger;
    
    public IMockDebugger? Debugger
    {
        get => debugger;
        set => debugger = value;
    }
    
    readonly record struct Breakpoint(int Id, int Line, bool Verified);

    public string SourceFile => sourceFile;
    public int SourceLength => sourceLines.Length;

    public async Task LoadSourceAsync(string path)
    {
        sourceFile = NormalizePath(path);
        sourceLines = await File.ReadAllLinesAsync(sourceFile, Encoding.UTF8);
        currentLine = 0;
        currentColumn = null;

        // rebuild instruction map
        instructions.Clear();
        starts.Clear();
        ends.Clear();
        for (int l = 0; l < sourceLines.Length; l++)
        {
            starts.Add(instructions.Count);
            foreach (var w in GetWords(l, sourceLines[l]))
            {
                instructions.Add(w);
            }
            ends.Add(instructions.Count);
        }
        instruction = starts.Count > 0 ? starts[0] : 0;

        // Now that a source is loaded, re-verify any pending breakpoints for this file
        ReverifyBreakpointsForCurrentSource();
    }

    static string NormalizePath(string p) => Path.GetFullPath(p);

    bool VerifyLine(string path, int line)
    {
        // If no source is loaded yet, we cannot verify; treat as unverified.
        if (sourceLines.Length == 0) return false;
        var idx = Math.Clamp(line, 0, sourceLines.Length - 1);
        return !string.IsNullOrWhiteSpace(sourceLines[idx]);
    }

    public Task ContinueAsync(bool reverse = false)
    {
        // normalize instruction pointer at line start/end for the chosen direction
        if (currentLine >= 0 && currentLine < starts.Count)
        {
            instruction = reverse
                ? Math.Max(0, (ends.ElementAtOrDefault(currentLine) > 0 ? ends[currentLine] - 1 : 0))
                : starts[currentLine];
        }
        paused = false;
        while (true)
        {
            // If ExecuteLine triggers a stop event (exception/instruction/data), just return.
            if (ExecuteLine(currentLine, reverse))
            {
                return Task.CompletedTask;
            }
            // If UpdateCurrentLine signals end/start, emit end and return.
            if (UpdateCurrentLine(reverse))
            {
                debugger?.OnEnd();
                return Task.CompletedTask;
            }
            // Move to next non-empty or breakpoint line.
            if (FindNextStatement(reverse, out var reason))
            {
                if (reason == "breakpoint")
                {
                    debugger?.OnStopOnBreakpoint(currentLine, currentColumn);
                }
                return Task.CompletedTask;
            }
        }
    }



    bool ExecuteLine(int line, bool reverse = false)
    {
        // process instruction breakpoints first
        var endForLine = (line >= 0 && line < ends.Count) ? ends[line] : 0;
        var startForLine = (line >= 0 && line < starts.Count) ? starts[line] : 0;
        if (reverse)
        {
            while (instruction >= startForLine)
            {
                instruction--; // pre-decrement like TS runtime
                if (instructionBreakpoints.Contains(instruction))
                {
                    debugger?.OnStopOnInstructionBreakpoint(line, currentColumn);
                    return true;
                }
            }
        }
        else
        {

            while (instruction < endForLine)
            {
                instruction++;
                if (instructionBreakpoints.Contains(instruction))
                {
                    
                    // Ensure an output event for the breakpoint line so the adapter can position correctly
                    debugger?.OnStopOnInstructionBreakpoint(line, currentColumn);
                    return true;
                }
            }
        }

        var text = GetLine(line).Trim();
        // variable read/write detection: $name or $name=...
        foreach (Match m in VariableReadWriteRegex().Matches(text))
        {
            if (m.Groups.Count >= 2)
            {
                string? access = null;
                var name = m.Groups[1].Value;
                var hasAssign = m.Groups.Count >= 3 && m.Groups[2].Success;

                if (hasAssign)
                {
                    if (variables.Contains(name)) access = "write";
                    variables.Add(name);

                    var valToken = m.Groups.Count >= 4 ? m.Groups[3].Value : null;
                    if (!string.IsNullOrEmpty(valToken))
                    {
                        object? parsed = null;
                        if (string.Equals(valToken, "true", StringComparison.OrdinalIgnoreCase)) parsed = true;
                        else if (string.Equals(valToken, "false", StringComparison.OrdinalIgnoreCase)) parsed = false;
                        else if (valToken.StartsWith('\"') && valToken.EndsWith('\"')) parsed = valToken.Substring(1, valToken.Length - 2);
                        else if (valToken.StartsWith('{'))
                        {
                            parsed = new List<KeyValuePair<string, object?>>
                            {
                                new("fBool", true),
                                new("fInteger", 123),
                                new("fString", "hello"),
                                new("flazyInteger", 321),
                            };
                        }
                        else if (double.TryParse(valToken, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d)) parsed = d;
                        locals[name] = parsed;
                    }
                }
                else
                {
                    if (variables.Contains(name)) access = "read";
                }

                if (access != null && breakAddresses.TryGetValue(name, out var at) && at.Contains(access))
                {
                  
                    debugger?.OnStopOnDataBreakpoint(line, currentColumn);
                    return true;
                }
            }
        }

        // output events from log-like functions
        var reg1 = LogRegex();
        foreach (Match m in reg1.Matches(text))
        {
            if (m.Groups.Count == 3)
            {
                var cat = m.Groups[1].Value;
                var payload = m.Groups[2].Value;
                debugger?.OnOutput(cat, payload, sourceFile, line, m.Index);
            }
        }


        // After emitting outputs, check for exceptions so the adapter has last output line for positioning (like TS runtime)
        // named or other exceptions
        // Only match whole word 'exception' (case-insensitive) to avoid headers like 'Exceptions'.
        var namedEx = NamedExceptionRegex().Match(text);
        var hasExceptionToken = ExceptionRegex().IsMatch(text);

        if (namedEx.Success)
        {
            var ex = namedEx.Groups[1].Value.Trim();
            if (!string.IsNullOrEmpty(namedException) && string.Equals(namedException, ex, StringComparison.Ordinal))
            {
                debugger?.OnStopOnException(line, ex, currentColumn);
                return true;
            }
            else if (otherExceptions)
            {
                debugger?.OnStopOnException(line);
                return true;
            }
        }
        else if (hasExceptionToken && otherExceptions)
        {
            
            debugger?.OnStopOnException(line, null, currentColumn);
            return true;
        }

        // Do not stop here for source breakpoints; stepping moves via UpdateCurrentLine/FindNextStatement
        return false;
    }

    bool IsBreakpoint(int line)
    {
        // exact path match
        if (bps.TryGetValue(sourceFile, out var list))
        {
            return list.Any(bp => bp.Line == line);
        }
        // fallback filename match (handles path mismatches across environments)
        var name = Path.GetFileName(sourceFile);
        foreach (var kv in bps)
        {
            if (string.Equals(Path.GetFileName(kv.Key), name, StringComparison.OrdinalIgnoreCase))
            {
                return kv.Value.Any(bp => bp.Line == line);
            }
        }
        return false;
    }

    bool UpdateCurrentLine(bool reverse)
    {
        if (reverse)
        {
            if (currentLine > 0)
            {
                currentLine--;
                currentColumn = null;
                // set instruction to end of previous line
                if (currentLine >= 0 && currentLine < ends.Count)
                {
                    instruction = ends[currentLine] - 1;
                }
                return false;
            }
            else
            {
                currentLine = 0;
                currentColumn = null;
                debugger?.OnStopOnEntry(currentLine, currentColumn);
                return true;
            }
        }
        else
        {
            if (currentLine < sourceLines.Length - 1)
            {
                currentLine++;
                currentColumn = null;
                // set instruction to start of new line
                if (currentLine >= 0 && currentLine < starts.Count)
                {
                    instruction = starts[currentLine];
                }
                return false;
            }
            currentColumn = null;
            return true; // end
        }
    }

    bool FindNextStatement(bool reverse, out string reason)
    {
        reason = "breakpoint";
        if (reverse)
        {
            for (var ln = currentLine; ln >= 0; ln--)
            {
                if (IsBreakpoint(ln))
                {
                    currentLine = ln;
                    return true;
                }
                var line = GetLine(ln);
                if (!string.IsNullOrWhiteSpace(line))
                {
                    currentLine = ln;
                    break;
                }
            }
        }
        else
        {
            for (var ln = currentLine; ln < sourceLines.Length; ln++)
            {
                if (IsBreakpoint(ln))
                {
                    currentLine = ln;
                    return true;
                }
                var line = GetLine(ln);
                if (!string.IsNullOrWhiteSpace(line))
                {
                    currentLine = ln;
                    break;
                }
            }
        }
        return false;
    }

    public (IReadOnlyList<object> Frames, int Count) BuildStack(int startFrame, int endFrame)
    {
        var line = GetLine(currentLine);
        var words = GetWords(currentLine, line);
        words.Add(new Word("BOTTOM", -1, -1));

        var frames = new List<object>();
        for (int i = startFrame; i < Math.Min(endFrame, words.Count); i++)
        {
            frames.Add(new
            {
                id = i,
                name = $"{words[i].Name}({i})",
                source = new { name = Path.GetFileName(sourceFile), path = sourceFile },
                line = currentLine,
                column = currentColumn ?? 0
            });
        }
        return (frames, words.Count);
    }

    string GetLine(int? line = null)
    {
        var idx = Math.Clamp(line ?? currentLine, 0, sourceLines.Length - 1);
        return sourceLines[idx];
    }

    public string GetLineSafe(int line)
    {
        if (line < 0 || line >= sourceLines.Length) return string.Empty;
        return sourceLines[line];
    }

    static readonly Regex wordRegex = new("[a-z]+", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    static List<Word> GetWords(int l, string line)
    {
        var list = new List<Word>();
        foreach (Match m in wordRegex.Matches(line))
        {
            list.Add(new Word(m.Value, l, m.Index));
        }
        return list;
    }

    sealed record Word(string Name, int Line, int Index);

    public List<(int id, int line, bool verified)> SetBreakpoints(string path, IEnumerable<int> lines)
    {
        path = NormalizePath(path);
        var list = new List<Breakpoint>();
        bps[path] = list;
        var results = new List<(int id, int line, bool verified)>();
        foreach (var l in lines)
        {
            var verified = VerifyLine(path, l);
            var bp = new Breakpoint(nextBpId++, l, verified);
            list.Add(bp);
            results.Add((bp.Id, l, verified));
            debugger?.OnBreakpointValidated(bp .Id , l, verified);
        }
        return results;
    }

    void ReverifyBreakpointsForCurrentSource()
    {
        if (string.IsNullOrEmpty(sourceFile) || sourceLines.Length == 0) return;
        var currentName = Path.GetFileName(sourceFile);
        foreach (var kv in bps.ToArray())
        {
            var key = kv.Key;
            if (string.Equals(key, sourceFile, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(Path.GetFileName(key), currentName, StringComparison.OrdinalIgnoreCase))
            {
                var list = kv.Value;
                for (int i = 0; i < list.Count; i++)
                {
                    var bp = list[i];
                    var verified = VerifyLine(sourceFile, bp.Line);
                    if (bp.Verified != verified)
                    {
                        list[i] = bp with { Verified = verified };;
                        debugger?.OnBreakpointValidated( bp.Id, bp.Line, verified );
                    }
                }
                // ensure exact-key entry points to this list
                bps.TryAdd(sourceFile, list);
            }
        }
    }

    public void Next(bool reverse = false)
    {
        // normalize instruction pointer at line start/end for the chosen direction
        if (currentLine >= 0 && currentLine < starts.Count)
        {
            instruction = reverse
                ? Math.Max(0, (ends.ElementAtOrDefault(currentLine) > 0 ? ends[currentLine] - 1 : 0))
                : starts[currentLine];
        }
        if (!ExecuteLine(currentLine, reverse))
        {
            if (!UpdateCurrentLine(reverse))
            {
                FindNextStatement(reverse, out _);
            }
            // only send step event if we didn't stop due to exception/instruction/data breakpoint
            debugger?.OnStopOnStep(currentLine, currentColumn);
        }
    }

    // Local variables APIs
    public IEnumerable<object> GetLocalVariables()
    {
        foreach (var kv in locals)
        {
            yield return new { name = kv.Key, value = ToJsonValue(kv.Value) };
        }
    }

    public void Pause()
    {
        if (paused) return;
        paused = true;
        // immediate pause: echo line and emit stopped
        var echo = GetLine(currentLine).Trim();
        debugger?.OnOutput("stdout", echo, sourceFile, currentLine, 0);
        debugger?.OnStopOnPause(currentLine, currentColumn);
    }

    public object? GetLocalVariable(string name)
    {
        if (locals.TryGetValue(name, out var v))
        {
            
            return new { name, value = ToJsonValue(v) };
        }
        return null;
    }

    public void SetVariable(string name, object? value)
    {
        locals[name] = NormalizeInboundValue(value);
    }

    static object? ToJsonValue(object? v)
    {
        if (v is List<KeyValuePair<string, object?>> list)
        {
            return list.Select(p => new { name = p.Key, value = ToJsonValue(p.Value) }).ToArray();
        }
        return v;
    }

    static object? NormalizeInboundValue(object? v)
    {
        if (v is JsonElement je)
        {
            switch (je.ValueKind)
            {
                case JsonValueKind.Null: return null;
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.Number:
                    if (je.TryGetInt64(out var l)) return (double)l;
                    if (je.TryGetDouble(out var d)) return d;
                    return null;
                case JsonValueKind.String: return je.GetString();
                case JsonValueKind.Array:
                {
                    var list = new List<KeyValuePair<string, object?>>();
                    foreach (var item in je.EnumerateArray())
                    {
                        if (item.ValueKind == JsonValueKind.Object)
                        {
                            string? name = null;
                            object? val = null;
                            foreach (var prop in item.EnumerateObject())
                            {
                                if (prop.NameEquals("name")) name = prop.Value.GetString();
                                else if (prop.NameEquals("value")) val = NormalizeInboundValue(prop.Value);
                            }
                            if (name != null)
                            {
                                list.Add(new KeyValuePair<string, object?>(name, val));
                            }
                        }
                    }
                    return list;
                }
                default:
                    return null;
            }
        }
        return v;
    }

    public IEnumerable<object> GetGlobalVariables()
    {
        yield break;
    }

    // Step in: if target provided, set column to that; else move right by 1
    public void StepIn(int? targetId)
    {
        if (targetId.HasValue)
        {
            currentColumn = targetId.Value;
        }
        else
        {
            this.currentColumn = this.currentColumn is {} currentColumn 
                ? Math.Min((sourceLines[currentLine].Length), currentColumn + 1) 
                : 1;
        }
        debugger?.OnStopOnStep(currentLine);
    }

    // Step out: move left by 1; if reaches 0 unset column
    public void StepOut()
    {
        if (currentColumn.HasValue)
        {
            var next = currentColumn.Value - 1;
            currentColumn = next <= 0 ? null : next;
        }
        debugger?.OnStopOnStep(currentLine);
    }

    // Column breakpoint positions for a line: start index of words with name length > 8 (like TS)
    public List<int> GetBreakpointColumns(string path, int line)
    {
        // If no source loaded, return empty to avoid index errors
        if (sourceLines.Length == 0) return new List<int>();
        var words = GetWords(line, GetLine(line));
        return words.Where(w => w.Name.Length > 8).Select(w => w.Index).ToList();
    }

    // Disassemble: return list of words from global instruction stream
    public IEnumerable<object> Disassemble(int address, int instructionCount)
    {
        var list = new List<object>();
        for (int a = address; a < address + instructionCount; a++)
        {
            if (a >= 0 && a < instructions.Count)
            {
                var w = instructions[a];
                list.Add(new { address = a, instruction = w.Name, line = w.Line });
            }
            else
            {
                list.Add(new { address = a, instruction = "nop" });
            }
        }
        return list;
    }

    // Data breakpoints
    public bool SetDataBreakpoint(string address, string accessType)
    {
        if (string.IsNullOrWhiteSpace(address)) return false;
        var norm = accessType == "readWrite" ? "read write" : accessType;
        if (breakAddresses.TryGetValue(address, out var existing))
        {
            if (!existing.Contains(norm)) breakAddresses[address] = "read write";
        }
        else
        {
            breakAddresses[address] = norm;
        }
        return true;
    }

    public void ClearAllDataBreakpoints() => breakAddresses.Clear();

    // Instruction breakpoints
    public bool SetInstructionBreakpoint(int address) => instructionBreakpoints.Add(address);
    public void ClearInstructionBreakpoints() => instructionBreakpoints.Clear();

    // Exception filters
    public void SetExceptionsFilters(string? namedException, bool otherExceptions)
    {
        this.namedException = namedException;
        this.otherExceptions = otherExceptions;
    }

    [GeneratedRegex(@"\$([a-z][a-z0-9]*)(=(false|true|[0-9]+(\.[0-9]+)?|""[^""]*""|\{.*\}))?", RegexOptions.IgnoreCase, "ja-JP")]
    private static partial Regex VariableReadWriteRegex();
    [GeneratedRegex(@"(log|prio|out|err)\(([^)]*)\)")]
    private static partial Regex LogRegex();
    [GeneratedRegex("exception\\((.*)\\)", RegexOptions.IgnoreCase, "ja-JP")]
    private static partial Regex NamedExceptionRegex();
    [GeneratedRegex(@"\bexception\b", RegexOptions.IgnoreCase, "ja-JP")]
    private static partial Regex ExceptionRegex();
}
