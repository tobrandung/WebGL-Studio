/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Set to `off` to build a studio that cannot publish. Export falls back to
   * the download and folder actions. Anything else (including unset) means the
   * /api endpoints of the studio Worker are expected to be reachable.
   */
  readonly VITE_ASSET_HOSTING?: 'off';
}
