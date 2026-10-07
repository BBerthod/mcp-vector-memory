// Secret detection patterns
const SECRET_PATTERNS: Array<{
  pattern: RegExp;
  description: string;
}> = [
  // Generic secret patterns — only match hardcoded string values in assignments
  {
    pattern: /(?:password|passwd|pwd|secret|api_key|apikey|api-key|access_key|accesskey|private_key|privatekey)\s*[=:]\s*["']([^\s"']{8,})["']/gi,
    description: 'Generic secret assignment',
  },
  // Bearer tokens (20+ chars)
  {
    pattern: /Bearer\s+[A-Za-z0-9_-]{20,}/gi,
    description: 'Bearer token',
  },
  // PEM keys
  {
    pattern: /-----BEGIN\s+(?:RSA\s+)?(?:EC\s+)?(?:DSA\s+)?(?:OPENSSH\s+)?(?:ENCRYPTED\s+)?PRIVATE\s+KEY-----/gi,
    description: 'PEM private key',
  },
  {
    pattern: /-----BEGIN\s+CERTIFICATE-----/gi,
    description: 'PEM certificate',
  },
  // GitHub PAT
  {
    pattern: /ghp_[A-Za-z0-9]{36}/g,
    description: 'GitHub PAT',
  },
  {
    pattern: /gho_[A-Za-z0-9]{36}/g,
    description: 'GitHub OAuth token',
  },
  {
    pattern: /ghu_[A-Za-z0-9]{36}/g,
    description: 'GitHub user token',
  },
  {
    pattern: /ghs_[A-Za-z0-9]{36}/g,
    description: 'GitHub server token',
  },
  {
    pattern: /ghr_[A-Za-z0-9]{36}/g,
    description: 'GitHub refresh token',
  },
  // OpenAI keys
  {
    pattern: /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g,
    description: 'OpenAI API key',
  },
  {
    pattern: /sk-[A-Za-z0-9]{48}/g,
    description: 'OpenAI-style key',
  },
  // AWS keys
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    description: 'AWS Access Key ID',
  },
  {
    pattern: /(?:aws_access_key_id|aws_secret_access_key)\s*[=:]\s*["']?([^\s"']+)["']?/gi,
    description: 'AWS credentials',
  },
  // Google API keys
  {
    pattern: /AIza[A-Za-z0-9_-]{35}/g,
    description: 'Google API key',
  },
  // Slack tokens
  {
    pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/g,
    description: 'Slack token',
  },
  // Stripe keys
  {
    pattern: /sk_live_[0-9a-zA-Z]{24}/g,
    description: 'Stripe live secret key',
  },
  {
    pattern: /rk_live_[0-9a-zA-Z]{24}/g,
    description: 'Stripe live restricted key',
  },
  // JWT tokens
  {
    pattern: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
    description: 'JWT token',
  },
  // Database connection strings
  {
    pattern: /(?:mysql|postgres|mongodb|redis):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi,
    description: 'Database connection string',
  },
  // Base64 encoded potential secrets (> 40 chars, looks like encoded data)
  {
    pattern: /(?:[A-Za-z0-9+/]{40,}={0,2})/g,
    description: 'Potential base64 encoded secret',
  },
];

const REDACTION_PLACEHOLDER = '[REDACTED]';

export function containsSecrets(text: string): boolean {
  for (const { pattern, description } of SECRET_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    
    if (pattern.test(text)) {
      // Special handling for base64 - verify it looks like a secret
      if (description === 'Potential base64 encoded secret') {
        const matches = text.match(pattern);
        if (matches) {
          for (const match of matches) {
            if (looksLikeSecretBase64(match)) {
              return true;
            }
          }
        }
        continue;
      }
      return true;
    }
  }
  return false;
}

function looksLikeSecretBase64(text: string): boolean {
  // Check if the base64 string contains keywords that suggest it's a secret
  const lowerText = text.toLowerCase();
  const secretKeywords = ['secret', 'key', 'token', 'password', 'credential', 'auth'];
  
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf-8');
    return secretKeywords.some(kw => decoded.toLowerCase().includes(kw));
  } catch {
    return false;
  }
}

