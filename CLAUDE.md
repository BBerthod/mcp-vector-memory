# CLAUDE.md

## Rôle
Serveur MCP auto-hébergé (Streamable HTTP, mode **stateless**) qui donne aux agents de code une mémoire partagée : recherche hybride (dense + BM25) dans du code indexé et des mémoires (décisions, conventions…), stockées dans Qdrant, embeddings calculés localement par Ollama. Le dépôt public est un instantané hebdomadaire d'un dépôt privé (commits « Snapshot du … »).

## Stack (versions installées par `package-lock.json`)
- Node.js ≥ 22 (`engines`), ESM (`"type": "module"`), TypeScript 5.9 (`strict`, `NodeNext`)
- `@modelcontextprotocol/sdk` 1.27.1, `express` 4.22, `zod` 3.25, `@qdrant/js-client-rest` 1.17, `js-yaml` 4.1, `web-tree-sitter` 0.24 + `tree-sitter-wasms` 0.1.13
- Services : Qdrant `v1.13.2`, Ollama `latest`, modèle `qwen3-embedding:8b` (4096 dimensions) en prod
- `node-cron` et `uuid` sont déclarés mais jamais importés

## Commandes
```bash
npm ci                 # install
npm run dev            # tsx watch src/index.ts (Qdrant + Ollama joignables requis)
npm run build          # tsc -> dist/
npm start              # node dist/index.js
npm run typecheck      # tsc --noEmit (ne couvre pas scripts/)
npm test               # node --import tsx --test "src/**/*.test.ts" — Docker requis
npm run lint           # CASSÉ : ni eslint en devDependency ni eslint.config.*
npx tsx scripts/migrate-sparse.ts --snapshot <nom> [--dry-run|--apply]
```
Tests : voir `TESTING.md`. 15 suites sur 24 lancent un conteneur `qdrant/qdrant:v1.13.2` jetable ; sans démon Docker elles sont **annulées** (pas skippées), les 9 autres passent.

## Architecture
```
src/index.ts          démarrage : services, retry Qdrant, init tree-sitter, purge, listen
src/app.ts            createApp (Express) + createMcpServer ; rate limit des tools/call
src/config.ts         lit config/projects.yml + variables d'env ; tokenStore
src/services/
  auth.ts             middleware bearer, buildAclFilter (filtre Qdrant par projet), requireAdminToken
  token-store.ts      jetons comparés par SHA-256 + timingSafeEqual
  qdrant.ts           collections code/docs/memory, vecteurs nommés `dense` + `bm25`, recherche RRF
  ollama.ts           /api/embed (unitaire et batch)
  security.ts         détection/caviardage de secrets (regex), RateLimiter (token bucket)
  sparse-encoder.ts   BM25 sans vocabulaire (FNV-1a), SPARSE_VERSION = 2
  ast-chunker.ts      découpage tree-sitter (ts, js, php, python, vue)
  text-chunker.ts     découpage markdown, sql, json, yaml
src/tools/            un fichier par outil MCP : search, remember, update_memory, forget, index_file, stats
src/test/             helpers de test (qdrant jetable, FakeOllama, harnais MCP en mémoire)
scripts/migrate-sparse.ts  ré-encodage bm25 v2, exige un snapshot récent
```
Routes HTTP : `GET /health` (sans auth), `POST /mcp` (bearer), `GET|DELETE /mcp` → 405, `DELETE /api/project/:name` (jeton `role: admin`). Les anciennes routes webhook / index-repo / index-doc sont supprimées (404, testé dans `src/test/removed-routes.test.ts`).

