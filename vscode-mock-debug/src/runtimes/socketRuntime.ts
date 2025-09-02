import { FileAccessor } from '../mockRuntime';
import { IRuntime } from './types';
import { RuntimeBase } from './baseRuntime';

export class SocketRuntimeProxy extends RuntimeBase implements IRuntime {
  private socket?: import('net').Socket;
  private buffer = '';

  constructor(fileAccessor: FileAccessor) { super(fileAccessor); }

  private ensureSocket() { if (!this.socket) { throw new Error('Socket not connected'); } }

  private onData = (data: Buffer) => {
    this.buffer += data.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) { continue; }
      this.onLine(line);
    }
  };

  protected writeRaw(line: string): void { this.ensureSocket(); this.socket!.write(line); }

  async attach(host: string, port: number, stopOnAttach?: boolean): Promise<void> {
    const net = await import('net');
    this.socket = new net.Socket();
    await new Promise<void>((resolve, reject) => { this.socket!.once('error', reject); this.socket!.connect(port, host, () => { this.socket!.off('error', reject); resolve(); }); });
    this.socket.on('data', this.onData);
    this.socket.on('close', () => this.emit('end'));
    this.sourceLines = [];
    await this.send('initialize');
    const args: any = { stopOnAttach: !!stopOnAttach };
    const b = await this.send('attach', args);
    const program: string = b.program;
    if (program) {
      args.program = program;
      this.sourceFile = program;
      // preload source text for stack/targets/disassembly context
      try { const bytes = await this.fileAccessor.readFile(program); this.sourceLines = new TextDecoder().decode(bytes).split(/\r?\n/); } catch { this.sourceLines = []; }
    }
  }

  disconnect(): void { try { void this.send('disconnect'); } catch { } try { this.socket?.destroy(); } catch { } }
  async start(): Promise<void> { throw new Error('SocketRuntimeProxy does not support start()'); }
}
