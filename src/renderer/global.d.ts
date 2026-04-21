import type { ShimejiApi } from "../shared/shimeji-api";

declare global {
  interface Window {
    readonly shimeji: ShimejiApi;
  }
}

export {};
