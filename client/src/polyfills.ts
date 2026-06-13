import process from 'process';
import { Buffer } from 'buffer';

type GlobalPolyfills = typeof globalThis & {
  process: typeof process;
  Buffer: typeof Buffer;
};

const g = globalThis as GlobalPolyfills;
g.process = process;
g.Buffer = Buffer;
