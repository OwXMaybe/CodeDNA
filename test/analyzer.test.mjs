import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFiles, lineMetrics, parseImports, parseSymbols, readProjectFiles, readZipBytes, stronglyConnectedComponents, PROJECT_LIMITS, ZIP_LIMITS } from '../core/analyzer.mjs';
import { buildGraphModel } from '../core/graph.mjs';

function storedZip(entries) {
  const chunks = [], central = []; let offset = 0;
  for (const [name, text, flags = 0] of entries) {
    const filename = new TextEncoder().encode(name), data = new TextEncoder().encode(text), local = new Uint8Array(30 + filename.length + data.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, flags, true); lv.setUint16(8, 0, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, filename.length, true);
    local.set(filename, 30); local.set(data, 30 + filename.length); chunks.push(local);
    const record = new Uint8Array(46 + filename.length), cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, flags, true); cv.setUint16(10, 0, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, filename.length, true); cv.setUint32(42, offset, true);
    record.set(filename, 46); central.push(record); offset += local.length;
  }
  const centralSize = central.reduce((sum, record) => sum + record.length, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  return new Uint8Array([...chunks, ...central, end].reduce((acc, part) => [...acc, ...part], []));
}

test('ZIP reader inventories text files and excludes generated folders', async () => {
  const zip = storedZip([['demo/src/main.ts', 'export { run } from "./run";'], ['demo/src/run.ts', 'export const run = 1;'], ['demo/node_modules/pkg/index.js', 'ignored']]);
  const files = await readZipBytes(zip);
  assert.deepEqual(files.map(file => file.path), ['demo/src/main.ts', 'demo/src/run.ts']);
  assert.equal(files[0].content, 'export { run } from "./run";');
});

test('ZIP reader rejects path traversal, encryption, malformed and non-ZIP input', async () => {
  await assert.rejects(readZipBytes(storedZip([['../outside.txt', 'bad']])), /Unsafe archive path/);
  await assert.rejects(readZipBytes(storedZip([['secret.txt', 'hidden', 1]])), /Encrypted ZIP/);
  await assert.rejects(readZipBytes(new Uint8Array([1, 2, 3])), /not a supported ZIP/);
});

test('ZIP reader reports oversized entries instead of silently dropping them', async () => {
  const files = await readZipBytes(storedZip([['large.ts', '1234567890']]), { ...ZIP_LIMITS, fileBytes: 5 });
  assert.equal(files.length, 0);
  assert.match(files.skippedFiles[0].reason, /per-file ZIP limit/);
});

test('folder analysis streams large text files and preserves import evidence', async () => {
  const source = `import { start } from './start';\nexport function main() {}\n` + 'const value = 1;\n'.repeat(90_000);
  const large = new File([source], 'large.ts');
  Object.defineProperty(large, 'webkitRelativePath', { value: 'sample/src/large.ts' });
  const ignored = new File(['do not inspect'], 'dep.ts');
  Object.defineProperty(ignored, 'webkitRelativePath', { value: 'sample/node_modules/pkg/dep.ts' });
  const files = await readProjectFiles([large, ignored], { limits: { ...PROJECT_LIMITS, largeFileThreshold: 1024 } });
  const result = analyzeFiles(files);
  assert.equal(files.length, 1);
  assert.equal(files[0].metadataOnly, true);
  assert.equal(files[0].metrics.lines, 90_003);
  assert.equal(files[0].imports[0].specifier, './start');
  assert.deepEqual(files[0].symbols[0], { name: 'main', line: 2, kind: 'function' });
  assert.equal(result.metadataOnlyFiles, 1);
  assert.match(result.skippedFiles[0].reason, /directory ignored/);
});

test('line metrics report blank, comment, and code counts', () => {
  assert.deepEqual(lineMetrics('const x = 1;\n\n// note\nreturn x;'), { lines: 4, blank: 1, comments: 1, code: 2 });
});

