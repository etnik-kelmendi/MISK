interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_TERMS_URL?: string;
  readonly VITE_PRIVACY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
