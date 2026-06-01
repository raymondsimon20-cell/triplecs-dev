"use strict";
/**
 * Schwab OAuth 2.0 helpers
 * Docs: https://developer.schwab.com/products/trader-api--individual/details/documentation/Retail%20Trader%20API%20Production
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSchwabAuthUrl = getSchwabAuthUrl;
exports.exchangeCodeForTokens = exchangeCodeForTokens;
exports.refreshAccessToken = refreshAccessToken;
exports.isAccessTokenExpired = isAccessTokenExpired;
exports.isRefreshTokenExpired = isRefreshTokenExpired;
const SCHWAB_AUTH_BASE = 'https://api.schwabapi.com/v1/oauth';
function getSchwabAuthUrl(state) {
    // No explicit `scope` — Schwab's Retail Trader API is single-scope
    // (full account access). The previous `scope=readonly` was misleading:
    // Schwab ignores it today, but if they ever enforced scopes this app
    // would lose order-placement capability without warning.
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: process.env.SCHWAB_CLIENT_ID,
        redirect_uri: process.env.SCHWAB_REDIRECT_URI,
        state,
    });
    return `${SCHWAB_AUTH_BASE}/authorize?${params.toString()}`;
}
function getBasicAuthHeader() {
    const credentials = `${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`;
    return `Basic ${Buffer.from(credentials).toString('base64')}`;
}
async function exchangeCodeForTokens(code) {
    const response = await fetch(`${SCHWAB_AUTH_BASE}/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: getBasicAuthHeader(),
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: process.env.SCHWAB_REDIRECT_URI,
        }),
    });
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Schwab token exchange failed: ${response.status} ${error}`);
    }
    const tokens = await response.json();
    return {
        ...tokens,
        issued_at: Date.now(),
    };
}
async function refreshAccessToken(refreshToken) {
    const response = await fetch(`${SCHWAB_AUTH_BASE}/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: getBasicAuthHeader(),
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        }),
    });
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Schwab token refresh failed: ${response.status} ${error}`);
    }
    const tokens = await response.json();
    return {
        ...tokens,
        issued_at: Date.now(),
    };
}
function isAccessTokenExpired(tokens) {
    // Refresh 5 minutes before actual expiry
    const expiresAt = tokens.issued_at + (tokens.expires_in - 300) * 1000;
    return Date.now() >= expiresAt;
}
function isRefreshTokenExpired(tokens) {
    // Schwab refresh tokens last 7 days
    const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    return Date.now() >= tokens.issued_at + REFRESH_TOKEN_TTL_MS;
}
