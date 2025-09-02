import { EventEmitter } from 'events';
import { FileAccessor, RuntimeVariable } from '../mockRuntime';
import { IRuntime, RuntimeLaunchOptions } from './types';

export abstract class RuntimeBase extends EventEmitter implements IRuntime {
  protected readonly fileAccessor: FileAccessor;
  protected readonly options?: RuntimeLaunchOptions;

  // transport/request plumbing
  private reqId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  // source & caret state
  public sourceFile: string = '';
  public instruction: number = 0;
  protected sourceLines: string[] = [];
  protected currentLine: number = 0;
  protected currentColumn: number | undefined;
  protected lastOutputLine: number | undefined;

  // locals state
  protected locals = new Map<string, RuntimeVariable>();
  protected pendingLocalEdits = new Map<string, any>();
  protected localsFresh: boolean = false;

  // breakpoints cache (path -> lines)
  protected breakpoints = new Map<string, Set<number>>();

  // instruction index (built in start)
  protected instructions: { address: number; instruction: string; line?: number }[] = [];

  constructor(fileAccessor: FileAccessor, options?: RuntimeLaunchOptions) {
    super();
    this.fileAccessor = fileAccessor;
    this.options = options;
  }

  // --- transport helpers ---
  protected abstract writeRaw(line: string): void;
  protected onLine(jsonLine: string) {
    let msg: any;
    try { msg = JSON.parse(jsonLine); } catch { return; }
    if (msg.type === 'response' && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.success ? p.resolve(msg.body ?? {}) : p.reject(new Error(msg.message || 'error')); }
    } else if (msg.type === 'event') {
      void this.dispatchEvent(msg.event, msg.body || {});
    }
  }
  protected send(command: string, args?: any): Promise<any> {
    const id = this.reqId++;
    const payload = { type: 'request', id, command, args };
    this.writeRaw(JSON.stringify(payload) + '\n');
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  // --- event handling ---
  private async dispatchEvent(name: string, body: any) {
    switch (name) {
      case 'stopped': {
        const reason = body.reason as string | undefined;
        // refresh locals once so adapter reads fresh cache
        try {
          const b = await this.send('getLocalVariables');
          this.updateLocalsFromPayload(b);
          for (const [k, v] of this.pendingLocalEdits) { this.locals.set(k, new RuntimeVariable(k, v)); }
          this.localsFresh = true;
        } catch { this.localsFresh = false; }

        // prefer runtime-provided line/column if present
        if (typeof body.line === 'number') { this.currentLine = Number(body.line) || 0; }
        if (typeof body.column === 'number') { this.currentColumn = Number(body.column) || undefined; }
        // else try stack for precise position
        try {
          if (typeof body.line !== 'number') {
            const st = await this.send('stackTrace', { startFrame: 0, levels: 1 });
            const top = (st.stackFrames && Array.isArray(st.stackFrames) && st.stackFrames.length > 0) ? st.stackFrames[0] : undefined;
            if (top) {
              if (top.source && typeof top.source.path === 'string' && !this.sourceFile) { this.sourceFile = String(top.source.path); }
              if (typeof top.line === 'number') { this.currentLine = Number(top.line) || 0; }
              if (typeof top.column === 'number') { this.currentColumn = Number(top.column) || undefined; }
            }
          }
        } catch { /* ignore */ }

        if (reason === 'entry') { this.emit('stopOnEntry'); }
        else if (reason === 'breakpoint') { this.emit('stopOnBreakpoint'); }
        else if (reason === 'dataBreakpoint') { this.emit('stopOnDataBreakpoint'); }
        else if (reason === 'instructionBreakpoint') { this.emit('stopOnInstructionBreakpoint'); }
        else if (reason === 'step') { this.emit('stopOnStep'); }
        else if (reason === 'exception') {
          const ex = typeof body.exception === 'string' ? body.exception : undefined;
          ex ? this.emit('stopOnException', ex) : this.emit('stopOnException');
        } else if (reason === 'pause') {
          // Treat pause like a user-initiated stop; keep current line/column
          this.emit('stopOnStep');
        }
        break;
      }
      case 'breakpointValidated': {
        const { id, verified } = body || {};
        this.emit('breakpointValidated', { id: Number(id), verified: !!verified });
        break;
      }
      case 'variablesChanged': {
        void this.send('getLocalVariables').then((b) => { this.updateLocalsFromPayload(b); this.localsFresh = true; }).catch(() => { });
        this.emit('variablesChanged');
        break;
      }
      case 'output': {
        const { category = 'stdout', text = '', file = this.sourceFile, line = 0, column = 1 } = body;
        this.lastOutputLine = Number(line) || 0;
        const cat = String(category).toLowerCase();
        const kind = (cat === 'stderr' || cat === 'err') ? 'err'
          : (cat === 'stdout' || cat === 'out') ? 'out'
          : (cat === 'prio' || cat === 'important') ? 'prio'
          : 'log';
        if (!this.sourceFile && file) { this.sourceFile = String(file); }
        this.emit('output', kind, String(text), String(file), Number(line), Number(column));
        break;
      }
      case 'terminated': this.emit('end'); break;
      default: break;
    }
  }

  // --- utilities ---
  protected toTsValue(v: any): any {
    if (Array.isArray(v)) { return v.map((child: any) => new RuntimeVariable(String(child.name), this.toTsValue(child.value))); }
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {return v;}
    return String(v);
  }
  protected fromTsRuntime(v: any): any {
    if (v instanceof RuntimeVariable) { return this.fromTsRuntime((v as any).value); }
    if (Array.isArray(v)) { return v.map((child: any) => ({ name: String(child.name), value: this.fromTsRuntime(child.value) })); }
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {return v;}
    return v;
  }
  protected updateLocalsFromPayload(payload: any) {
    const arr = (payload.variables as any[] | undefined) || [];
    for (const item of arr) {
      const name = String(item.name);
      const val = this.toTsValue(item.value);
      this.locals.set(name, new RuntimeVariable(name, val));
    }
  }

  // --- IRuntime common impls ---
  async start(program: string, stopOnEntry: boolean, debug: boolean): Promise<void> {
    this.sourceFile = program;
    try { const bytes = await this.fileAccessor.readFile(program); this.sourceLines = new TextDecoder().decode(bytes).split(/\r?\n/); } catch { this.sourceLines = []; }
    // rebuild instruction map
    this.instructions = [];
    const WORD_REGEXP = /[a-z]+/ig;
    for (let l = 0; l < this.sourceLines.length; l++) {
      const line = this.sourceLines[l]; let m: RegExpExecArray | null;
      while ((m = WORD_REGEXP.exec(line))) { this.instructions.push({ address: this.instructions.length, instruction: m[0], line: l }); }
    }
    await this.send('initialize');
    await this.send('launch', { program, stopOnEntry: !!stopOnEntry });
    // initial locals refresh (best effort)
    void this.send('getLocalVariables').then((body) => { this.updateLocalsFromPayload(body); this.localsFresh = true; }).catch(() => { });
  }

  continue(reverse: boolean): void { this.localsFresh = false; void this.send('continue', { reverse }); }
  pause?(): void { void this.send('pause'); }
  disconnect?(): void { try { void this.send('disconnect'); } catch { } }

  async setBreakPoint(path: string, line: number) {
    let set = this.breakpoints.get(path); if (!set) { set = new Set<number>(); this.breakpoints.set(path, set); }
    set.add(line);
    const body = await this.send('setBreakpoints', { path, lines: Array.from(set.values()) });
    const match = (body.breakpoints as any[] | undefined)?.find((b: any) => Number(b.line) === line);
    const id = match?.id ?? Math.floor(Math.random() * 1e9);
    const verified = !!match?.verified;
    return { id, line, verified };
  }
  clearBreakPoint(path: string, line: number) { const set = this.breakpoints.get(path); if (set) { const existed = set.delete(line); void this.send('setBreakpoints', { path, lines: Array.from(set.values()) }); return existed ? { id: -1, line, verified: false } : undefined; } return undefined; }
  clearBreakpoints(path: string): void { this.breakpoints.set(path, new Set<number>()); void this.send('setBreakpoints', { path, lines: [] }); }
  async setBreakpointsBulk(path: string, lines: number[]): Promise<{ id: number; line: number; verified: boolean }[]> {
    this.breakpoints.set(path, new Set<number>(lines));
    const body = await this.send('setBreakpoints', { path, lines });
    const arr = (body.breakpoints as any[] | undefined) || [];
    return arr.map((b: any) => ({ id: Number(b.id), line: Number(b.line), verified: !!b.verified }));
  }
  getBreakpoints(path: string, line: number): number[] { const text = (this.sourceLines[line] || ''); const re = /[a-z]+/ig; const cols: number[] = []; let m: RegExpExecArray | null; while ((m = re.exec(text))) {if (m[0].length > 8) {cols.push(m.index);}} return cols; }
  setDataBreakpoint(address: string, accessType: 'read' | 'write' | 'readWrite'): boolean { try { void this.send('setDataBreakpoint', { address, accessType }); return true; } catch { return false; } }
  clearAllDataBreakpoints(): void { void this.send('clearAllDataBreakpoints'); }
  setInstructionBreakpoint(address: number): boolean { try { void this.send('setInstructionBreakpoint', { address }); return true; } catch { return false; } }
  clearInstructionBreakpoints(): void { void this.send('clearInstructionBreakpoints'); }
  setExceptionsFilters(namedException: string | undefined, otherExceptions: boolean): void { void this.send('setExceptionBreakpoints', { namedException, otherExceptions }); }

  step(instruction: boolean, reverse: boolean): void { this.localsFresh = false; void this.send('next', { reverse }); }
  stepIn(targetId: number | undefined): void {
    this.localsFresh = false;
    if (typeof targetId === 'number') { this.currentColumn = targetId; }
    else {
      const lineText = this.sourceLines[this.currentLine] || '';
      if (typeof this.currentColumn === 'number') { if (this.currentColumn <= lineText.length) { this.currentColumn = this.currentColumn + 1; } }
      else { this.currentColumn = 1; }
    }
    void this.send('stepIn', { targetId });
  }
  stepOut(): void { this.localsFresh = false; if (typeof this.currentColumn === 'number') { this.currentColumn = this.currentColumn - 1; if (this.currentColumn === 0) { this.currentColumn = undefined; } } void this.send('stepOut'); }
  getStepInTargets(frameId: number) {
    const lineIdx = Math.max(0, Math.min(this.currentLine, this.sourceLines.length - 1));
    const line = (this.sourceLines[lineIdx] || '').trim();
    const words: { name: string; line: number; index: number }[] = [];
    const WORD_REGEXP = /[a-z]+/ig; let match: RegExpExecArray | null; while ((match = WORD_REGEXP.exec(line))) {words.push({ name: match[0], line: lineIdx, index: match.index });}
    if (frameId < 0 || frameId >= words.length) {return [];}
    const w = words[frameId];
    return w.name.split('').map((c, ix) => ({ id: w.index + ix, label: `target: ${c}` }));
  }
  stack(startFrame: number, endFrame: number) {
    const idx = Math.max(0, Math.min(this.currentLine, this.sourceLines.length - 1));
    const line = (this.sourceLines[idx] || '').trim();
    const words: { name: string; line: number; index: number }[] = [];
    const WORD_REGEXP = /[a-z]+/ig; let match: RegExpExecArray | null; while ((match = WORD_REGEXP.exec(line))) {words.push({ name: match[0], line: idx, index: match.index });}
    words.push({ name: 'BOTTOM', line: -1, index: -1 });
    const column = typeof this.currentColumn === 'number' ? this.currentColumn : undefined;
    const frames: any[] = []; for (let i = startFrame; i < Math.min(endFrame, words.length); i++) {frames.push({ index: i, name: `${words[i].name}(${i})`, file: this.sourceFile, line: idx, column, instruction: 0 });}
    return { frames, count: words.length };
  }
  disassemble(address: number, instructionCount: number) {
    const out: { address: number; instruction: string; line?: number }[] = [];
    for (let a = address; a < address + instructionCount; a++) { if (a >= 0 && a < this.instructions.length) { out.push(this.instructions[a]); } else { out.push({ address: a, instruction: 'nop' }); } }
    return out;
  }
  getLocalVariables(): RuntimeVariable[] { if (!this.localsFresh) { void this.send('getLocalVariables').then((b) => { this.updateLocalsFromPayload(b); this.localsFresh = true; }).catch(() => { }); } return Array.from(this.locals.values()); }
  getLocalVariable(name: string): RuntimeVariable | undefined { return this.locals.get(name); }
  async getGlobalVariables(): Promise<RuntimeVariable[]> { try { const body = await this.send('getGlobalVariables'); const arr = (body.variables as any[] | undefined) || []; return arr.map((item: any) => new RuntimeVariable(String(item.name), this.toTsValue(item.value))); } catch { return []; } }
  setLocalVariable(name: string, value: any): void { const ev = this.fromTsRuntime(value); this.locals.set(name, new RuntimeVariable(name, value)); this.pendingLocalEdits.set(name, value); void this.send('setVariable', { name, value: ev }).then(() => { this.pendingLocalEdits.delete(name); }).catch(() => { }); }
}
