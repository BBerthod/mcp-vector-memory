import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, encodeSparse, tokenToIndex } from './sparse-encoder.js';

describe('sparse encoder', () => {
  it('ignores French and English stopwords', () => {
    const tokens = tokenize('le chat de la maison and the house');
    for (const stop of ['le', 'the', 'de', 'la', 'and']) {
      assert.ok(!tokens.includes(stop), `stopword '${stop}' kept: ${JSON.stringify(tokens)}`);
    }
    assert.ok(tokens.includes('chat'));
    assert.ok(tokens.includes('house'));
  });

  it('folds accents and case', () => {
    assert.deepEqual(tokenize("Décision prise à l'été"), ['decision', 'prise', 'ete']);
    assert.deepEqual(encodeSparse('Décision').indices, encodeSparse('decision').indices);
    assert.deepEqual(encodeSparse('décision').indices, [tokenToIndex('decision')]);
  });

  it('keeps camelCase and snake_case splitting', () => {
    const tokens = tokenize('AuthService user_token');
    assert.deepEqual(tokens, ['authservice', 'auth', 'service', 'user_token', 'user', 'token']);
  });

  it('splits on typographic apostrophes', () => {
    const tokens = tokenize('l\u2019\u00e9t\u00e9 de qu\u2019on d\u2018accord l\u02bcann\u00e9e');
    assert.ok(tokens.includes('ete'), JSON.stringify(tokens));
    assert.ok(tokens.includes('accord'), JSON.stringify(tokens));
    assert.ok(tokens.includes('annee'), JSON.stringify(tokens));
    assert.ok(!tokens.some((t) => /[\u2018\u2019\u02bc]/.test(t)), JSON.stringify(tokens));
    assert.ok(!tokens.includes('l\u2019ete'), JSON.stringify(tokens));
  });
});
