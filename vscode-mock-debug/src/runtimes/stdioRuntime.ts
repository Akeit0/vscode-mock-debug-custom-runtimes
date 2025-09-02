import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { FileAccessor } from '../mockRuntime';
import { RuntimeLaunchOptions } from './types';
import { RuntimeBase } from './baseRuntime';

export class StdioRuntimeProxy extends RuntimeBase {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';

  constructor(fileAccessor: FileAccessor, options: RuntimeLaunchOptions) { super(fileAccessor, options); }

  private ensureChild() {
    if (this.child) {return;}
    const optExe = this.options!.runtimeExe!;
    const optArgs = this.options!.runtimeArgs ?? [];
    const optCwd = this.options!.runtimeCwd;
    this.child = spawn(optExe, optArgs, { stdio: ['pipe', 'pipe', 'pipe'], cwd: optCwd || undefined });
    this.child.on('exit', () => this.emit('end'));
    this.child.stderr.on('data', (d: Buffer) => this.emit('output', 'err', d.toString('utf8'), this.sourceFile, 1, 1));
    this.child.stdout.on('data', (data: Buffer) => this.onStdout(data));
  }

  private onStdout(data: Buffer) {
    this.buffer += data.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) {continue;}
      this.onLine(line);
    }
  }

  protected writeRaw(line: string): void { this.ensureChild(); this.child!.stdin.write(line); }
}

