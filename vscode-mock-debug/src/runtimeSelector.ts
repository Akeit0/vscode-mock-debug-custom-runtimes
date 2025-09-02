import { FileAccessor, MockRuntime } from './mockRuntime';
import { IRuntime, RuntimeLaunchOptions } from './runtimes/types';
import { StdioRuntimeProxy } from './runtimes/stdioRuntime';
import { SocketRuntimeProxy } from './runtimes/socketRuntime';

export function createRuntime(fileAccessor: FileAccessor, options?: RuntimeLaunchOptions): IRuntime {
  if (options?.runtimeExe) {
    return new StdioRuntimeProxy(fileAccessor, options);
  }
  return new MockRuntime(fileAccessor);
}


export function createSocketRuntime(fileAccessor: FileAccessor): IRuntime {
  return new SocketRuntimeProxy(fileAccessor);
}

export type RuntimeLike = IRuntime;
