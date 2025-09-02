using System.Net;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Text;
using MockRuntime;
using MockRuntime.Cli;

if (args.Contains("--server"))
{
    await RunServerAsync(args.ToList());
    return;
}

var debugger = new JsonDebugger(Console.Out);
var engine = new RuntimeEngine(debugger);
await CliHost.RunDispatcherAsync(engine, debugger, Console.In, Console.Out);

static async Task RunServerAsync(List<string> args)
{
    string host = "127.0.0.1";
    int port = 4711;
    string path = GetAbsolutePath("../../vscode-mock-debug-ex/sampleWorkspace/readme.md ");
    var iHost = args.IndexOf("--host");
    if (iHost >= 0 && iHost + 1 < args.Count) host = args[iHost + 1];
    var iPort = args.IndexOf("--port");
    if (iPort >= 0 && iPort + 1 < args.Count && int.TryParse(args[iPort + 1], out var p)) port = p;
    var iProg = args.IndexOf("--program");
    if (iProg >= 0 && iProg + 1 < args.Count) path = args[iProg + 1];
    var stopOnEntry = args.Contains("--stop-on-entry");

    if (!File.Exists(path))
    {
        Console.WriteLine($"Error: program file not found: {path}");
        return;
    }

    var engine = new RuntimeEngine();
    await engine.LoadSourceAsync(path);
    var listener = new TcpListener(IPAddress.Parse(host), port);

    listener.Start();
    while (true)
    {
        Console.WriteLine("Waiting for client connection...");
        using var client = await listener.AcceptTcpClientAsync();
        Console.WriteLine("Client connected.");
        await using var stream = client.GetStream();
        using var reader = new StreamReader(stream, Encoding.UTF8);
        await using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.AutoFlush = true;

        var debugger = new JsonDebugger(writer);
        engine.Debugger = debugger;
        if (stopOnEntry)
        {
            debugger.OnStopOnEntry(0);
        }
        else
        {
            await engine.ContinueAsync();
        }


        try
        {
            await CliHost.RunDispatcherAsync(engine, debugger, reader, writer, true);
        }
        catch (Exception ex)
        {
            Console.WriteLine("Error: " + ex.Message);
        }

        Console.WriteLine("Client disconnected.");
    }
}

static string GetAbsolutePath(string relativePath, [CallerFilePath] string callerFilePath = "")
{
    return Path.GetFullPath(Path.Combine(Path.GetDirectoryName(callerFilePath)!, relativePath));
}