import type { ComejiApi } from "../shared/comeji-api";

declare global {
  interface Window {
    readonly comeji: ComejiApi;
  }
}

export {};
