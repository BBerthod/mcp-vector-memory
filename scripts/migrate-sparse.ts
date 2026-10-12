/**
 * Migration de l'encodage sparse (version 2) pour les collections `code` et `memory`.
 *
 * Contexte : l'encodeur sparse a changé (repli des accents, mots vides, modificateur IDF).
 * Les points existants gardent l'ancien encodage et ne correspondent plus aux requêtes.
 * Ce script ré-encode le vecteur `bm25` de chaque point depuis son payload
 * (`summary` pour memory, `content` pour code). Le vecteur dense n'est jamais touché.
 * Aucun point ni aucune collection n'est supprimé.
 *
 * Usage :
 *   QDRANT_URL=http://localhost:6333 [QDRANT_API_KEY=...] \
 *     npx tsx scripts/migrate-sparse.ts --snapshot <nom> [--dry-run | --apply]
 *
 * Options :
 *   --snapshot <nom>  Obligatoire. Un instantané correspondant doit exister pour CHAQUE
 *                     collection traitée (vérifié via GET /collections/{c}/snapshots).
 *                     <nom> est le nom exact de l'instantané, ou un fragment d'au moins
 *                     8 caractères présent dans le nom de l'instantané de chaque collection
 *                     (par exemple l'identifiant de pair Qdrant, car Qdrant génère un nom
 *                     distinct par collection). L'instantané correspondant doit aussi être
 *                     récent (voir --max-snapshot-age-hours).
 *   --max-snapshot-age-hours <h>
 *                     Âge maximal de l'instantané (champ `creation_time`), défaut 24.
 *                     Un instantané plus ancien, ou sans date, est refusé.
 *   --dry-run         Mode par défaut : n'écrit rien, affiche les comptes.
 *   --apply           Écrit. Étapes : (1) active `modifier: idf` sur le vecteur sparse
 *                     existant (mise à jour de collection) ; si Qdrant le refuse, le script
 *                     s'arrête sans rien effacer : il faut alors recréer la collection
 *                     dans une nouvelle collection avec un alias, à la main, après
 *                     validation ; (2) ré-encode les vecteurs `bm25` par lots, puis pose
 *                     `sparse_version: 2` dans le payload.
 *
 * Écritures : arrêter les écritures (serveur arrêté ou en lecture seule) pendant `--apply`,
 * sinon une mise à jour concurrente peut garder un vecteur bm25 périmé marqué
 * `sparse_version: 2`.
 *
 * Idempotent : les points déjà marqués `sparse_version: 2` sont ignorés ; on peut relancer
 * le script après une interruption.
 *
 * Variables d'environnement : QDRANT_URL (défaut http://localhost:6333), QDRANT_API_KEY.
 */
import { QdrantClient } from '@qdrant/js-client-rest';
import { encodeSparse, SPARSE_VERSION } from '../src/services/sparse-encoder.js';

const TARGETS = [
  { collection: 'code', textField: 'content' },
  { collection: 'memory', textField: 'summary' },
] as const;

const BATCH_SIZE = 100;
const MIN_SNAPSHOT_FRAGMENT_LENGTH = 8;
const DEFAULT_MAX_SNAPSHOT_AGE_HOURS = 24;

const NOT_MIGRATED_FILTER = {
  must_not: [{ key: 'sparse_version', match: { value: SPARSE_VERSION } }],
};

function fail(code: number, message: string): never {
  console.error(`[migrate-sparse] ${message}`);
  process.exit(code);
}

function parseArgs(argv: string[]): { snapshot: string; apply: boolean; maxSnapshotAgeHours: number } {
  let snapshot: string | undefined;
  let maxSnapshotAgeHours = DEFAULT_MAX_SNAPSHOT_AGE_HOURS;
  let apply = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--snapshot') snapshot = argv[++i];
    else if (arg === '--max-snapshot-age-hours') {
      const raw = argv[++i];
      maxSnapshotAgeHours = raw !== undefined && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(maxSnapshotAgeHours) || maxSnapshotAgeHours < 0) {
        fail(2, '--max-snapshot-age-hours attend un nombre d\'heures positif ou nul.');
      }
    }
    else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else fail(2, `Argument inconnu : ${arg}`);
  }
  if (apply && dryRun) fail(2, '--apply et --dry-run sont exclusifs.');
  if (!snapshot) fail(2, 'Refus : --snapshot <nom> est obligatoire (créer un instantané de chaque collection avant la migration).');
  if (snapshot.length < MIN_SNAPSHOT_FRAGMENT_LENGTH) {
    fail(2, `Refus : --snapshot doit faire au moins ${MIN_SNAPSHOT_FRAGMENT_LENGTH} caractères (nom exact ou fragment non ambigu).`);
  }
  return { snapshot, apply, maxSnapshotAgeHours };
}

// Qdrant renvoie creation_time sans fuseau (UTC), par exemple "2026-10-08T00:12:34".
function snapshotAgeMs(creationTime: string | null | undefined): number | undefined {
  if (!creationTime) return undefined;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(creationTime);
  const time = Date.parse(hasZone ? creationTime : `${creationTime}Z`);
  return Number.isNaN(time) ? undefined : Date.now() - time;
}

