interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_TERMS_URL?: string;
  readonly VITE_PRIVACY_URL?: string;
  /** Map tiles for the live arrival map (D83), with {z}, {x} and {y}; OpenStreetMap when unset. */
  readonly VITE_MAP_TILE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
