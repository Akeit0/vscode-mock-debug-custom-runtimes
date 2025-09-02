namespace MockRuntime;

public interface IMockDebugger
{
    // Stop reasons
    void OnStopOnEntry(int line, int? column = null);
    void OnStopOnStep(int line, int? column = null);
    void OnStopOnBreakpoint(int line, int? column = null);
    void OnStopOnDataBreakpoint(int line, int? column = null);
    void OnStopOnInstructionBreakpoint(int line, int? column = null);
    void OnStopOnException(int line, string? exception = null, int? column = null);
    void OnStopOnPause(int line, int? column = null);

    // Breakpoint lifecycle
    void OnBreakpointValidated(int id, int line, bool verified);

    // Diagnostic output associated with a source location (0-based line/column)
    void OnOutput(string category, string text, string file, int line, int column);

    // Program ended
    void OnEnd();
}
