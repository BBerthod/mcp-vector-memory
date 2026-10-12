import { QdrantClient, Schemas } from '@qdrant/js-client-rest';
import type { SparseVector } from './sparse-encoder.js';

const COLLECTIONS = ['code', 'docs', 'memory'] as const;
type CollectionName = typeof COLLECTIONS[number];

const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '1024', 10);
const SCHEMA_VERSION = 2;

export interface SearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface PointData {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface HybridPointData {
  id: string;
  denseVector: number[];
  sparseVector?: SparseVector;
  payload: Record<string, unknown>;
}

export interface SearchOptions {
  filter?: Record<string, unknown>;
  threshold?: number;
  /** Minimum dense similarity applied to the dense prefetch only (never to the fused score). */
  denseThreshold?: number;
  limit?: number;
}

export class CollectionSchemaMismatchError extends Error {
  constructor(
    readonly collection: string,
    readonly foundDimension: number,
    readonly expectedDimension: number,
    readonly anonymousSchema: boolean,
  ) {
    super(
      `Collection '${collection}' has ${anonymousSchema ? 'an old anonymous-vector schema' : 'a different schema'} ` +
      `(vector dimension ${foundDimension}, expected ${expectedDimension}). ` +
      'Refusing to delete it. Take a snapshot, then migrate to a new collection and switch the alias.',
    );
    this.name = 'CollectionSchemaMismatchError';
  }
}

export class QdrantService {
  private client: QdrantClient;
  private readonly vectorSize: number;

  constructor(url: string, apiKey?: string, options: { vectorSize?: number; client?: QdrantClient } = {}) {
    this.vectorSize = options.vectorSize ?? VECTOR_SIZE;
    this.client = options.client ?? new QdrantClient({ url, apiKey, checkCompatibility: false });
    console.log(`[qdrant] Client initialized for ${url}`);
  }

  async initCollections(): Promise<void> {
    console.log('[qdrant] Initializing collections...');
    for (const name of COLLECTIONS) {
      await this.ensureCollection(name);
    }
    console.log('[qdrant] All collections initialized');
  }

  private async ensureCollection(name: CollectionName): Promise<void> {
    try {
      let info: Awaited<ReturnType<QdrantClient['getCollection']>> | null = null;
      try {
        info = await this.client.getCollection(name);
      } catch {
        // Collection doesn't exist, create it
      }

      if (info) {
        const vectors = info.config?.params?.vectors;
        if (vectors && typeof vectors === 'object' && 'size' in vectors) {
          // Old schema (anonymous vectors): never delete, a migration is required
          throw new CollectionSchemaMismatchError(name, Number(vectors.size), this.vectorSize, true);
        } else if (vectors && typeof vectors === 'object' && 'dense' in vectors) {
          const dense = (vectors as Record<string, unknown>).dense as Record<string, unknown> | undefined;
          if (dense && (dense.size as number) !== this.vectorSize) {
            throw new CollectionSchemaMismatchError(name, Number(dense.size), this.vectorSize, false);
          }
          console.log(`[qdrant] Collection '${name}' already exists with correct schema`);
          return;
        } else {
          console.log(`[qdrant] Collection '${name}' already exists`);
          return;
        }
      }

      await this.client.createCollection(name, {
        vectors: {
          dense: {
            size: this.vectorSize,
            distance: 'Cosine',
            hnsw_config: {
              m: 32,
              ef_construct: 128,
            },
            quantization_config: {
              scalar: {
                type: 'int8',
                quantile: 0.99,
                always_ram: true,
              },
            },
          },
        },
        sparse_vectors: {
          bm25: { modifier: 'idf' },
        },
      });
      console.log(`[qdrant] Created collection '${name}' with named vectors (dense: ${this.vectorSize}-dim + bm25 sparse)`);

      await this.createPayloadIndexes(name);
    } catch (error) {
      console.error(`[qdrant] Error ensuring collection '${name}':`, error);
      throw error;
    }
  }

