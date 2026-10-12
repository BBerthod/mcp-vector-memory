/**
 * Deterministic stand-in for OllamaService.
 *
 * Reminder: the default dimension is read from process.env.VECTOR_SIZE when a
 * FakeOllama is constructed (fallback 1024). Set it to the same value as the
 * one used for `src/services/qdrant.ts` (which reads it at module load), before
 * the dynamic imports.
 */
import crypto from 'node:crypto';

export class FakeOllama {
  /** Texts received by embed / embedBatch, in call order. */
  calls: string[] = [];
  private readonly dim: number;
  private readonly forced = new Map<string, number[]>();

  constructor(dim: number = parseInt(process.env.VECTOR_SIZE || '1024', 10)) {
    this.dim = dim;
  }

  /** Force the vector returned for an exact text (not normalized by us). */
  setVector(text: string, vector: number[]): void {
    this.forced.set(text, vector);
  }

  private vectorFor(text: string): number[] {
    const forced = this.forced.get(text);
    if (forced) return forced;
    const v: number[] = [];
    for (let i = 0; v.length < this.dim; i++) {
      const digest = crypto.createHash('sha256').update(`${i}:${text}`).digest();
      for (let j = 0; j + 4 <= digest.length && v.length < this.dim; j += 4) {
        v.push(digest.readInt32BE(j) / 2 ** 31);
      }
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }

  async embed(text: string, _model?: string): Promise<number[]> {
    this.calls.push(text);
    return this.vectorFor(text);
  }

  async embedBatch(texts: string[], _model?: string): Promise<number[][]> {
    this.calls.push(...texts);
    return texts.map((t) => this.vectorFor(t));
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
