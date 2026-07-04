declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
};

declare module "node:fs/promises" {
  export function access(path: string, mode?: number): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function writeFile(path: string, data: string): Promise<void>;
}

declare module "node:fs" {
  export const constants: {
    X_OK: number;
  };
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:child_process" {
  type ChildProcess = {
    stdout: { on(event: "data", listener: (chunk: { toString(): string }) => void): void };
    stderr: { on(event: "data", listener: (chunk: { toString(): string }) => void): void };
    stdin: { end(data: string): void };
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "close", listener: (code: number | null) => void): void;
  };

  export function spawn(command: string, args: string[], options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  }): ChildProcess;
}
