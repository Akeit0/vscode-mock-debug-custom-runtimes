import { EventEmitter } from 'events';
import { FileAccessor, RuntimeVariable } from '../mockRuntime';

export interface IRuntime extends EventEmitter {
  // properties used by the adapter
  sourceFile: string;
  instruction: number;

  // lifecycle
  start(program: string, stopOnEntry: boolean, debug: boolean): Promise<void>;
  continue(reverse: boolean): void;
  attach?(host: string, port: number, stopOnAttach?: boolean): Promise<void>;
  pause?(): void;
  disconnect?(): void;

  // breakpoints
  setBreakPoint(path: string, line: number): Promise<{ id: number; line: number; verified: boolean }>;
  clearBreakPoint(path: string, line: number): { id: number; line: number; verified: boolean } | undefined;
  clearBreakpoints(path: string): void;
  getBreakpoints(path: string, line: number): number[];
  setDataBreakpoint(address: string, accessType: 'read' | 'write' | 'readWrite'): boolean;
  clearAllDataBreakpoints(): void;
  setInstructionBreakpoint(address: number): boolean;
  clearInstructionBreakpoints(): void;
  setExceptionsFilters(namedException: string | undefined, otherExceptions: boolean): void;

  // execution & stack
  step(instruction: boolean, reverse: boolean): void;
  stepIn(targetId: number | undefined): void;
  stepOut(): void;
  getStepInTargets(frameId: number): { id: number; label: string }[];
  stack(startFrame: number, endFrame: number): { count: number; frames: any[] };
  disassemble(address: number, instructionCount: number): { address: number; instruction: string; line?: number }[];

  // variables
  getLocalVariables(): RuntimeVariable[];
  getLocalVariable(name: string): RuntimeVariable | undefined;
  getGlobalVariables(cancellationToken?: () => boolean): Promise<RuntimeVariable[]>;
  setLocalVariable?(name: string, value: any): void;
}

export interface RuntimeLaunchOptions {
  runtimeExe?: string;
  runtimeArgs?: string[];
  runtimeCwd?: string;
}

export type RuntimeLike = IRuntime;

export { FileAccessor };
