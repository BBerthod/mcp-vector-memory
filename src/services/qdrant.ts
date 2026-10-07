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
  limit?: number;
}

export class QdrantService {
  private client: QdrantClient;

  constructor(url: string, apiKey?: string) {
    this.client = new QdrantClient({ url, apiKey, checkCompatibility: false });
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
      try {
        const info = await this.client.getCollection(name);
        // Check if collection uses old anonymous vector schema
        const vectors = info.config?.params?.vectors;
        if (vectors && typeof vectors === 'object' && 'size' in vectors) {
          // Old schema (anonymous vectors) — need to migrate to named vectors
          console.log(`[qdrant] Collection '${name}' uses old anonymous vectors — recreating with named vectors`);
          await this.client.deleteCollection(name);
        } else if (vectors && typeof vectors === 'object' && 'dense' in vectors) {
          // Check vector size matches
          const dense = (vectors as Record<string, unknown>).dense as Record<string, unknown> | undefined;
          if (dense && (dense.size as number) !== VECTOR_SIZE) {
            console.log(`[qdrant] Collection '${name}' has wrong vector size (${dense.size} vs ${VECTOR_SIZE}) — recreating`);
            await this.client.deleteCollection(name);
          } else {
            console.log(`[qdrant] Collection '${name}' already exists with correct schema`);
            return;
          }
        } else {
          console.log(`[qdrant] Collection '${name}' already exists`);
          return;
        }
      } catch {
        // Collection doesn't exist, create it
      }

      await this.client.createCollection(name, {
        vectors: {
          dense: {
            size: VECTOR_SIZE,
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
          bm25: {},
        },
      });
      console.log(`[qdrant] Created collection '${name}' with named vectors (dense: ${VECTOR_SIZE}-dim + bm25 sparse)`);

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
      const results = await this.client.search(collection, {
        vector: { name: 'dense', vector },
        limit,
        with_payload: true,
        ...(filter ? { filter: filter as Schemas['Filter'] } : {}),
        ...(threshold > 0 ? { score_threshold: threshold } : {}),
      });

      return results.map(point => ({
        id: String(point.id),
        score: point.score,
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
    const { filter, limit = 10 } = options;

    try {
      const results = await this.client.query(collection, {
        prefetch: [
          {
            query: denseVector,
            using: 'dense',
            limit: limit * 2,
            ...(filter ? { filter: filter as Schemas['Filter'] } : {}),
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
        query: { name: 'bm25', vector: sparseVector },
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

  async getCollectionInfo(collection: string): Promise<{ count: number }> {
    try {
      const info = await this.client.getCollection(collection);
      return { count: info.points_count ?? 0 };
    } catch (error) {
      console.error(`[qdrant] GetCollectionInfo error for '${collection}':`, error);
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
