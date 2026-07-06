/**
 * Minimal type stub for @couchbase/lite-js.
 * The real package is installed only for the web build target.
 * This stub satisfies tsc during the Tauri build where the package is absent.
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
}
