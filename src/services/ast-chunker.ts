import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'web-tree-sitter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface AstChunk {
  id: string;
  content: string;
  embeddingContent: string;
  startLine: number;
  endLine: number;
  name: string;
}

const EXTRACTABLE_NODES: Record<string, string[]> = {
  php: [
    'function_definition',
    'class_declaration',
    'method_declaration',
    'trait_declaration',
    'interface_declaration',
    'enum_declaration',
  ],
  typescript: [
    'function_declaration',
    'class_declaration',
    'method_definition',
    'export_statement',
    'lexical_declaration',
  ],
  javascript: [
    'function_declaration',
    'class_declaration',
    'method_definition',
    'export_statement',
    'lexical_declaration',
  ],
  python: [
    'function_definition',
    'class_definition',
    'decorated_definition',
  ],
};

const GRAMMAR_FILES: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  php: 'tree-sitter-php.wasm',
  python: 'tree-sitter-python.wasm',
  vue: 'tree-sitter-typescript.wasm',
};

const MAX_CHUNK_LINES = 80;
const SUB_CHUNK_LINES = 60;
const SUB_CHUNK_OVERLAP = 10;
const MIN_PREAMBLE_LINES = 5;

let initialized = false;
const loadedLanguages: Map<string, Parser.Language> = new Map();

export async function initAstChunker(): Promise<boolean> {
  try {
    await Parser.init();

    const wasmsDir = path.resolve(__dirname, '../../node_modules/tree-sitter-wasms/out');

    for (const [lang, file] of Object.entries(GRAMMAR_FILES)) {
      if (loadedLanguages.has(lang)) continue;
      try {
        const wasmPath = path.join(wasmsDir, file);
        const language = await Parser.Language.load(wasmPath);
        loadedLanguages.set(lang, language);
        console.log(`[ast-chunker] Loaded grammar: ${lang}`);
      } catch (err) {
        console.warn(`[ast-chunker] Failed to load grammar '${lang}':`, err);
      }
    }

    initialized = loadedLanguages.size > 0;
    console.log(`[ast-chunker] Initialized with ${loadedLanguages.size} grammars`);
    return initialized;
  } catch (err) {
    console.error('[ast-chunker] Initialization failed:', err);
    return false;
  }
}

function makeUuid(project: string, relativePath: string, startLine: number, endLine: number): string {
  const hash = crypto.createHash('sha256')
    .update(`${project}:${relativePath}:${startLine}:${endLine}`)
    .digest('hex')
    .substring(0, 32);
  return [hash.substring(0, 8), hash.substring(8, 12), hash.substring(12, 16), hash.substring(16, 20), hash.substring(20, 32)].join('-');
}

function extractNodeName(node: Parser.SyntaxNode, parentClassName?: string): string {
  const type = node.type;
  const nameNode = node.childForFieldName('name');
  const name = nameNode?.text ?? 'anonymous';

  if (type === 'class_declaration' || type === 'class_definition') return `class_${name}`;
  if (type === 'trait_declaration') return `trait_${name}`;
  if (type === 'interface_declaration') return `interface_${name}`;
  if (type === 'enum_declaration') return `enum_${name}`;
  if (type === 'method_declaration' || type === 'method_definition') {
    return parentClassName ? `method_${parentClassName}.${name}` : `method_${name}`;
  }
  if (type === 'function_declaration' || type === 'function_definition') return `function_${name}`;

  if (type === 'decorated_definition') {
    const inner = node.namedChildren.find((c: Parser.SyntaxNode) =>
      c.type === 'function_definition' || c.type === 'class_definition'
    );
    if (inner) return extractNodeName(inner, parentClassName);
    return `decorated_${name}`;
  }
  if (type === 'export_statement') {
    const declaration = node.namedChildren.find((c: Parser.SyntaxNode) =>
      c.type === 'function_declaration' || c.type === 'class_declaration' || c.type === 'lexical_declaration'
    );
    if (declaration) return extractNodeName(declaration, parentClassName);
    return `export_${name}`;
  }
  if (type === 'lexical_declaration') {
    const declarator = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'variable_declarator');
    if (declarator) {
      const varName = declarator.childForFieldName('name')?.text ?? 'anonymous';
      const value = declarator.childForFieldName('value');
      if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
        return `function_${varName}`;
      }
    }
    return `const_${name}`;
  }

  return `block_${name}`;
}

