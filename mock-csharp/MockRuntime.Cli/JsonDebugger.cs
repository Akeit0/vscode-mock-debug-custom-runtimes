using System.Text.Json;
using MockRuntime.Protocols;

namespace MockRuntime.Cli;

public sealed class JsonDebugger(TextWriter? writer = null) : IMockDebugger
{
    readonly JsonSerializerOptions json = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };

    readonly TextWriter writer = writer ?? Console.Out;

    void Write(string @event, object? body)
    {
        writer.WriteLine(JsonSerializer.Serialize(new Event("event", @event, body ), json));
        writer.Flush();
    }

    void WriteStoppedEvent( StoppedEventBody? body)
    {
        writer.WriteLine(JsonSerializer.Serialize(new Event("event", @"stopped", body ), json));
        writer.Flush();
    }

    public void OnStopOnEntry(int line, int? column = null) =>WriteStoppedEvent( body : new( "entry", line, column ) );
    public void OnStopOnStep(int line, int? column = null) => WriteStoppedEvent( body: new("step", line, column));

    public void OnStopOnBreakpoint(int line, int? column = null) => WriteStoppedEvent( body : new( "breakpoint", line, column));
    public void OnStopOnDataBreakpoint(int line, int? column = null) => WriteStoppedEvent( body : new( "dataBreakpoint", line, column));
    public void OnStopOnInstructionBreakpoint(int line, int? column = null) => WriteStoppedEvent( body : new( "instructionBreakpoint", line, column ) );
    public void OnStopOnException(int line, string? exception = null, int? column = null) => WriteStoppedEvent( body : new StoppedWithExceptionEventBody( "exception", line, column ,exception) );
    public void OnStopOnPause(int line, int? column = null) => WriteStoppedEvent( body : new( "pause", line, column  ));

    public void OnBreakpointValidated(int id, int line, bool verified) => Write(@event : "breakpointValidated", body : new Breakpoint( id, line, verified));
    public void OnOutput(string category, string text, string file, int line, int column) => Write(@event : "output", body :new OutputEventBody("std", line, column ,category, text, file) );
    public void OnEnd() => Write(@event : "terminated", body :null);
}