## Conventions observées
- Chaque outil : `registerXxxTool(server, qdrant, ollama, …, authContext)` avec `server.tool(nom, description FR, schéma zod, handler)`.
- Contrôle d'accès dans chaque outil : `authContext.allowedProjects.includes(project)` ou `buildAclFilter`.
- Erreurs d'outil : `{ content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true }`.
- Descriptions d'outils, messages d'erreur et sortie markdown en **français** ; commentaires, logs et README en **anglais**.
- Logs préfixés `[module]` via `console.*` (pas de logger ; `LOG_LEVEL` ne filtre rien).
- Imports relatifs avec suffixe `.js` (ESM NodeNext). Tests colocalisés `*.test.ts`, runner `node:test` + `node:assert/strict`.
- Suppression **douce** des mémoires (`deleted_at`) ; `search` filtre `is_empty: deleted_at` par défaut.
- Toute écriture pose `sparse_version`, `embedding_model`, `embedding_dims`, `schema_version` (2).

## Pièges
- `VECTOR_SIZE` est lu au chargement de `src/services/qdrant.ts` : en test, fixer `process.env.VECTOR_SIZE` avant tout import et importer le code du projet avec `await import()`.
- Valeurs par défaut du code ≠ prod : `sfr-embedding-mistral` / `VECTOR_SIZE=1024` dans le code, `qwen3-embedding:8b` / `4096` dans `docker-compose.yml`. Un écart de dimension fait échouer le démarrage (`CollectionSchemaMismatchError`) : le serveur ne supprime jamais une collection, il faut migrer.
- Changer le tokenizer sparse impose d'incrémenter `SPARSE_VERSION` et de lancer `scripts/migrate-sparse.ts` (serveur arrêté pendant `--apply`).
- Changer une instruction `EMBED_*_INSTRUCTION_*` change les vecteurs : ré-indexation nécessaire.
- `index_file` répond `queued` puis travaille en arrière-plan ; les erreurs ne sont que dans les logs.
- La collection `docs` est créée et interrogée mais aucun outil n'y écrit.
- `config/projects.yml` est versionné et contient un jeton d'exemple : ne jamais y commiter de vrai jeton (dépôt public).
- Les champs `repo`, `server_repo_path`, `languages`, `exclude`, `webhook_secret`, `docs_sources` de `projects.yml` ne sont lus par aucun code.

## Configuration
- `config/projects.yml` : `projects.<nom>.thresholds` (code/docs/memory) et `auth.tokens.<jeton> = { name, projects[], role?: admin }`. `${VAR}` n'est résolu que dans `webhook_secret`.
- Env : `QDRANT_URL`, `QDRANT_API_KEY`, `OLLAMA_URL`, `EMBED_MODEL_CODE|TEXT`, `VECTOR_SIZE`, `EMBED_DOC_INSTRUCTION_CODE|TEXT`, `EMBED_QUERY_INSTRUCTION_CODE|TEXT`, `LOG_LEVEL`, `RATE_LIMIT_PER_HOUR|BURST` (1000/50), `RATE_LIMIT_WRITE_PER_HOUR|BURST` (120/10, outils d'écriture), `PURGE_DELETED_AFTER_DAYS` (purge désactivée si absent), `PORT` (3100).

## Déploiement
- `Dockerfile` : multi-stage `node:22-slim` (`--platform=linux/amd64`), `npm ci` + `tsc`, image finale `npm ci --omit=dev`, `USER node`, port 3100, `config/` copié dans l'image.
- `docker-compose.yml` (Dokploy) : services `qdrant` (ulimit nofile 65536, 4 G), `ollama` (20 G), `ollama-init` (pull du modèle), `mcp-vector` (1 G, healthcheck `curl /health`, `./config` monté en lecture seule). Réseau externe `dokploy-network` requis.
- Exposition via labels Traefik, entrypoint `web` (HTTP ; TLS terminé par Cloudflare), en-têtes nosniff/frameDeny, corps limité à 200 Ko. Le domaine du dépôt est un placeholder (`vector.example.com`).
- Local : `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d` publie `localhost:3100`.
- Pas de CI dans le dépôt.

## Audits
Rapports dans `docs/audit/` (dette : `2026-10-26-dette.md`).