function isExtractable(node: Parser.SyntaxNode, language: string): boolean {
  const types = EXTRACTABLE_NODES[language];
  if (!types || !types.includes(node.type)) return false;

  if (node.type === 'lexical_declaration') {
    const declarator = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'variable_declarator');
    if (!declarator) return false;
    const value = declarator.childForFieldName('value');
    return value !== null && (value.type === 'arrow_function' || value.type === 'function_expression');
  }

  if (node.type === 'export_statement') {
    return node.namedChildren.some((c: Parser.SyntaxNode) =>
      c.type === 'function_declaration' ||
      c.type === 'class_declaration' ||
      (c.type === 'lexical_declaration' && isExtractable(c, language))
    );
  }

  return true;
}

interface ExtractedNode {
  content: string;
  startLine: number;
  endLine: number;
  name: string;
  className?: string;
}

function extractImportLines(rootNode: Parser.SyntaxNode, source: string): string[] {
  const imports: string[] = [];
  for (const child of rootNode.namedChildren) {
    if (child.type === 'import_statement' || child.type === 'import_declaration' ||
        child.type === 'use_declaration' || child.type === 'namespace_use_declaration') {
      imports.push(source.substring(child.startIndex, child.endIndex));
    }
  }
  return imports.slice(0, 10); // Limit to 10 imports
}

function buildContextPrefix(filePath: string, language: string, className?: string, imports?: string[]): string {
  let prefix = `// File: ${filePath}\n`;
  if (imports && imports.length > 0) {
    prefix += imports.join('\n') + '\n';
  }
  if (className) {
    prefix += `// Class: ${className}\n`;
  }
  return prefix;
}

function extractNodes(rootNode: Parser.SyntaxNode, language: string, source: string): ExtractedNode[] {
  const nodes: ExtractedNode[] = [];

  function walk(node: Parser.SyntaxNode, parentClassName?: string): void {
    if (isExtractable(node, language)) {
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const content = source.substring(node.startIndex, node.endIndex);
      const name = extractNodeName(node, parentClassName);

      nodes.push({ content, startLine, endLine, name, className: parentClassName });

      if (node.type === 'class_declaration' || node.type === 'class_definition') {
        const className = node.childForFieldName('name')?.text ?? 'Anonymous';
        for (const child of node.namedChildren) {
          if (child.type === 'class_body' || child.type === 'declaration_list' || child.type === 'block') {
            for (const member of child.namedChildren) {
              walk(member, className);
            }
          }
        }
      }
      return;
    }

    for (const child of node.namedChildren) {
      walk(child, parentClassName);
    }
  }

  walk(rootNode);
  return nodes;
}

function subChunkLines(content: string, baseName: string, baseStartLine: number, contextPrefix?: string): ExtractedNode[] {
  const lines = content.split('\n');
  const subChunks: ExtractedNode[] = [];

  for (let i = 0; i < lines.length; i += SUB_CHUNK_LINES - SUB_CHUNK_OVERLAP) {
    const chunk = lines.slice(i, i + SUB_CHUNK_LINES);
    if (chunk.length < 5 && i > 0) break;

    const startLine = baseStartLine + i;
    const endLine = startLine + chunk.length - 1;
    subChunks.push({
      content: chunk.join('\n'),
      startLine,
      endLine,
      name: `${baseName}_sub_${startLine}`,
    });
  }

  return subChunks;
}

