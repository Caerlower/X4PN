/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_IP?: string;
  readonly VITE_X402_API_URL?: string;
  readonly VITE_SESSION_MINUTES?: string;
  readonly VITE_ALGOD_SERVER?: string;
  readonly VITE_ALGOD_PORT?: string;
  readonly VITE_ALGOD_TOKEN?: string;
  readonly VITE_ALGOD_NETWORK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.svg' {
  const src: string;
  export default src;
}

declare module 'process' {
  const process: NodeJS.Process;
  export default process;
}
