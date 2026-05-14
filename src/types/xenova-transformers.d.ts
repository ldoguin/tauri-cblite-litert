/**
 * Minimal ambient type declarations for @xenova/transformers.
 * The package ships JS only with no bundled .d.ts files.
 */
declare module "@xenova/transformers" {
  export const env: {
    allowLocalModels: boolean;
    useBrowserCache: boolean;
  };

  type TranscriberFn = (
    audio: Float32Array,
    opts: {
      sampling_rate: number;
      chunk_length_s: number;
      stride_length_s: number;
      language: string;
      task: string;
    },
  ) => Promise<{ text: string } | Array<{ text: string }>>;

  export function pipeline(
    task: string,
    model: string,
    options?: {
      progress_callback?: (p: {
        status: string;
        progress?: number;
        file?: string;
      }) => void;
    },
  ): Promise<TranscriberFn>;
}
