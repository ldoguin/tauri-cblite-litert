/**
 * Minimal type stub for @couchbase/lite-js.
 * Satisfies tsc during the Tauri build where the package may not be installed.
 * The real package is required for the web build target (pnpm dev:web / build:web).
 */
declare module "@couchbase/lite-js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Database: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Replicator: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function DocID(id: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function NewBlob(data: Uint8Array, contentType: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const LastWriteWins: any;
}
