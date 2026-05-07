import type { BackupsApi } from '../electron/preload';

declare global {
  interface Window {
    backupsApp: BackupsApi;
  }
}

export {};
