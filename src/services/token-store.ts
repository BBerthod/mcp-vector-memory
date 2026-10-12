import crypto from 'crypto';
import type { AuthToken } from '../config.js';

export interface TokenStore {
  getTokenInfo(token: string): AuthToken | null;
  getProjectsForToken(token: string): string[];
}

interface TokenEntry {
  hash: Buffer;
  info: AuthToken;
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function validateEntry(index: number, value: unknown): AuthToken {
  // Never include the token itself in an error message: only its position.
  const where = `auth.tokens entry #${index + 1}`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${where}: expected an object with name and projects`);
  }
  const { name, projects, role } = value as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`Invalid ${where}: 'name' must be a non-empty string`);
  }
  if (!Array.isArray(projects) || !projects.every((p) => typeof p === 'string')) {
    throw new Error(`Invalid ${where} ('${name}'): 'projects' must be an array of strings`);
  }
  if (role !== undefined && role !== 'admin') {
    throw new Error(`Invalid ${where} ('${name}'): 'role' must be 'admin' when set`);
  }
  return role === 'admin' ? { name, projects: [...projects], role } : { name, projects: [...projects] };
}

/**
 * Build a token store from the raw `auth.tokens` mapping (token -> entry).
 * Entries are validated once; lookups compare fixed-length SHA-256 digests with
 * timingSafeEqual over ALL entries, so no inherited prototype key can match and
 * the time taken does not reveal how much of a token is correct.
 */
export function createTokenStore(rawTokens: unknown): TokenStore {
  if (rawTokens === null || typeof rawTokens !== 'object' || Array.isArray(rawTokens)) {
    throw new Error('Invalid auth.tokens: expected a mapping of token to { name, projects }');
  }

  const entries: TokenEntry[] = Object.entries(rawTokens).map(([token, value], index) => ({
    hash: sha256(token),
    info: validateEntry(index, value),
  }));

  function getTokenInfo(token: string): AuthToken | null {
    if (typeof token !== 'string') return null;
    const candidate = sha256(token);
    let found: AuthToken | null = null;
    for (const entry of entries) {
      if (crypto.timingSafeEqual(candidate, entry.hash)) {
        found = entry.info;
      }
    }
    return found;
  }

  return {
    getTokenInfo,
    getProjectsForToken(token: string): string[] {
      return getTokenInfo(token)?.projects ?? [];
    },
  };
}
