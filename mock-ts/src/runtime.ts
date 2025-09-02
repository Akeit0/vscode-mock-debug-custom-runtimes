import { EventEmitter } from 'events';
import { promises as fs } from 'fs';

export interface FileAccessor {
  isWindows: boolean;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, contents: Uint8Array): Promise<void>;
}

export interface IRuntimeBreakpoint {
  id: number;
  line: number;
  verified: boolean;
}

interface IRuntimeStepInTargets {
  id: number;
  label: string;
}

interface IRuntimeStackFrame {
  index: number;
  name: string;
  file: string;
  line: number;
  column?: number;
  instruction?: number;
}

interface IRuntimeStack {
  count: number;
  frames: IRuntimeStackFrame[];
}

interface RuntimeDisassembledInstruction {
  address: number;
  instruction: string;
  line?: number;
}

export type IRuntimeVariableType = number | boolean | string | RuntimeVariable[];

export class RuntimeVariable {
  private _memory?: Uint8Array;
  public reference?: number;
  constructor(public readonly name: string, private _value: IRuntimeVariableType) {}

  public get value() { return this._value; }
  public set value(value: IRuntimeVariableType) {
    this._value = value;
    this._memory = undefined;
  }

  public get memory() {
    if (this._memory === undefined && typeof this._value === 'string') {
      this._memory = new TextEncoder().encode(this._value);
    }
    return this._memory;
  }

  public setMemory(data: Uint8Array, offset = 0) {
    const memory = this.memory;
    if (!memory) return;
    memory.set(data, offset);
    this._memory = memory;
    this._value = new TextDecoder().decode(memory);
  }
}

interface Word { name: string; line: number; index: number; }

