import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ProjectConfig {
  repo: string;
  server_repo_path: string;
  languages: string[];
  exclude: string[];
  webhook_secret?: string;
  docs_sources?: Array<{ type: string; path?: string; base_url?: string; space?: string }>;
  thresholds?: { code?: number; docs?: number; memory?: number };
}

export interface AuthToken {
  name: string;
  projects: string[];
}

export interface Config {
  projects: Record<string, ProjectConfig>;
  auth: { tokens: Record<string, AuthToken> };
  qdrantUrl: string;
  qdrantApiKey?: string;
  ollamaUrl: string;
  embedModelCode: string;
  embedModelText: string;
  embedDims: number;
  embedDocInstructionCode: string;
  embedDocInstructionText: string;
  embedQueryInstructionCode: string;
  embedQueryInstructionText: string;
  logLevel: string;
  rateLimitPerHour: number;
  rateLimitBurst: number;
}

interface RawConfig {
  projects: Record<string, ProjectConfig>;
  auth: { tokens: Record<string, AuthToken> };
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const resolved = process.env[envVar];
    if (!resolved) {
      console.warn(`[config] Environment variable ${envVar} not found`);
      return '';
    }
    return resolved;
  });
}

function resolveSecretsInConfig(config: RawConfig): void {
  for (const project of Object.values(config.projects)) {
    if (project.webhook_secret) {
      project.webhook_secret = resolveEnvVars(project.webhook_secret);
    }
  }
}

function loadConfig(): Config {
  const configPath = path.resolve(__dirname, '../config/projects.yml');
  
  let rawConfig: RawConfig;
  
  try {
    const fileContents = fs.readFileSync(configPath, 'utf8');
    rawConfig = yaml.load(fileContents) as RawConfig;
  } catch (error) {
    console.error(`[config] Failed to load config from ${configPath}:`, error);
    throw new Error(`Configuration load failed: ${error}`);
  }

  if (!rawConfig.projects) {
    rawConfig.projects = {};
  }
  if (!rawConfig.auth) {
    rawConfig.auth = { tokens: {} };
  }
  if (!rawConfig.auth.tokens) {
    rawConfig.auth.tokens = {};
  }

  resolveSecretsInConfig(rawConfig);

  const config: Config = {
    projects: rawConfig.projects,
    auth: rawConfig.auth,
    qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
    qdrantApiKey: process.env.QDRANT_API_KEY,
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    embedModelCode: process.env.EMBED_MODEL_CODE || 'sfr-embedding-mistral',
    embedModelText: process.env.EMBED_MODEL_TEXT || 'sfr-embedding-mistral',
    embedDims: parseInt(process.env.VECTOR_SIZE || '1024', 10),
    embedDocInstructionCode: process.env.EMBED_DOC_INSTRUCTION_CODE || '',
    embedDocInstructionText: process.env.EMBED_DOC_INSTRUCTION_TEXT || '',
    embedQueryInstructionCode: process.env.EMBED_QUERY_INSTRUCTION_CODE || '',
    embedQueryInstructionText: process.env.EMBED_QUERY_INSTRUCTION_TEXT || '',
    logLevel: process.env.LOG_LEVEL || 'info',
    rateLimitPerHour: parseInt(process.env.RATE_LIMIT_PER_HOUR || '1000', 10),
    rateLimitBurst: parseInt(process.env.RATE_LIMIT_BURST || '50', 10),
  };

  console.log(`[config] Loaded ${Object.keys(config.projects).length} projects`);
  console.log(`[config] Loaded ${Object.keys(config.auth.tokens).length} auth tokens`);

  return config;
}

export const config: Config = loadConfig();

export function getProjectsForToken(token: string): string[] {
  const tokenInfo = config.auth.tokens[token];
  if (!tokenInfo) {
    return [];
  }
  return tokenInfo.projects;
}

export function getTokenInfo(token: string): AuthToken | null {
  return config.auth.tokens[token] || null;
}

export function getDefaultThresholds(collection: string): number {
  switch (collection) {
    case 'code':
      return 0.45;
    case 'docs':
      return 0.40;
    case 'memory':
      return 0.50;
    default:
      return 0.45;
  }
}

export function getProjectThreshold(projectName: string, collection: string): number {
  const project = config.projects[projectName];
  if (!project?.thresholds) {
    return getDefaultThresholds(collection);
  }

  switch (collection) {
    case 'code':
      return project.thresholds.code ?? getDefaultThresholds(collection);
    case 'docs':
      return project.thresholds.docs ?? getDefaultThresholds(collection);
    case 'memory':
      return project.thresholds.memory ?? getDefaultThresholds(collection);
    default:
      return getDefaultThresholds(collection);
  }
}

export function isProjectAllowed(token: string, projectName: string): boolean {
  return getProjectsForToken(token).includes(projectName);
}
