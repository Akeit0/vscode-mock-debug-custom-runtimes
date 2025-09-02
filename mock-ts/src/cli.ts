import { createInterface } from 'readline';
import { createServer } from 'net';
import { MockRuntime, NodeFileAccessor, RuntimeVariable } from './runtime';

type Request = { type: 'request'; id: number; command: string; args?: Record<string, any> };
type Response = { type: 'response'; id: number; success: boolean; body?: any; message?: string };
type EventMsg = { type: 'event'; event: string; body?: any };

function ok(id: number, body?: any): Response { return { type: 'response', id, success: true, body }; }
function fail(id: number, message: string): Response { return { type: 'response', id, success: false, message }; }

function writeJson(writer: NodeJS.WritableStream, obj: any) {
  writer.write(JSON.stringify(obj) + '\n');
}

function mapRuntimeEvents(runtime: MockRuntime, write: (ev: EventMsg) => void) {
  runtime.on('stopOnEntry', (line?: number, column?: number) => write({ type: 'event', event: 'stopped', body: { reason: 'entry', line, column } }));
  runtime.on('stopOnStep', (line?: number, column?: number) => write({ type: 'event', event: 'stopped', body: { reason: 'step', line, column } }));
  runtime.on('stopOnBreakpoint', (line?: number, column?: number) => write({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', line, column } }));
  runtime.on('stopOnDataBreakpoint', (_access?: string, line?: number, column?: number) => write({ type: 'event', event: 'stopped', body: { reason: 'dataBreakpoint', line, column } }));
  runtime.on('stopOnInstructionBreakpoint', (line?: number, column?: number) => write({ type: 'event', event: 'stopped', body: { reason: 'instructionBreakpoint', line, column } }));
  runtime.on('stopOnException', (exception?: string, line?: number, column?: number) => write({ type: 'event', event: 'stopped', body: { reason: 'exception', exception, line, column } }));
  runtime.on('stopOnPause', (line?: number, column?: number) => write({ type: 'event', event: 'stopped', body: { reason: 'pause', line, column } }));
  runtime.on('breakpointValidated', (bp: any) => write({ type: 'event', event: 'breakpointValidated', body: { id: bp.id, verified: bp.verified } }));
  runtime.on('output', (category: string, text: string, file: string, line: number, column: number) => write({ type: 'event', event: 'output', body: { category, text, file, line, column } }));
  runtime.on('end', () => write({ type: 'event', event: 'terminated', body: {} }));
}

async function handleConnection(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, preload?: { program?: string; stopOnEntry?: boolean }) {
  const runtime = new MockRuntime(NodeFileAccessor);
  mapRuntimeEvents(runtime, ev => writeJson(output, ev));

  if (preload?.program) {
    await runtime.start(preload.program, preload.stopOnEntry ?? false, true);
  }

  const rl = createInterface({ input });
  rl.on('line', async (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      const req = msg as Request;
      if (!req || req.type !== 'request') return;

      switch (req.command) {
        case 'initialize': {
          writeJson(output, ok(req.id, { capabilities: {} }));
          break;
        }
        case 'attach': {
          const stopOnAttach = !!req.args?.stopOnAttach;
          writeJson(output, ok(req.id));
          if (stopOnAttach) runtime.pause();
          break;
        }
        case 'launch': {
          const program = (req.args?.program as string) || '';
          const stopOnEntry = !!req.args?.stopOnEntry;
          await runtime.start(program, stopOnEntry, true);
          writeJson(output, ok(req.id));
          break;
        }
        case 'setBreakpoints': {
          const path = (req.args?.path as string) || '';
          const lines: number[] = Array.isArray(req.args?.lines) ? req.args!.lines : [];
          // clear then re-add
          runtime.clearBreakpoints(path);
          const results: { id: number; verified: boolean; line: number }[] = [];
          for (const l of lines) {
            const bp = await runtime.setBreakPoint(path, l);
            results.push({ id: bp.id, verified: bp.verified, line: bp.line });
          }
          writeJson(output, ok(req.id, { breakpoints: results }));
          break;
        }
        case 'continue': {
          const reverse = !!req.args?.reverse;
          writeJson(output, ok(req.id));
          setImmediate(() => runtime.continue(reverse));
          break;
        }
        case 'disconnect': {
          writeJson(output, ok(req.id));
          rl.close();
          break;
        }
        case 'pause': {
          writeJson(output, ok(req.id));
          runtime.pause();
          break;
        }
        case 'next': {
          const reverse = !!req.args?.reverse;
          writeJson(output, ok(req.id));
          runtime.step(false, reverse);
          break;
        }
        case 'stepIn': {
          const targetId = typeof req.args?.targetId === 'number' ? req.args!.targetId : undefined;
          writeJson(output, ok(req.id));
          runtime.stepIn(targetId);
          break;
        }
        case 'stepOut': {
          writeJson(output, ok(req.id));
          runtime.stepOut();
          break;
        }
        case 'stackTrace': {
          const start = typeof req.args?.startFrame === 'number' ? req.args!.startFrame : 0;
          const levels = typeof req.args?.levels === 'number' ? req.args!.levels : 1000;
          const { frames, count } = runtime.stack(start, start + levels);
          const stackFrames = frames.map(f => ({ id: f.index, name: f.name, source: { name: f.file.split(/[\\/]/).pop(), path: f.file }, line: f.line, column: f.column ?? 0 }));
          writeJson(output, ok(req.id, { stackFrames, totalFrames: count }));
          break;
        }
        case 'breakpointLocations': {
          const path = (req.args?.path as string) || '';
          const lineNum = typeof req.args?.line === 'number' ? req.args!.line : 0;
          const cols = runtime.getBreakpoints(path, lineNum);
          writeJson(output, ok(req.id, { breakpoints: cols.map(c => ({ column: c })) }));
          break;
        }
        case 'breakpointLines': {
          const lines = runtime.getAllValidBreakpointLines();
          writeJson(output, ok(req.id, { lines }));
          break;
        }
        case 'disassemble': {
          const address = typeof req.args?.address === 'number' ? req.args!.address : 0;
          const instructionCount = typeof req.args?.instructionCount === 'number' ? req.args!.instructionCount : 32;
          const list = runtime.disassemble(address, instructionCount);
          writeJson(output, ok(req.id, { instructions: list }));
          break;
        }
        case 'getLocalVariables': {
          const vars = runtime.getLocalVariables();
          const variables = vars.map(v => ({ name: v.name, value: v.value }));
          writeJson(output, ok(req.id, { variables }));
          break;
        }
        case 'getLocalVariable': {
          const name = (req.args?.name as string) || '';
          const v = runtime.getLocalVariable(name);
          writeJson(output, ok(req.id, { variable: v ? { name: v.name, value: v.value } : undefined }));
          break;
        }
        case 'setVariable': {
          const name = (req.args?.name as string) || '';
          const value = req.args?.value as any;
          runtime.setVariable(name, value);
          writeJson(output, ok(req.id));
          break;
        }
        case 'getGlobalVariables': {
          // ignore cancellation token support on CLI path
          const vars = await runtime.getGlobalVariables();
          const variables = vars.map(v => ({ name: v.name, value: v.value }));
          writeJson(output, ok(req.id, { variables }));
          break;
        }
        case 'setExceptionBreakpoints': {
          const named = req.args?.namedException as string | undefined;
          const others = !!req.args?.otherExceptions;
          runtime.setExceptionsFilters(named, others);
          writeJson(output, ok(req.id));
          break;
        }
        case 'setDataBreakpoint': {
          const address = (req.args?.address as string) || '';
          const access = (req.args?.accessType as string) || 'write';
          const okb = runtime.setDataBreakpoint(address, access as any);
          writeJson(output, ok(req.id, { verified: okb }));
          break;
        }
        case 'clearAllDataBreakpoints': {
          runtime.clearAllDataBreakpoints();
          writeJson(output, ok(req.id));
          break;
        }
        case 'setInstructionBreakpoint': {
          const address = typeof req.args?.address === 'number' ? req.args!.address : -1;
          const okb = runtime.setInstructionBreakpoint(address);
          writeJson(output, ok(req.id, { verified: okb }));
          break;
        }
        case 'clearInstructionBreakpoints': {
          runtime.clearInstructionBreakpoints();
          writeJson(output, ok(req.id));
          break;
        }
        default: {
          writeJson(output, fail(req.id, `unknown command: ${req.command}`));
          break;
        }
      }
    } catch (e: any) {
      writeJson(output, { type: 'response', id: -1, success: false, message: e?.message || String(e) });
    }
  });
}

async function run() {
  const argv = process.argv.slice(2);
  const isServer = argv.includes('--server');
  if (isServer) {
    let host = '127.0.0.1';
    let port = 4711;
    const hix = argv.indexOf('--host'); if (hix >= 0 && argv[hix + 1]) host = argv[hix + 1];
    const pix = argv.indexOf('--port'); if (pix >= 0 && argv[pix + 1]) port = parseInt(argv[pix + 1], 10) || port;
    const stopOnEntry = argv.includes('--stop-on-entry');
    let program: string | undefined; const pix2 = argv.indexOf('--program'); if (pix2 >= 0 && argv[pix2 + 1]) program = argv[pix2 + 1];
    console.log(`Listening on ${host}:${port}...`);
    const server = createServer(async socket => {
      console.log('Client connected.');
      socket.setEncoding('utf8');
      await handleConnection(socket, socket, { program, stopOnEntry });
      socket.on('close', () => console.log('Client disconnected.'));
    });
    server.listen(port, host, () => console.log('Server started.'));
    return;
  }

  // default: stdio
  await handleConnection(process.stdin, process.stdout);
}

run().catch(err => {
  console.error(err?.stack || err);
  process.exit(1);
});

