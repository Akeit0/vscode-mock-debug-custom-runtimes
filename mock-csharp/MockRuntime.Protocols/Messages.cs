using System.Text.Json.Serialization;
// ReSharper disable NotAccessedPositionalProperty.Global

namespace MockRuntime.Protocols;

public record Request(
    string Type,
    int Id,
    string Command,
    Dictionary<string, object?>? Args
);

public record Response(
    string Type,
    int Id,
    bool Success,
    object? Body,
    string? Message = null
);

public record Event(
    string Type,
    [property: JsonPropertyName("event")] string Name,
    object? Body = null
);

public record StoppedEventBody(
    string Reason,
    int? Line,
    int? Column
);

public record StoppedWithExceptionEventBody(
    string Reason,
    int? Line,
    int? Column,
    string? Exception
) : StoppedEventBody(Reason, Line, Column);

public record OutputEventBody(
    string Reason,
    int Line,
    int Column,
    string Category,
    string Text,
    string File
);
public record Breakpoint(int Id, int Line, bool Verified);

public static class Protocol
{
    public static Response Ok(int id, object? body = null) => new("response", id, true, body, null);
    public static Response Fail(int id, string message) => new("response", id, false, null, message);
}