  private async createPayloadIndexes(name: CollectionName): Promise<void> {
    const commonIndexes: Array<{ field: string; type: Schemas['PayloadFieldSchema'] }> = [
      { field: 'project', type: 'keyword' },
      { field: 'type', type: 'keyword' },
      { field: 'created_at', type: 'datetime' },
      { field: 'embedding_model', type: 'keyword' },
      { field: 'schema_version', type: 'integer' },
    ];

    const specificIndexes: Record<CollectionName, Array<{ field: string; type: Schemas['PayloadFieldSchema'] }>> = {
      code: [
        { field: 'language', type: 'keyword' },
        { field: 'file_path', type: 'keyword' },
        { field: 'commit_sha', type: 'keyword' },
        { field: 'content_hash', type: 'keyword' },
      ],
      docs: [],
      memory: [
        { field: 'tags', type: 'keyword' },
        { field: 'author', type: 'keyword' },
        { field: 'deleted_at', type: 'datetime' },
        { field: 'relevance_score', type: 'float' },
        { field: 'version', type: 'integer' },
        { field: 'content_hash', type: 'keyword' },
      ],
    };

    const allIndexes = [...commonIndexes, ...specificIndexes[name]];

    for (const index of allIndexes) {
      try {
        await this.client.createPayloadIndex(name, {
          field_name: index.field,
          field_schema: index.type,
        });
        console.log(`[qdrant] Created index '${index.field}' on '${name}'`);
      } catch {
        // Index might already exist
      }
    }
  }

  async search(collection: string, vector: number[], options: SearchOptions = {}): Promise<SearchResult[]> {
    const { filter, threshold = 0, limit = 10 } = options;

    try {
      const results = await this.client.query(collection, {
        query: vector,
        using: 'dense',
        limit,
        with_payload: true,
        ...(filter ? { filter: filter as Schemas['Filter'] } : {}),
        ...(threshold > 0 ? { score_threshold: threshold } : {}),
      });

      return results.points.map(point => ({
        id: String(point.id),
        score: point.score ?? 0,
        payload: (point.payload as Record<string, unknown>) ?? {},
      }));
    } catch (error) {
      console.error(`[qdrant] Search error in '${collection}':`, error);
      throw error;
    }
  }

  async hybridSearch(
    collection: string,
    denseVector: number[],
    sparseVector: SparseVector,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const { filter, limit = 10, denseThreshold = 0 } = options;

    try {
      const results = await this.client.query(collection, {
        prefetch: [
          {
            query: denseVector,
            using: 'dense',
            limit: limit * 2,
            ...(filter ? { filter: filter as Schemas['Filter'] } : {}),
            ...(denseThreshold > 0 ? { score_threshold: denseThreshold } : {}),
          },
          {
            query: sparseVector,
            using: 'bm25',
            limit: limit * 2,
            ...(filter ? { filter: filter as Schemas['Filter'] } : {}),
          },
        ],
        query: { fusion: 'rrf' },
        limit,
        with_payload: true,
      });

      return results.points.map(point => ({
        id: String(point.id),
        score: point.score ?? 0,
        payload: (point.payload as Record<string, unknown>) ?? {},
      }));
    } catch (error) {
      console.error(`[qdrant] Hybrid search error in '${collection}':`, error);
      throw error;
    }
  }

  async sparseSearch(
    collection: string,
    sparseVector: SparseVector,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const { filter, limit = 10 } = options;

    try {
      const results = await this.client.query(collection, {
        query: sparseVector,
        using: 'bm25',
        limit,
        with_payload: true,
        ...(filter ? { filter: filter as Schemas['Filter'] } : {}),
      });

      return results.points.map(point => ({
        id: String(point.id),
        score: point.score ?? 0,
        payload: (point.payload as Record<string, unknown>) ?? {},
      }));
    } catch (error) {
      console.error(`[qdrant] Sparse search error in '${collection}':`, error);
      throw error;
    }
  }

  async upsert(collection: string, points: PointData[]): Promise<void> {
    if (points.length === 0) return;

    try {
      await this.client.upsert(collection, {
        wait: true,
        points: points.map(p => ({
          id: p.id,
          vector: { dense: p.vector },
          payload: {
            ...p.payload,
            schema_version: SCHEMA_VERSION,
            created_at: p.payload.created_at ?? new Date().toISOString(),
          },
        })),
      });
      console.log(`[qdrant] Upserted ${points.length} points to '${collection}'`);
    } catch (error) {
      console.error(`[qdrant] Upsert error in '${collection}':`, error);
      throw error;
    }
  }

