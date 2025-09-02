using System.Text.Json;
using MockRuntime.Protocols;

namespace MockRuntime.Cli;

public static class CliHost
{
    static readonly JsonSerializerOptions json = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };

    public static async Task RunDispatcherAsync(RuntimeEngine engine, JsonDebugger debugger, TextReader input, TextWriter output, bool writeLineToConsole = false)
    {
        while (await input.ReadLineAsync() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                if (writeLineToConsole) Console.WriteLine("-> " + line);

                var req = JsonSerializer.Deserialize<Request>(line, json);
                if (req is null || !string.Equals(req.Type, "request", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                switch (req.Command)
                {
                    case "initialize":
                        Respond(output, Protocol.Ok(req.Id, new { capabilities = new { } }));
                        break;

                    case "attach":
                    {
                        var stopOnAttach = GetArg<bool?>(req.Args, "stopOnAttach") ?? false;
                        Respond(output, Protocol.Ok(req.Id, new { program = engine.SourceFile }));
                        if (stopOnAttach) engine.Pause();
                        break;
                    }

                    case "launch":
                    {
                        var program = GetArg<string>(req.Args, "program") ?? string.Empty;
                        var stopOnEntry = GetArg<bool?>(req.Args, "stopOnEntry") ?? false;
                        await engine.LoadSourceAsync(program);
                        Respond(output, Protocol.Ok(req.Id));
                        if (stopOnEntry) debugger!.OnStopOnEntry(0);
                        else await engine.ContinueAsync();
                        break;
                    }

                    case "setBreakpoints":
                    {
                        var path = GetArg<string>(req.Args, "path") ?? string.Empty;
                        var lines = GetArg<JsonElement?>(req.Args, "lines");
                        var list = new List<int>();
                        if (lines is { ValueKind: JsonValueKind.Array })
                        {
                            foreach (var e in lines.Value.EnumerateArray())
                                if (e.TryGetInt32(out var l))
                                    list.Add(l);
                        }

                        var results = engine.SetBreakpoints(path, list);
                        var body = new { breakpoints = results.Select(r => new Breakpoint(r.id, r.line, r.verified)).ToArray() };
                        Respond(output, Protocol.Ok(req.Id, body));
                        break;
                    }

                    case "continue":
                    {
                        var reverse = GetArg<bool?>(req.Args, "reverse") ?? false;
                        Respond(output, Protocol.Ok(req.Id));
                        await engine.ContinueAsync(reverse);
                        break;
                    }

                    case "disconnect":
                        Respond(output, Protocol.Ok(req.Id));
                        return;

                    case "pause":
                        Respond(output, Protocol.Ok(req.Id));
                        engine.Pause();
                        break;

                    case "next":
                    {
                        var reverse = GetArg<bool?>(req.Args, "reverse") ?? false;
                        Respond(output, Protocol.Ok(req.Id));
                        engine.Next(reverse);
                        break;
                    }

                    case "stepIn":
                    {
                        var targetId = GetArg<int?>(req.Args, "targetId");
                        Respond(output, Protocol.Ok(req.Id));
                        engine.StepIn(targetId);
                        break;
                    }

                    case "stepOut":
                        Respond(output, Protocol.Ok(req.Id));
                        engine.StepOut();
                        break;

                    case "stackTrace":
                    {
                        var start = GetArg<int?>(req.Args, "startFrame") ?? 0;
                        var levels = GetArg<int?>(req.Args, "levels") ?? 1000;
                        var (frames, count) = engine.BuildStack(start, start + levels);
                        Respond(output, Protocol.Ok(req.Id, new { stackFrames = frames, totalFrames = count }));
                        break;
                    }

                    case "breakpointLocations":
                    {
                        var path = GetArg<string>(req.Args, "path") ?? string.Empty;
                        var lineNum = GetArg<int?>(req.Args, "line") ?? 0;
                        var cols = engine.GetBreakpointColumns(path, lineNum);
                        Respond(output, Protocol.Ok(req.Id, new { breakpoints = cols.Select(c => new { column = c }).ToArray() }));
                        break;
                    }
                    case "breakpointLines":
                    {
                        var path = GetArg<string>(req.Args, "path") ?? string.Empty;
                        var lines = Enumerable.Range(0, engine.SourceLength).Where(i => !string.IsNullOrWhiteSpace(engine.GetLineSafe(i))).ToArray();
                        Respond(output, Protocol.Ok(req.Id, new { lines }));
                        break;
                    }

                    case "disassemble":
                    {
                        var address = GetArg<int?>(req.Args, "address") ?? 0;
                        var instructionCount = GetArg<int?>(req.Args, "instructionCount") ?? 32;
                        var list = engine.Disassemble(address, instructionCount);
                        Respond(output, Protocol.Ok(req.Id, new { instructions = list }));
                        break;
                    }

                    case "getLocalVariables":
                    {
                        var vars = engine.GetLocalVariables();
                        Respond(output, Protocol.Ok(req.Id, new { variables = vars }));
                        break;
                    }

                    case "getLocalVariable":
                    {
                        var name = GetArg<string>(req.Args, "name") ?? string.Empty;
                        var v = engine.GetLocalVariable(name);
                        Respond(output, Protocol.Ok(req.Id, new { variable = v }));
                        break;
                    }

                    case "setVariable":
                    {
                        var name = GetArg<string>(req.Args, "name") ?? string.Empty;
                        if (req.Args != null && req.Args.TryGetValue("value", out var val)) engine.SetVariable(name, val);
                        Respond(output, Protocol.Ok(req.Id));
                        break;
                    }

                    case "getGlobalVariables":
                    {
                        var vars = engine.GetGlobalVariables();
                        Respond(output, Protocol.Ok(req.Id, new { variables = vars }));
                        break;
                    }

                    case "setExceptionBreakpoints":
                    {
                        var named = GetArg<string>(req.Args, "namedException");
                        var others = GetArg<bool?>(req.Args, "otherExceptions") ?? false;
                        engine.SetExceptionsFilters(named, others);
                        Respond(output, Protocol.Ok(req.Id));
                        break;
                    }

                    case "setDataBreakpoint":
                    {
                        var address = GetArg<string>(req.Args, "address") ?? string.Empty;
                        var access = GetArg<string>(req.Args, "accessType") ?? "write";
                        var ok = engine.SetDataBreakpoint(address, access);
                        Respond(output, Protocol.Ok(req.Id, new { verified = ok }));
                        break;
                    }

                    case "clearAllDataBreakpoints":
                        engine.ClearAllDataBreakpoints();
                        Respond(output, Protocol.Ok(req.Id));
                        break;

                    case "setInstructionBreakpoint":
                    {
                        var address = GetArg<int?>(req.Args, "address") ?? -1;
                        var ok = engine.SetInstructionBreakpoint(address);
                        Respond(output, Protocol.Ok(req.Id, new { verified = ok }));
                        break;
                    }

                    case "clearInstructionBreakpoints":
                        engine.ClearInstructionBreakpoints();
                        Respond(output, Protocol.Ok(req.Id));
                        break;

                    default:
                        Respond(output, Protocol.Fail(req.Id, $"unknown command: {req.Command}"));
                        break;
                }
            }
            catch (Exception ex)
            {
                Respond(output, new Response("response", -1, false, null, ex.Message));
            }
        }
    }


    static void Respond(TextWriter writer, Response res)
    {
        writer.WriteLine(JsonSerializer.Serialize(res, json));
        writer.Flush();
    }

    static T? GetArg<T>(Dictionary<string, object?>? args, string name)
    {
        if (args == null) return default;
        if (!args.TryGetValue(name, out var val) || val is null) return default;
        try
        {
            if (val is JsonElement je) return je.Deserialize<T>();
            return (T?)Convert.ChangeType(val, typeof(T));
        }
        catch
        {
            return default;
        }
    }
}