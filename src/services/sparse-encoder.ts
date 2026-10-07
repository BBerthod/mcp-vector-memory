/**
 * Vocabulary-free BM25 sparse encoder using FNV-1a hashing.
 * Produces sparse vectors compatible with Qdrant's sparse vector support.
 */

export interface SparseVector {
  indices: number[];
  values: number[];
}

const BM25_K1 = 1.2;

/**
 * Split text into tokens: split camelCase/snake_case, lowercase,
 * keep original + parts, filter < 2 chars.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // Split on whitespace and punctuation
  const words = text.split(/[\s,;:{}()\[\]<>=!+\-*/&|^~?@#$%\\`'"]+/);

  for (const word of words) {
    if (word.length < 2) continue;
    const lower = word.toLowerCase();
    tokens.push(lower);

    // Split camelCase: "AuthService" → ["auth", "service"]
    const camelParts = word.replace(/([a-z])([A-Z])/g, '$1_$2').split('_');
    if (camelParts.length > 1) {
      for (const part of camelParts) {
        const p = part.toLowerCase();
        if (p.length >= 2 && p !== lower) {
          tokens.push(p);
        }
      }
    }

    // Split snake_case: already handled by the _ split above
  }

  return tokens;
}

/**
 * FNV-1a hash → 32-bit positive integer (vocabulary-free token index).
 */
export function tokenToIndex(token: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  // Ensure positive 32-bit integer
  return (hash >>> 0);
}

/**
 * Encode text as a BM25-saturated sparse vector.
 * TF saturation: (tf * (k1+1)) / (tf + k1)
 */
export function encodeSparse(text: string): SparseVector {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { indices: [], values: [] };

  // Compute term frequencies
  const tf = new Map<number, number>();
  for (const token of tokens) {
    const idx = tokenToIndex(token);
    tf.set(idx, (tf.get(idx) ?? 0) + 1);
  }

  // Apply BM25 saturation
  const indices: number[] = [];
  const values: number[] = [];
  for (const [idx, freq] of tf.entries()) {
    indices.push(idx);
    values.push((freq * (BM25_K1 + 1)) / (freq + BM25_K1));
  }

  return { indices, values };
}

/**
 * Encode a search query as a sparse vector (same as encodeSparse for short queries).
 */
export function encodeSparseQuery(text: string): SparseVector {
  return encodeSparse(text);
}
