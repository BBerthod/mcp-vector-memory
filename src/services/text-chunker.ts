import crypto from 'node:crypto';
import type { AstChunk } from './ast-chunker.js';

const MAX_SECTION_LINES = 80;
const SUB_CHUNK_LINES = 60;
const SUB_CHUNK_OVERLAP = 10;

function makeUuid(project: string, relativePath: string, startLine: number, endLine: number): string {
  const hash = crypto.createHash('sha256')
    .update(`${project}:${relativePath}:${startLine}:${endLine}`)
    .digest('hex')
    .substring(0, 32);
  return [hash.substring(0, 8), hash.substring(8, 12), hash.substring(12, 16), hash.substring(16, 20), hash.substring(20, 32)].join('-');
}

function subChunkSection(lines: string[], baseName: string, baseStartLine: number, project: string, relativePath: string, filePrefix: string): AstChunk[] {
  const chunks: AstChunk[] = [];
  for (let i = 0; i < lines.length; i += SUB_CHUNK_LINES - SUB_CHUNK_OVERLAP) {
    const slice = lines.slice(i, i + SUB_CHUNK_LINES);
    if (slice.length < 5 && i > 0) break;
    const startLine = baseStartLine + i;
    const endLine = startLine + slice.length - 1;
    const content = slice.join('\n');
    chunks.push({
      id: makeUuid(project, relativePath, startLine, endLine),
      content,
      embeddingContent: filePrefix + content,
      startLine,
      endLine,
      name: `${baseName}_sub_${startLine}`,
    });
  }
  return chunks;
}

export function chunkMarkdown(content: string, project: string, relativePath: string): AstChunk[] {
  const filePrefix = `// File: ${relativePath}\n`;
  const lines = content.split('\n');
  const sections: Array<{ name: string; startLine: number; lines: string[] }> = [];
  let current: { name: string; startLine: number; lines: string[] } = { name: 'intro', startLine: 1, lines: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch && current.lines.length > 0) {
      sections.push(current);
      current = { name: headingMatch[2].trim().substring(0, 60), startLine: i + 1, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0) sections.push(current);

  const chunks: AstChunk[] = [];
  for (const section of sections) {
    if (section.lines.length < 3) continue;
    if (section.lines.length > MAX_SECTION_LINES) {
      chunks.push(...subChunkSection(section.lines, section.name, section.startLine, project, relativePath, filePrefix));
    } else {
      const sectionContent = section.lines.join('\n');
      const endLine = section.startLine + section.lines.length - 1;
      chunks.push({
        id: makeUuid(project, relativePath, section.startLine, endLine),
        content: sectionContent,
        embeddingContent: filePrefix + sectionContent,
        startLine: section.startLine,
        endLine,
        name: section.name,
      });
    }
  }
  return chunks;
}

const SQL_BOUNDARY = /^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|SELECT|WITH|GRANT|REVOKE|BEGIN|COMMIT)\b/i;

export function chunkSql(content: string, project: string, relativePath: string): AstChunk[] {
  const filePrefix = `// File: ${relativePath}\n`;
  const lines = content.split('\n');
  const statements: Array<{ name: string; startLine: number; lines: string[] }> = [];
  let current: { name: string; startLine: number; lines: string[] } = { name: 'preamble', startLine: 1, lines: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(SQL_BOUNDARY);
    if (match && current.lines.length > 0) {
      statements.push(current);
      current = { name: `${match[1].toLowerCase()}_${i + 1}`, startLine: i + 1, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0) statements.push(current);

  const chunks: AstChunk[] = [];
  for (const stmt of statements) {
    if (stmt.lines.length < 2) continue;
    if (stmt.lines.length > MAX_SECTION_LINES) {
      chunks.push(...subChunkSection(stmt.lines, stmt.name, stmt.startLine, project, relativePath, filePrefix));
    } else {
      const stmtContent = stmt.lines.join('\n');
      const endLine = stmt.startLine + stmt.lines.length - 1;
      chunks.push({
        id: makeUuid(project, relativePath, stmt.startLine, endLine),
        content: stmtContent,
        embeddingContent: filePrefix + stmtContent,
        startLine: stmt.startLine,
        endLine,
        name: stmt.name,
      });
    }
  }
  return chunks;
}

export function chunkStructuredData(content: string, project: string, relativePath: string, format: 'json' | 'yaml'): AstChunk[] {
  const filePrefix = `// File: ${relativePath} (${format})\n`;
  const lines = content.split('\n');

  // For small files, return as single chunk
  if (lines.length <= MAX_SECTION_LINES) {
    return [{
      id: makeUuid(project, relativePath, 1, lines.length),
      content,
      embeddingContent: filePrefix + content,
      startLine: 1,
      endLine: lines.length,
      name: 'full_file',
    }];
  }

  // Split by top-level keys
  const topLevelPattern = format === 'json'
    ? /^\s{0,2}"[^"]+"\s*:/  // JSON top-level keys (0-2 indent)
    : /^[a-zA-Z_][a-zA-Z0-9_-]*\s*:/;  // YAML top-level keys (no indent)

  const sections: Array<{ name: string; startLine: number; lines: string[] }> = [];
  let current: { name: string; startLine: number; lines: string[] } = { name: 'header', startLine: 1, lines: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(topLevelPattern);
    if (match && current.lines.length > 0) {
      sections.push(current);
      const keyMatch = format === 'json' ? line.match(/"([^"]+)"/) : line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)/);
      current = { name: keyMatch?.[1] ?? `key_${i + 1}`, startLine: i + 1, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0) sections.push(current);

  const chunks: AstChunk[] = [];
  for (const section of sections) {
    if (section.lines.length < 2) continue;
    if (section.lines.length > MAX_SECTION_LINES) {
      chunks.push(...subChunkSection(section.lines, section.name, section.startLine, project, relativePath, filePrefix));
    } else {
      const sectionContent = section.lines.join('\n');
      const endLine = section.startLine + section.lines.length - 1;
      chunks.push({
        id: makeUuid(project, relativePath, section.startLine, endLine),
        content: sectionContent,
        embeddingContent: filePrefix + sectionContent,
        startLine: section.startLine,
        endLine,
        name: section.name,
      });
    }
  }
  return chunks.length > 0 ? chunks : [{
    id: makeUuid(project, relativePath, 1, lines.length),
    content,
    embeddingContent: filePrefix + content,
    startLine: 1,
    endLine: lines.length,
    name: 'full_file',
  }];
}

export function chunkByFormat(content: string, format: string, project: string, relativePath: string): AstChunk[] | null {
  switch (format) {
    case 'markdown': return chunkMarkdown(content, project, relativePath);
    case 'sql': return chunkSql(content, project, relativePath);
    case 'json': return chunkStructuredData(content, project, relativePath, 'json');
    case 'yaml': return chunkStructuredData(content, project, relativePath, 'yaml');
    default: return null;
  }
}
