/// <reference types="vite/client" />

/**
 * Public build-time configuration.
 *
 * Only `VITE_`-prefixed variables are inlined into the bundle, and only this one
 * is declared. Adding a provider key, encryption key, database URL or session
 * secret here would publish it to every browser that loads the app — see
 * frontend/.env.example.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