function extractVueScript(content: string): { scriptContent: string; offset: number } | null {
  const scriptMatch = content.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  if (!scriptMatch) return null;

  const scriptContent = scriptMatch[1];
  const beforeScript = content.substring(0, scriptMatch.index ?? 0);
  const offset = beforeScript.split('\n').length;

  return { scriptContent, offset };
}

export function chunkByAst(
  content: string,
  language: string,
  project: string,
  relativePath: string,
): AstChunk[] | null {
  if (!initialized) return null;

  let parseContent = content;
  let lineOffset = 0;
  let effectiveLang = language;

  if (language === 'vue') {
    const script = extractVueScript(content);
    if (!script) return null;
    parseContent = script.scriptContent;
    lineOffset = script.offset;
    effectiveLang = 'typescript';
  }

  const lang = loadedLanguages.get(effectiveLang);
  if (!lang) return null;

  const parser = new Parser();
  let tree: Parser.Tree | null = null;

  try {
    parser.setLanguage(lang);
    tree = parser.parse(parseContent);
    if (!tree) return null;

    const importLines = extractImportLines(tree.rootNode, parseContent);
    const extracted = extractNodes(tree.rootNode, effectiveLang, parseContent);
    if (extracted.length === 0) return null;

    const chunks: AstChunk[] = [];

    // Build preamble from uncovered lines
    const lines = parseContent.split('\n');
    const coveredLines = new Set<number>();
    for (const node of extracted) {
      for (let i = node.startLine; i <= node.endLine; i++) {
        coveredLines.add(i);
      }
    }

    const preambleLines: string[] = [];
    let preambleStart = -1;
    let preambleEnd = -1;
    for (let i = 1; i <= lines.length; i++) {
      if (!coveredLines.has(i)) {
        preambleLines.push(lines[i - 1]);
        if (preambleStart === -1) preambleStart = i;
        preambleEnd = i;
      }
    }

    if (preambleLines.length > MIN_PREAMBLE_LINES) {
      const preambleContent = preambleLines.join('\n');
      const preamblePrefix = buildContextPrefix(relativePath, effectiveLang);
      chunks.push({
        id: makeUuid(project, relativePath, preambleStart + lineOffset, preambleEnd + lineOffset),
        content: preambleContent,
        embeddingContent: preamblePrefix + preambleContent,
        startLine: preambleStart + lineOffset,
        endLine: preambleEnd + lineOffset,
        name: 'preamble',
      });
    }

    for (const node of extracted) {
      const nodeLines = node.endLine - node.startLine + 1;
      const contextPrefix = buildContextPrefix(relativePath, effectiveLang, node.className, importLines);

      if (nodeLines > MAX_CHUNK_LINES) {
        const subs = subChunkLines(node.content, node.name, node.startLine, contextPrefix);
        for (const sub of subs) {
          chunks.push({
            id: makeUuid(project, relativePath, sub.startLine + lineOffset, sub.endLine + lineOffset),
            content: sub.content,
            embeddingContent: contextPrefix + sub.content,
            startLine: sub.startLine + lineOffset,
            endLine: sub.endLine + lineOffset,
            name: sub.name,
          });
        }
      } else {
        chunks.push({
          id: makeUuid(project, relativePath, node.startLine + lineOffset, node.endLine + lineOffset),
          content: node.content,
          embeddingContent: contextPrefix + node.content,
          startLine: node.startLine + lineOffset,
          endLine: node.endLine + lineOffset,
          name: node.name,
        });
      }
    }

    console.log(`[ast-chunker] ${relativePath}: ${extracted.length} AST nodes → ${chunks.length} chunks`);
    return chunks;
  } catch (err) {
    console.error(`[ast-chunker] Parse error for ${relativePath}:`, err);
    return null;
  } finally {
    tree?.delete();
    parser.delete();
  }
}

export function isAstSupported(language: string): boolean {
  if (!initialized) return false;
  if (language === 'vue') return loadedLanguages.has('typescript');
  return loadedLanguages.has(language);
}
