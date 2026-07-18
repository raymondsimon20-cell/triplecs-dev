/**
 * Schwab OAuth2 authorization-code flow.
 *
 * HARD CONSTRAINT: Schwab OAuth + API require HTTPS end-to-end, including
 * local dev tunnels. A plain-HTTP redirect URI breaks the callback.
 */
import { storage, KEYS } from '@/lib/storage';
import type { SchwabTokens } from './types';

const AUTH_BASE = 'https://api.schwabapi.com/v1/oauth';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export function assertHttpsRedirect(): void {
  const uri = env('SCHWAB_REDIRECT_URI');
  if (!uri.startsWith('https://')) {
    throw new Error(
      'SCHWAB_REDIRECT_URI must be HTTPS — Schwab OAuth breaks on plain HTTP, including local dev. Use an https tunnel.'
    );
  }
}

/** Build the authorize URL with a CSRF state param (caller stores state in a cookie). */
export function buildAuthorizeUrl(state: string): string {
  assertHttpsRedirect();
  const params = new URLSearchParams({
    client_id: env('SCHWAB_CLIENT_ID'),
    redirect_uri: env('SCHWAB_REDIRECT_URI'),
    response_type: 'code',
    state,
  });
  return `${AUTH_BASE}/authorize?${params}`;
}

function basicAuthHeader(): string {
  const creds = `${env('SCHWAB_CLIENT_ID')}:${env('SCHWAB_CLIENT_SECRET')}`;
  return `Basic ${Buffer.from(creds).toString('base64')}`;
}

async function tokenRequest(body: URLSearchParams): Promise<SchwabTokens> {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Schwab token request failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };
  const tokens: SchwabTokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type,
    scope: json.scope,
    expires_at: Date.now() + (json.expires_in - 60) * 1000,
  };
  await storage.set(KEYS.tokens, tokens);
  return tokens;
}

/** Exchange authorization code for tokens (callback handler). */
export async function exchangeCode(code: string): Promise<SchwabTokens> {
  assertHttpsRedirect();
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env('SCHWAB_REDIRECT_URI'),
    })
  );
}

/** Get a valid access token, refreshing if expired. */
export async function getAccessToken(): Promise<string> {
  const tokens = await storage.get<SchwabTokens>(KEYS.tokens);
  if (!tokens) throw new Error('Not authenticated with Schwab — visit /api/auth/login');
  if (Date.now() < tokens.expires_at) return tokens.access_token;
  const refreshed = await tokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    })
  );
  return refreshed.access_token;
}

export async function logout(): Promise<void> {
  await storage.delete(KEYS.tokens);
}
