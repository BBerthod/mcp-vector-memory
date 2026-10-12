import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { containsSecrets, redactSecrets } from './security.js';

// Fake secrets are assembled at run time so that no literal secret pattern
// appears in the source (GitHub push protection).
const mixed = (n: number): string => 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY'.repeat(Math.ceil(n / 32)).slice(0, n);

const FIXTURES: Record<string, string> = {
  'Anthropic api key': 'sk-' + 'ant-api03-' + mixed(93),
  'Anthropic admin key': 'sk-' + 'ant-admin01-' + mixed(93),
  'OpenAI project key': 'sk-' + 'proj-' + mixed(40) + '_-' + mixed(40),
  'OpenAI service account key': 'sk-' + 'svcacct-' + mixed(60),
  'OpenAI admin key': 'sk-' + 'admin-' + mixed(60),
  'GitHub fine-grained PAT': 'github_' + 'pat_' + mixed(22) + '_' + mixed(59),
  'GitLab PAT': 'glpat' + '-' + mixed(20),
  'npm token': 'npm' + '_' + mixed(36),
  'Vikunja/ntfy token': 'tk' + '_' + mixed(32),
  'Hugging Face token': 'hf' + '_' + mixed(34),
  'Slack config token': 'xox' + 'e-' + '1-' + mixed(60),
  'Slack app token': 'xapp' + '-1-' + mixed(40),
  'Telegram bot token': '123456789' + ':' + mixed(35),
};

describe('current API token formats', () => {
  for (const [label, secret] of Object.entries(FIXTURES)) {
    it(`detects and redacts a ${label}`, () => {
      const text = `export KEY=${secret} # done`;
      assert.equal(containsSecrets(text), true, `${label} not detected`);
      const redacted = redactSecrets(text);
      assert.ok(!redacted.includes(secret.slice(0, 24)), `${label} not redacted: ${redacted}`);
      assert.ok(redacted.includes('[REDACTED]'), redacted);
      assert.equal(containsSecrets(redacted), false, `residue after redaction: ${redacted}`);
    });
  }

  it('detects a Telegram token inside a bot API URL', () => {
    const url = 'https://api.telegram.org/bot' + '123456789' + ':' + mixed(35) + '/getMe';
    assert.equal(containsSecrets(url), true);
    assert.ok(!redactSecrets(url).includes(mixed(35)));
  });

  it('leaves close non-secrets alone', () => {
    const benign = [
      'task_id',
      'tk_ui',
      'hf_hub_download',
      'from sk-learn import svm',
      'the github_pat variable',
      'npm_config_cache',
      'See sk-ant for the Anthropic prefix',
      'ratio 12:35',
    ];
    for (const text of benign) {
      assert.equal(containsSecrets(text), false, text);
      assert.equal(redactSecrets(text), text, text);
    }
  });

  it('detects a Telegram token that ends with a hyphen', () => {
    const token = '123456789' + ':' + mixed(34) + '-';
    for (const text of [token, `https://api.telegram.org/bot${token}/getMe`, `TOKEN=${token}`]) {
      assert.equal(containsSecrets(text), true, text);
      const redacted = redactSecrets(text);
      assert.ok(!redacted.includes(mixed(34)), `not redacted: ${redacted}`);
    }
  });
});