test('import and re-export extraction retains evidence lines', () => {
  assert.deepEqual(parseImports('import x from "./x";\nexport { y } from "../y";'), [
    { specifier: './x', line: 1 }, { specifier: '../y', line: 2 }
  ]);
});

test('source declaration inventory recognizes exports and CommonJS imports', () => {
  assert.deepEqual(parseImports('const x = require("./x");'), [{ specifier: './x', line: 1 }]);
  assert.deepEqual(parseSymbols('export function run() {}\nexport class Engine {}\nexport const ready = (x: number) => x > 0;').map(({ name, kind, line }) => ({ name, kind, line })), [
    { name: 'run', kind: 'function', line: 1 },
    { name: 'Engine', kind: 'class', line: 2 },
    { name: 'ready', kind: 'function', line: 3 }
  ]);
});

test('project graph separates path containment from evidenced imports', () => {
  const files = [
    { path: 'demo/src/app.ts', language: 'TypeScript', metrics: { lines: 8, code: 6 }, size: 120 },
    { path: 'demo/src/ui/button.ts', language: 'TypeScript', metrics: { lines: 12, code: 10 }, size: 240 },
    { path: 'demo/README.md', language: 'Markdown', metrics: { lines: 2, code: 2 }, size: 30 }
  ];
  const graph = buildGraphModel(files, [{ source: 'demo/src/app.ts', target: 'demo/src/ui/button.ts', line: 1 }], 'demo');
  assert.equal(graph.nodes.find(node => node.id === 'folder://root').fileCount, 3);
  assert.equal(graph.nodes.find(node => node.id === 'folder:demo/src').fileCount, 2);
  assert.ok(graph.edges.some(edge => edge.kind === 'contains' && edge.source === 'folder:demo/src' && edge.target === 'file:demo/src/app.ts'));
  assert.ok(graph.edges.some(edge => edge.kind === 'imports' && edge.source === 'file:demo/src/app.ts' && edge.target === 'file:demo/src/ui/button.ts' && edge.line === 1));
  assert.ok(graph.edges.every(edge => edge.kind === 'contains' || edge.kind === 'imports'));
});

test('analysis counts languages, dependencies, resolved links, and cycles', () => {
  const files = [
    { path: 'package.json', ext: 'json', content: JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0', lodash: '^4.0.0', pg: '^8.0.0' }, devDependencies: { vitest: '^3.0.0' } }) },
    { path: 'src/a.ts', ext: 'ts', content: 'import { b } from "./b";\nexport const a = b;' },
    { path: 'src/b.ts', ext: 'ts', content: 'import { a } from "./a";\nexport const b = a;' },
    { path: 'src/page.html', ext: 'html', content: '<main></main>' }
  ];
  const result = analyzeFiles(files);
  assert.equal(result.projectName, 'fixture');
  assert.equal(result.manager, 'npm');
  assert.equal(result.languages.TypeScript.files, 2);
  assert.equal(result.languages.HTML, undefined);
  assert.equal(result.dependencies.react, '^19.0.0');
  assert.equal(result.edges.length, 2);
  assert.equal(result.cycles.length, 1);
  assert.ok(result.technologies.some(item => item.name === 'react' && item.version === '^19.0.0'));
  assert.ok(result.technologies.some(item => item.name === 'pg' && item.category === 'Database / ORM package'));
  assert.ok(result.technologies.some(item => item.name === 'vitest' && item.category === 'Testing package'));
});

test('strongly connected components ignore acyclic edges and detect self loops', () => {
  assert.deepEqual(stronglyConnectedComponents(['a', 'b', 'c'], [{ source: 'a', target: 'b' }, { source: 'c', target: 'c' }]), [['c']]);
  assert.deepEqual(stronglyConnectedComponents(['a', 'b', 'c'], [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }, { source: 'b', target: 'c' }]), []);
  const chain = Array.from({ length: 12_000 }, (_, index) => `node-${index}`);
  assert.deepEqual(stronglyConnectedComponents(chain, chain.slice(1).map((node, index) => ({ source: chain[index], target: node }))), []);
});
