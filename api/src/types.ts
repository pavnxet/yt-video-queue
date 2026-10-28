export interface Env {
  // Secrets (set via `wrangler secret put` / dashboard / GitHub Actions secrets)
  TURSO_DB_URL: string;
  TURSO_DB_AUTH_TOKEN: string;
  BOOTSTRAP_SECRET: string;
  YOUTUBE_API_KEY?: string; // optional; required for playlist sync/duration lookup

  // Public vars (see wrangler.toml [vars])
  RP_ID: string;
  RP_NAME: string;
  EXPECTED_ORIGIN: string; // may be a comma-separated list of allowed origins
  AUTH_MODE?: string;      // 'owner' (default) | 'multi'
}

export interface SessionUser {
  id: string;
  username: string;
  display_name: string | null;
}