export function timeout(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

export class MockRuntime extends EventEmitter {
  private _sourceFile = '';
  public get sourceFile() { return this._sourceFile; }

  private variables = new Map<string, RuntimeVariable>();
  private sourceLines: string[] = [];
  private instructions: Word[] = [];
  private starts: number[] = [];
  private ends: number[] = [];

  private _currentLine = 0;
  private get currentLine() { return this._currentLine; }
  private set currentLine(x: number) { this._currentLine = x; this.instruction = this.starts[x] ?? 0; }
  private currentColumn: number | undefined;
  public instruction = 0;

  private breakPoints = new Map<string, IRuntimeBreakpoint[]>();
  private instructionBreakpoints = new Set<number>();
  private breakpointId = 1;
  private breakAddresses = new Map<string, string>();
  private namedException: string | undefined;
  private otherExceptions = false;

  constructor(private fileAccessor: FileAccessor) { super(); }

  public async start(program: string, stopOnEntry: boolean, debug: boolean): Promise<void> {
    await this.loadSource(this.normalizePathAndCasing(program));
    if (debug) {
      await this.verifyBreakpoints(this._sourceFile);
      if (stopOnEntry) {
        // Align with C# CLI: stop immediately at entry (line 0)
        this.sendEvent('stopOnEntry', this.currentLine, this.currentColumn);
        return;
      }
    }
    this.continue(false);
  }

  public continue(reverse: boolean) {
    while (!this.executeLine(this.currentLine, reverse)) {
      if (this.updateCurrentLine(reverse)) break;
      if (this.findNextStatement(reverse)) break;
    }
  }

  public pause() {
    this.sendEvent('stopOnPause', this.currentLine, this.currentColumn);
  }

  public step(instruction: boolean, reverse: boolean) {
    if (instruction) {
      this.instruction += reverse ? -1 : 1;
      this.sendEvent('stopOnStep', this.currentLine, this.currentColumn);
    } else {
      if (!this.executeLine(this.currentLine, reverse)) {
        if (!this.updateCurrentLine(reverse)) {
          this.findNextStatement(reverse, 'stopOnStep');
        }
      }
    }
  }

  public stepIn(targetId: number | undefined) {
    if (typeof targetId === 'number') {
      this.currentColumn = targetId; this.sendEvent('stopOnStep', this.currentLine, this.currentColumn);
    } else {
      if (typeof this.currentColumn === 'number') {
        if (this.currentColumn <= this.sourceLines[this.currentLine].length) this.currentColumn += 1;
      } else { this.currentColumn = 1; }
      this.sendEvent('stopOnStep', this.currentLine, this.currentColumn);
    }
  }

  public stepOut() {
    if (typeof this.currentColumn === 'number') {
      this.currentColumn -= 1; if (this.currentColumn === 0) this.currentColumn = undefined;
    }
    this.sendEvent('stopOnStep', this.currentLine, this.currentColumn);
  }

  public getStepInTargets(frameId: number): IRuntimeStepInTargets[] {
    const line = this.getLine();
    const words = this.getWords(this.currentLine, line);
    if (frameId < 0 || frameId >= words.length) return [];
    const { index, name } = words[frameId];
    return name.split('').map((c, ix) => ({ id: index + ix, label: `target: ${c}` }));
  }

  public stack(startFrame: number, endFrame: number): IRuntimeStack {
    const line = this.getLine();
    const words = this.getWords(this.currentLine, line);
    words.push({ name: 'BOTTOM', line: -1, index: -1 });
    const instruction = line.indexOf('disassembly') >= 0 ? this.instruction : undefined;
    const column = typeof this.currentColumn === 'number' ? this.currentColumn : undefined;
    const frames: IRuntimeStackFrame[] = [];
    for (let i = startFrame; i < Math.min(endFrame, words.length); i++) {
      frames.push({ index: i, name: `${words[i].name}(${i})`, file: this._sourceFile, line: this.currentLine, column, instruction: instruction ? instruction + i : 0 });
    }
    return { frames, count: words.length };
  }

  public getBreakpoints(path: string, line: number): number[] {
    return this.getWords(line, this.getLine(line)).filter(w => w.name.length > 8).map(w => w.index);
  }

  public async setBreakPoint(path: string, line: number): Promise<IRuntimeBreakpoint> {
    path = this.normalizePathAndCasing(path);
    const bp: IRuntimeBreakpoint = { verified: false, line, id: this.breakpointId++ };
    let bps = this.breakPoints.get(path);
    if (!bps) { bps = []; this.breakPoints.set(path, bps); }
    bps.push(bp);
    await this.verifyBreakpoints(path);
    return bp;
  }

  public clearBreakPoint(path: string, line: number): IRuntimeBreakpoint | undefined {
    const bps = this.breakPoints.get(this.normalizePathAndCasing(path));
    if (bps) {
      const index = bps.findIndex(bp => bp.line === line);
      if (index >= 0) { const bp = bps[index]; bps.splice(index, 1); return bp; }
    }
    return undefined;
  }

  public clearBreakpoints(path: string): void { this.breakPoints.delete(this.normalizePathAndCasing(path)); }

  public setDataBreakpoint(address: string, accessType: 'read' | 'write' | 'readWrite'): boolean {
    const x = accessType === 'readWrite' ? 'read write' : accessType;
    const t = this.breakAddresses.get(address);
    if (t) { if (t !== x) this.breakAddresses.set(address, 'read write'); }
    else { this.breakAddresses.set(address, x); }
    return true;
  }

  public clearAllDataBreakpoints(): void { this.breakAddresses.clear(); }

  public setExceptionsFilters(namedException: string | undefined, otherExceptions: boolean): void { this.namedException = namedException; this.otherExceptions = otherExceptions; }

  public setInstructionBreakpoint(address: number): boolean { this.instructionBreakpoints.add(address); return true; }
  public clearInstructionBreakpoints(): void { this.instructionBreakpoints.clear(); }

  public async getGlobalVariables(cancellationToken?: () => boolean): Promise<RuntimeVariable[]> {
    const a: RuntimeVariable[] = [];
    for (let i = 0; i < 10; i++) {
      a.push(new RuntimeVariable(`global_${i}`, i));
      if (cancellationToken && cancellationToken()) break;
      await timeout(1000);
    }
    return a;
  }

  public getLocalVariables(): RuntimeVariable[] { return Array.from(this.variables, ([, value]) => value); }
  public getLocalVariable(name: string): RuntimeVariable | undefined { return this.variables.get(name); }
  public setVariable(name: string, value: IRuntimeVariableType): void {
    const v = this.variables.get(name);
    if (v) v.value = value; else this.variables.set(name, new RuntimeVariable(name, value));
  }

  public disassemble(address: number, instructionCount: number): RuntimeDisassembledInstruction[] {
    const instructions: RuntimeDisassembledInstruction[] = [];
    for (let a = address; a < address + instructionCount; a++) {
      if (a >= 0 && a < this.instructions.length) {
        instructions.push({ address: a, instruction: this.instructions[a].name, line: this.instructions[a].line });
      } else { instructions.push({ address: a, instruction: 'nop' }); }
    }
    return instructions;
  }

  public getAllValidBreakpointLines(): number[] {
    const lines: number[] = [];
    for (let i = 0; i < this.sourceLines.length; i++) {
      if (this.getLine(i).length > 0) lines.push(i);
    }
    return lines;
  }

  private getLine(line?: number): string { return this.sourceLines[line === undefined ? this.currentLine : line]?.trim() ?? ''; }
  private getWords(l: number, line: string): Word[] {
    const WORD_REGEXP = /[a-z]+/ig; const words: Word[] = []; let match: RegExpExecArray | null;
    while (match = WORD_REGEXP.exec(line)) { words.push({ name: match[0], line: l, index: match.index }); }
    return words;
  }

  private async loadSource(file: string): Promise<void> {
    if (this._sourceFile !== file) {
      this._sourceFile = this.normalizePathAndCasing(file);
      this.initializeContents(await this.fileAccessor.readFile(file));
    }
  }

  private initializeContents(contents: Uint8Array) {
    const lines = new TextDecoder().decode(contents).split(/\r?\n/);
    this.sourceLines = lines;
    this.instructions = [];
    this.starts = [];
    this.ends = [];
    let pc = 0;
    for (let l = 0; l < lines.length; l++) {
      const line = lines[l].trim();
      this.starts.push(pc);
      const words = this.getWords(l, line);
      for (const w of words) { this.instructions.push(w); pc++; }
      this.ends.push(pc);
    }
    this._currentLine = 0;
    this.instruction = this.starts[0] ?? 0;
  }

  private findNextStatement(reverse: boolean, stepEvent?: string): boolean {
    for (let ln = this.currentLine; reverse ? ln >= 0 : ln < this.sourceLines.length; reverse ? ln-- : ln++) {
      const bps = this.breakPoints.get(this._sourceFile);
      if (bps) {
        const bp = bps.find(bp => bp.line === ln);
        if (bp) { this.currentLine = ln; if (!bp.verified) { bp.verified = true; this.sendEvent('breakpointValidated', bp); } this.sendEvent('stopOnBreakpoint', this.currentLine, this.currentColumn); return true; }
      }
      const ibp = this.instructionBreakpoints.has(reverse ? this.starts[ln] : this.ends[ln] - 1);
      if (ibp) { this.currentLine = ln; this.sendEvent('stopOnInstructionBreakpoint', this.currentLine, this.currentColumn); return true; }

      const line = this.getLine(ln);
      if (line.length > 0) { this.currentLine = ln; break; }
    }
    if (stepEvent) { this.sendEvent(stepEvent, this.currentLine, this.currentColumn); return true; }
    return false;
  }

  private executeLine(ln: number, reverse: boolean): boolean {
    while (reverse ? this.instruction >= this.starts[ln] : this.instruction < this.ends[ln]) {
      reverse ? this.instruction-- : this.instruction++;
      if (this.instructionBreakpoints.has(this.instruction)) { this.sendEvent('stopOnInstructionBreakpoint', this.currentLine, this.currentColumn); return true; }
    }
    const line = this.getLine(ln);
    let reg0 = /\$([a-z][a-z0-9]*)(=(false|true|[0-9]+(\.[0-9]+)?|\".*\"|\{.*\}))?/ig; let matches0: RegExpExecArray | null;
    while (matches0 = reg0.exec(line)) {
      if (matches0.length === 5) {
        let access: string | undefined;
        const name = matches0[1]; const value = matches0[3];
        let v = new RuntimeVariable(name, value);
        if (value && value.length > 0) {
          if (value === 'true') { v.value = true; }
          else if (value === 'false') { v.value = false; }
          else if (value[0] === '"') { v.value = value.slice(1, -1); }
          else if (value[0] === '{') {
            v.value = [ new RuntimeVariable('fBool', true), new RuntimeVariable('fInteger', 123), new RuntimeVariable('fString', 'hello'), new RuntimeVariable('flazyInteger', 321) ];
          } else { v.value = parseFloat(value); }
          if (this.variables.has(name)) { access = 'write'; }
          this.variables.set(name, v);
        } else { if (this.variables.has(name)) { access = 'read'; } }
        const accessType = this.breakAddresses.get(name);
        if (access && accessType && accessType.indexOf(access) >= 0) { this.sendEvent('stopOnDataBreakpoint', access, this.currentLine, this.currentColumn); return true; }
      }
    }
    const reg1 = /(log|prio|out|err)\(([^\)]*)\)/g; let matches1: RegExpExecArray | null;
    while (matches1 = reg1.exec(line)) { if (matches1.length === 3) this.sendEvent('output', matches1[1], matches1[2], this._sourceFile, ln, matches1.index); }
    const matches2 = /exception\((.*)\)/.exec(line);
    if (matches2 && matches2.length === 2) {
      const exception = matches2[1].trim();
      if (this.namedException === exception) { this.sendEvent('stopOnException', exception, this.currentLine, this.currentColumn); return true; }
      else { if (this.otherExceptions) { this.sendEvent('stopOnException', undefined, this.currentLine, this.currentColumn); return true; } }
    } else {
      if (line.indexOf('exception') >= 0) { if (this.otherExceptions) { this.sendEvent('stopOnException', undefined, this.currentLine, this.currentColumn); return true; } }
    }
    return false;
  }

  private async verifyBreakpoints(path: string): Promise<void> {
    const bps = this.breakPoints.get(path);
    if (!bps) return;
    await this.loadSource(path);
    bps.forEach(bp => {
      if (!bp.verified && bp.line >= 0 && bp.line < this.sourceLines.length) {
        const srcLine = this.sourceLines[bp.line];
        // C# CLI: only verify non-empty lines, do not move breakpoints up/down
        const ok = !!srcLine && srcLine.trim().length > 0;
        if (ok) {
          bp.verified = true;
        }
        this.sendEvent('breakpointValidated', { id: bp.id, verified: bp.verified, line: bp.line });
      }
    });
  }

  private updateCurrentLine(reverse: boolean): boolean {
    if (reverse) {
      if (this.currentLine > 0) this.currentLine--; else { this.currentLine = 0; this.currentColumn = undefined; this.sendEvent('stopOnEntry'); return true; }
    } else {
      if (this.currentLine < this.sourceLines.length - 1) this.currentLine++; else { this.currentColumn = undefined; this.sendEvent('end'); return true; }
    }
    return false;
  }

  private sendEvent(event: string, ...args: any[]): void { setTimeout(() => { this.emit(event, ...args); }, 0); }
  private normalizePathAndCasing(path: string) { return this.fileAccessor.isWindows ? path.replace(/\//g, '\\').toLowerCase() : path.replace(/\\/g, '/'); }
}

export const NodeFileAccessor: FileAccessor = {
  isWindows: process.platform === 'win32',
  async readFile(path: string) { return new Uint8Array(await fs.readFile(path)); },
  async writeFile(path: string, contents: Uint8Array) { await fs.writeFile(path, contents); }
};