async function requireSnapshots(client: QdrantClient, snapshot: string, maxSnapshotAgeHours: number): Promise<void> {
  const maxAgeMs = maxSnapshotAgeHours * 60 * 60 * 1000;
  for (const { collection } of TARGETS) {
    let snapshots: Array<{ name: string; creation_time?: string | null }>;
    try {
      snapshots = await client.listSnapshots(collection);
    } catch (error) {
      fail(2, `Impossible de lister les instantanés de '${collection}' : ${error instanceof Error ? error.message : String(error)}`);
    }
    const matching = snapshots.filter((s) => s.name === snapshot || s.name.includes(snapshot));
    if (matching.length === 0) {
      fail(2, `Refus : aucun instantané correspondant à '${snapshot}' pour la collection '${collection}'. Créer l'instantané d'abord.`);
    }
    const recent = matching.some((s) => {
      const age = snapshotAgeMs(s.creation_time);
      return age !== undefined && age < maxAgeMs;
    });
    if (!recent) {
      fail(2, `Refus : l'instantané de '${collection}' est trop ancien (ou sans date), plus de ${maxSnapshotAgeHours} h. Créer un instantané récent d'abord.`);
    }
    console.info(`[migrate-sparse] Instantané récent trouvé pour '${collection}'.`);
  }
}

async function countPoints(client: QdrantClient, collection: string, filter?: Record<string, unknown>): Promise<number> {
  const result = await client.count(collection, { exact: true, ...(filter ? { filter } : {}) } as never);
  return result.count;
}

async function currentModifier(client: QdrantClient, collection: string): Promise<string | undefined> {
  const info = await client.getCollection(collection);
  const modifier = info.config.params.sparse_vectors?.bm25?.modifier;
  return typeof modifier === 'string' ? modifier : undefined;
}

async function enableIdf(client: QdrantClient, collection: string): Promise<void> {
  if ((await currentModifier(client, collection)) === 'idf') {
    console.info(`[migrate-sparse] '${collection}' : modificateur IDF déjà actif.`);
    return;
  }
  try {
    await client.updateCollection(collection, { sparse_vectors: { bm25: { modifier: 'idf' } } });
    if ((await currentModifier(client, collection)) !== 'idf') throw new Error('le modificateur n\'est pas visible après la mise à jour');
  } catch (error) {
    fail(
      3,
      `'${collection}' : Qdrant n'a pas activé le modificateur IDF sur le sparse existant ` +
      `(${error instanceof Error ? error.message : String(error)}). Rien n'a été effacé. ` +
      'Il faut recréer la collection dans une nouvelle collection puis basculer l\'alias, à la main, après validation.',
    );
  }
  console.info(`[migrate-sparse] '${collection}' : modificateur IDF activé.`);
}

async function reencode(client: QdrantClient, collection: string, textField: string): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;
  let offset: string | number | undefined;
  for (;;) {
    const page = await client.scroll(collection, {
      limit: BATCH_SIZE,
      with_payload: [textField],
      with_vector: false,
      filter: NOT_MIGRATED_FILTER,
      ...(offset !== undefined ? { offset } : {}),
    } as never);

    const ids: Array<string | number> = [];
    const vectors: Array<{ id: string | number; vector: { bm25: { indices: number[]; values: number[] } } }> = [];
    for (const point of page.points) {
      const text = (point.payload as Record<string, unknown> | null | undefined)?.[textField];
      if (typeof text !== 'string' || text.trim() === '') {
        skipped++;
        continue;
      }
      ids.push(point.id);
      vectors.push({ id: point.id, vector: { bm25: encodeSparse(text) } });
    }

    if (vectors.length > 0) {
      await client.updateVectors(collection, { wait: true, points: vectors });
      await client.setPayload(collection, { wait: true, payload: { sparse_version: SPARSE_VERSION }, points: ids });
      updated += vectors.length;
      console.info(`[migrate-sparse] '${collection}' : ${updated} points ré-encodés.`);
    }

    const next = page.next_page_offset;
    if (next === null || next === undefined) break;
    offset = next as string | number;
  }
  return { updated, skipped };
}

async function main(): Promise<void> {
  const { snapshot, apply, maxSnapshotAgeHours } = parseArgs(process.argv.slice(2));
  const client = new QdrantClient({
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY,
    checkCompatibility: false,
  });

  await requireSnapshots(client, snapshot, maxSnapshotAgeHours);

  if (!apply) {
    console.info('[migrate-sparse] Mode --dry-run : rien n\'est écrit.');
    for (const { collection } of TARGETS) {
      const total = await countPoints(client, collection);
      const pending = await countPoints(client, collection, NOT_MIGRATED_FILTER);
      const modifier = (await currentModifier(client, collection)) ?? 'aucun';
      console.info(`[migrate-sparse] '${collection}' : ${total} points, ${pending} à ré-encoder, modificateur actuel : ${modifier}.`);
    }
    return;
  }

  for (const { collection } of TARGETS) await enableIdf(client, collection);
  for (const { collection, textField } of TARGETS) {
    const { updated, skipped } = await reencode(client, collection, textField);
    console.info(`[migrate-sparse] '${collection}' : terminé, ${updated} points ré-encodés, ${skipped} ignorés (texte absent).`);
  }
}

main().catch((error) => {
  console.error('[migrate-sparse] Échec :', error);
  process.exit(1);
});
