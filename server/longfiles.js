import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens, extractiveSummary } from './context.js';
import { writeFileDurable } from './store.js';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm',
  '.csv', '.tsv', '.log', '.py', '.ps1', '.sh', '.bat', '.yml', '.yaml', '.xml', '.sql', '.ini', '.cfg', '.toml',
]);

export function isTextFile(file) {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export function readTextChunk(full, offset = 0, maxTokens = 2500) {
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) throw new Error('File not found');
  if (!isTextFile(full)) throw new Error('Only text files can be chunk-read');
  const text = fs.readFileSync(full, 'utf8');
  const totalChars = text.length;
  const start = Math.max(0, Math.min(totalChars, Number(offset) || 0));
  const maxChars = Math.max(2000, Math.min(240000, Math.round((Number(maxTokens) || 2500) * 4)));
  let end = Math.min(totalChars, start + maxChars);
  if (end < totalChars) {
    const boundary = text.lastIndexOf('\n', end);
    if (boundary > start + maxChars * 0.6) end = boundary + 1;
  }
  const chunk = text.slice(start, end);
  return {
    text: chunk,
    offset: start,
    nextOffset: end,
    eof: end >= totalChars,
    totalChars,
    totalTokens: estimateTokens(text),
    chunkTokens: estimateTokens(chunk),
    chunkChars: chunk.length,
    chunkIndex: start === 0 ? 0 : Math.floor(start / maxChars),
    totalChunks: Math.ceil(totalChars / maxChars),
    maxTokens,
  };
}

export function writeTextChunk(full, content, mode = 'append') {
  const text = String(content == null ? '' : content);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  writeFileDurable(full, text, { append: mode !== 'replace' });
  const stat = fs.statSync(full);
  return {
    path: full,
    mode: mode === 'replace' ? 'replace' : 'append',
    writtenChars: text.length,
    writtenTokens: estimateTokens(text),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

export function digestForSummary(text, chunkChars = 16000, maxDigestChars = 26000) {
  const source = String(text || '');
  const chunks = [];
  for (let start = 0; start < source.length; start += chunkChars) {
    chunks.push(source.slice(start, start + chunkChars));
  }
  const excerpts = chunks.map((chunk) => extractiveSummary(chunk, 900)).filter(Boolean);
  let digest = excerpts.join('\n\n');
  while (digest.length > maxDigestChars) digest = extractiveSummary(digest, Math.max(4000, Math.floor(maxDigestChars * 0.8)));
  return { chunks: chunks.length, text: digest, sourceChars: source.length };
}