  async upsertHybrid(collection: string, points: HybridPointData[]): Promise<void> {
    if (points.length === 0) return;

    try {
      await this.client.upsert(collection, {
        wait: true,
        points: points.map(p => ({
          id: p.id,
          vector: {
            dense: p.denseVector,
            ...(p.sparseVector ? { bm25: p.sparseVector } : {}),
          },
          payload: {
            ...p.payload,
            schema_version: SCHEMA_VERSION,
            created_at: p.payload.created_at ?? new Date().toISOString(),
          },
        })),
      });
      console.log(`[qdrant] Upserted ${points.length} hybrid points to '${collection}'`);
    } catch (error) {
      console.error(`[qdrant] Hybrid upsert error in '${collection}':`, error);
      throw error;
    }
  }

  async setPayload(collection: string, id: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.client.setPayload(collection, { wait: true, payload, points: [id] });
    } catch (error) {
      console.error(`[qdrant] SetPayload error in '${collection}':`, error);
      throw error;
    }
  }

  async updateVectors(
    collection: string,
    id: string,
    vectors: { denseVector: number[]; sparseVector?: SparseVector },
  ): Promise<void> {
    try {
      await this.client.updateVectors(collection, {
        wait: true,
        points: [{
          id,
          vector: {
            dense: vectors.denseVector,
            ...(vectors.sparseVector ? { bm25: vectors.sparseVector } : {}),
          },
        }],
      });
    } catch (error) {
      console.error(`[qdrant] UpdateVectors error in '${collection}':`, error);
      throw error;
    }
  }

  async getById(collection: string, id: string): Promise<{ id: string; payload: Record<string, unknown> } | null> {
    try {
      const points = await this.client.retrieve(collection, {
        ids: [id],
        with_payload: true,
        with_vector: false,
      });

      if (points.length === 0) return null;

      return {
        id: String(points[0].id),
        payload: (points[0].payload as Record<string, unknown>) ?? {},
      };
    } catch (error) {
      console.error(`[qdrant] GetById error in '${collection}':`, error);
      throw error;
    }
  }

  async deleteById(collection: string, id: string): Promise<void> {
    try {
      await this.client.delete(collection, { wait: true, points: [id] });
    } catch (error) {
      console.error(`[qdrant] DeleteById error in '${collection}':`, error);
      throw error;
    }
  }

  async deleteByFilter(collection: string, filter: Record<string, unknown>): Promise<void> {
    try {
      await this.client.delete(collection, {
        wait: true,
        filter: filter as Schemas['Filter'],
      });
    } catch (error) {
      console.error(`[qdrant] DeleteByFilter error in '${collection}':`, error);
      throw error;
    }
  }

  /**
   * Permanently delete entries soft-deleted more than `olderThanDays` days ago.
   * Points without a `deleted_at` value never match the range filter.
   */
  async purgeDeleted(collection: string, olderThanDays: number): Promise<void> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    await this.deleteByFilter(collection, {
      must: [{ key: 'deleted_at', range: { lt: cutoff } }],
    });
  }

  async getCollectionInfo(collection: string): Promise<{ count: number }> {
    try {
      const info = await this.client.getCollection(collection);
      return { count: info.points_count ?? 0 };
    } catch (error) {
      console.error(`[qdrant] GetCollectionInfo error for '${collection}':`, error);
      throw error;
    }
  }

  async countByFilter(collection: string, filter: Record<string, unknown>): Promise<number> {
    try {
      const result = await this.client.count(collection, {
        filter: filter as Schemas['Filter'],
        exact: true,
      });
      return result.count;
    } catch (error) {
      console.error(`[qdrant] CountByFilter error for '${collection}':`, error);
      throw error;
    }
  }

  async scroll(collection: string, options: {
    filter?: Record<string, unknown>;
    limit?: number;
    offset?: string;
    withVector?: boolean;
  }): Promise<{ points: SearchResult[]; nextOffset?: string }> {
    const { filter, limit = 100, offset, withVector = false } = options;

    try {
      const result = await this.client.scroll(collection, {
        limit,
        with_payload: true,
        with_vector: withVector,
        ...(filter ? { filter: filter as Schemas['Filter'] } : {}),
        ...(offset ? { offset } : {}),
      });

      return {
        points: result.points.map(point => ({
          id: String(point.id),
          score: 1,
          payload: (point.payload as Record<string, unknown>) ?? {},
        })),
        nextOffset: result.next_page_offset ? String(result.next_page_offset) : undefined,
      };
    } catch (error) {
      console.error(`[qdrant] Scroll error in '${collection}':`, error);
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }
}

export const COLLECTION_NAMES = COLLECTIONS;
export type { CollectionName };
