# Tests

## Prérequis

Docker doit être installé et démarré. Les tests lancent un Qdrant jetable
(`qdrant/qdrant:v1.13.2`, la version de production) dans un conteneur nommé
`vr-test-<aléatoire>`, publié sur un port local libre. Si Docker est
indisponible, les tests échouent avec une erreur explicite (pas de skip). Les
collections Qdrant de production ne sont jamais touchées.

## Lancer

```
npm test
```

Runner : `node:test` via `tsx`, sur les fichiers `src/**/*.test.ts`. Aucune
dépendance supplémentaire.

## Helpers (`src/test/`)

- `qdrant.ts` : `startQdrant()` démarre le conteneur, attend `/readyz`, renvoie
  `{ url, stop() }`. Appeler `stop()` dans un `after`.
- `fake-ollama.ts` : `FakeOllama` remplace `OllamaService`. Vecteurs
  déterministes et normalisés, dérivés d'un hachage du texte. `setVector(text,
  vector)` force le vecteur d'un texte, `calls` liste les textes reçus.
- `mcp-harness.ts` : `connectTools({ qdrant, ollama, rateLimiter?, authContext })`
  construit le serveur MCP avec le même `createMcpServer` que la production
  (`src/app.ts`), le relie à un client MCP en mémoire, et expose
  `call(name, args)` (JSON parsé du premier bloc texte).
- `smoke.test.ts` : exemple de bout en bout (collections, `remember`, `search`).

## Piège VECTOR_SIZE

`src/services/qdrant.ts` lit `VECTOR_SIZE` au chargement du module. Un test doit
donc faire `process.env.VECTOR_SIZE = '8'` avant tout import de code du projet,
et importer ce code avec `await import(...)` (les imports statiques sont
hissés et s'exécuteraient trop tôt). Les helpers qui touchent au code du projet
utilisent déjà des imports dynamiques.