export function redactSecrets(text: string): string {
  let redactedText = text;

  for (const { pattern, description } of SECRET_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    
    redactedText = redactedText.replace(pattern, (match) => {
      // Special handling for base64
      if (description === 'Potential base64 encoded secret') {
        if (!looksLikeSecretBase64(match)) {
          return match;
        }
      }
      
      // For assignment patterns, preserve the variable name
      const assignmentMatch = match.match(/^(\s*(?:password|passwd|pwd|secret|token|api_key|apikey|api-key|access_key|accesskey|private_key|privatekey)\s*[=:]\s*["']?)(.+)$/i);
      if (assignmentMatch) {
        return `${assignmentMatch[1]}${REDACTION_PLACEHOLDER}`;
      }
      
      return REDACTION_PLACEHOLDER;
    });
  }

  return redactedText;
}

export function scanObjectForSecrets(obj: unknown, path: string = ''): string[] {
  const findings: string[] = [];

  if (typeof obj === 'string') {
    if (containsSecrets(obj)) {
      findings.push(`Secret detected in ${path || 'value'}`);
    }
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      findings.push(...scanObjectForSecrets(obj[i], `${path}[${i}]`));
    }
  } else if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const newPath = path ? `${path}.${key}` : key;
      findings.push(...scanObjectForSecrets(value, newPath));
    }
  }

  return findings;
}

export function redactObjectSecrets<T>(obj: T): T {
  if (typeof obj === 'string') {
    return redactSecrets(obj) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObjectSecrets(item)) as T;
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactObjectSecrets(value);
    }
    return result as T;
  }

  return obj;
}

// Token bucket rate limiter
interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private maxPerHour: number;
  private burst: number;
  private buckets: Map<string, Bucket>;
  private refillRate: number; // tokens per millisecond

  constructor(maxPerHour: number, burst: number) {
    this.maxPerHour = maxPerHour;
    this.burst = burst;
    this.buckets = new Map();
    this.refillRate = maxPerHour / (60 * 60 * 1000); // Convert to per ms
    console.log(`[security] Rate limiter initialized: ${maxPerHour}/hour, burst ${burst}`);
  }

  private getBucket(tokenId: string): Bucket {
    let bucket = this.buckets.get(tokenId);
    
    if (!bucket) {
      bucket = {
        tokens: this.burst,
        lastRefill: Date.now(),
      };
      this.buckets.set(tokenId, bucket);
    }

    return bucket;
  }

  private refill(bucket: Bucket): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const refillAmount = elapsed * this.refillRate;

    bucket.tokens = Math.min(this.burst, bucket.tokens + refillAmount);
    bucket.lastRefill = now;
  }

  tryConsume(tokenId: string): boolean {
    const bucket = this.getBucket(tokenId);
    this.refill(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  getRemainingQuota(tokenId: string): { remaining: number; resetAt: Date } {
    const bucket = this.getBucket(tokenId);
    this.refill(bucket);

    const now = Date.now();
    const msUntilFull = (this.burst - bucket.tokens) / this.refillRate;
    const resetAt = new Date(now + msUntilFull);

    return {
      remaining: Math.floor(bucket.tokens),
      resetAt,
    };
  }

  reset(tokenId: string): void {
    this.buckets.delete(tokenId);
  }

  resetAll(): void {
    this.buckets.clear();
  }

  // Clean up old buckets to prevent memory leaks
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    const threshold = now - maxAgeMs;

    for (const [tokenId, bucket] of this.buckets.entries()) {
      if (bucket.lastRefill < threshold) {
        this.buckets.delete(tokenId);
      }
    }
  }
}

// Content validation utilities
export function validateContent(content: string, maxLength: number = 100000): { valid: boolean; error?: string } {
  if (!content || typeof content !== 'string') {
    return { valid: false, error: 'Content must be a non-empty string' };
  }

  if (content.length > maxLength) {
    return { valid: false, error: `Content exceeds maximum length of ${maxLength} characters` };
  }

  return { valid: true };
}

export function sanitizeInput(input: string): string {
  // Remove null bytes and control characters except newlines and tabs
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
