/**
 * CLI version identity, sent with every outbound request.
 *
 * Lives in its own module (not client.ts) because config.ts and upload.ts
 * need it too, and client.ts already imports config.ts — importing the other
 * way would create a cycle.
 *
 * Why the server cares: when the Supabase JWT/API-key rotation lands, the BFF
 * can use these headers to detect CLIs that still ship the legacy anon key
 * and answer with an upgrade-required error instead of failing cryptically.
 */
import pkg from '../package.json' with { type: 'json' };

export const CLI_VERSION = (pkg as { version: string }).version ?? '0.0.0';

export const CLI_USER_AGENT = `quickdesign-cli/${CLI_VERSION} node/${process.versions.node}`;

/**
 * Default identification headers. `X-QuickDesign-CLI-Version` duplicates the
 * version because intermediate proxies sometimes rewrite User-Agent.
 */
export function versionHeaders(): Record<string, string> {
  return {
    'User-Agent': CLI_USER_AGENT,
    'X-QuickDesign-CLI-Version': CLI_VERSION,
  };
}
