const MiB = 1024 * 1024;
export const ZIP_LIMITS = Object.freeze({ archiveBytes: 250 * MiB, expandedBytes: 600 * MiB, fileBytes: 600 * MiB, files: 25_000, suspiciousRatio: 20, ratioFloor: 512 * 1024 });
export const PROJECT_LIMITS = Object.freeze({ totalBytes: 1024 * MiB, fileBytes: 1024 * MiB, files: 25_000, largeFileThreshold: 16 * MiB, retainedTextBytes: 128 * MiB });
export const IGNORED_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.git', 'target', '__pycache__', '.venv', 'venv', 'out']);
const extensionLanguage = { ts:'TypeScript',tsx:'TypeScript',js:'JavaScript',jsx:'JavaScript',mjs:'JavaScript',cjs:'JavaScript',py:'Python',java:'Java',kt:'Kotlin',kts:'Kotlin',cs:'C#',go:'Go',rs:'Rust',php:'PHP',rb:'Ruby',swift:'Swift',c:'C',h:'C/C++',cpp:'C++',cc:'C++',hpp:'C++',dart:'Dart',html:'HTML',htm:'HTML',css:'CSS',scss:'SCSS',sass:'SCSS',less:'Less',sql:'SQL',sh:'Shell',bash:'Shell',ps1:'PowerShell',r:'R',scala:'Scala',lua:'Lua',vue:'Vue',svelte:'Svelte',xml:'XML',yaml:'YAML',yml:'YAML',toml:'TOML',json:'JSON',md:'Markdown' };
const codeLanguages = new Set(['TypeScript','JavaScript','Python','Java','Kotlin','C#','Go','Rust','PHP','Ruby','Swift','C','C/C++','C++','Dart','SQL','Shell','PowerShell','R','Scala','Lua']);

function assertSafePath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path) || path.split('/').some(part => part === '..' || part === '.' || part === '')) throw new Error(`Unsafe archive path rejected: ${path}`);
}

async function inflateRaw(bytes, onProgress = () => {}) {
  if (!globalThis.DecompressionStream || !globalThis.Blob) throw new Error('This browser cannot decompress ZIP files. Try a current version of Chrome, Edge, or Firefox.');
  let expanded = 0, lastReported = 0;
  const meter = new TransformStream({ transform(chunk, controller) { expanded += chunk.byteLength; if (expanded - lastReported >= MiB) { lastReported = expanded; onProgress(expanded); } controller.enqueue(chunk); } });
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).pipeThrough(meter);
  const blob = await new Response(stream).blob();
  if (blob.size !== lastReported) onProgress(blob.size);
  return blob;
}

export async function readZipBytes(input, limits = ZIP_LIMITS, onProgress = () => {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > limits.archiveBytes) throw new Error(`ZIP exceeds the ${Math.round(limits.archiveBytes / MiB)} MB archive limit.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = [];
  let eocd = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === view.byteLength) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a supported ZIP archive.');
  const entryTotal = view.getUint16(eocd + 10, true), centralSize = view.getUint32(eocd + 12, true);
  let offset = view.getUint32(eocd + 16, true), expanded = 0, retainedTextBytes = 0, entriesSeen = 0; const skippedFiles = [];
  const centralEnd = offset + centralSize;
  if (centralEnd > eocd) throw new Error('This ZIP archive appears damaged.');
  while (entriesSeen < entryTotal) {
    if (offset + 46 > centralEnd || view.getUint32(offset, true) !== 0x02014b50) throw new Error('This ZIP archive has a damaged file directory.');
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
    const externalAttrs = view.getUint32(offset + 38, true), localOffset = view.getUint32(offset + 42, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > view.byteLength) throw new Error('This ZIP archive appears damaged.');
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset = end;
    entriesSeen++;
    onProgress({ phase: 'indexing', done: entriesSeen, totalEntries: entryTotal });
    assertSafePath(name.endsWith('/') ? name.slice(0, -1) : name);
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Encrypted ZIP files are not supported.');
    if ([compressed, size, localOffset].includes(0xffffffff)) throw new Error('ZIP64 archives are not supported.');
    const unixMode = externalAttrs >>> 16;
    if ((unixMode & 0xf000) === 0xa000) { skippedFiles.push({ path: name, reason: 'Symbolic link excluded', size }); continue; }
    if (name.split('/').some(part => IGNORED_DIRS.has(part.toLowerCase()))) { skippedFiles.push({ path: name, reason: 'Generated or dependency directory ignored' }); continue; }
    if (entriesSeen > limits.files) throw new Error(`Project exceeds the ${limits.files.toLocaleString()} entry limit.`);
    if (size > limits.fileBytes) { skippedFiles.push({ path: name, reason: `File exceeds the ${Math.round(limits.fileBytes / MiB)} MB per-file ZIP limit`, size }); continue; }
    if (size > limits.suspiciousRatio * compressed && size > limits.ratioFloor) throw new Error(`Suspicious compression ratio in ${name}; file rejected.`);
    if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Invalid ZIP entry: ${name}`);
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataStart + compressed > view.byteLength) throw new Error(`Damaged ZIP entry: ${name}`);
    let data;
    if (method === 0) data = bytes.subarray(dataStart, dataStart + compressed);
    else if (method === 8) data = await inflateRaw(bytes.subarray(dataStart, dataStart + compressed), done => onProgress({ phase: 'unpacking', done, bytesTotal: size, path: name, entry: entriesSeen, totalEntries: entryTotal }));
    else { skippedFiles.push({ path: name, reason: `Unsupported ZIP compression method (${method})`, size }); continue; }
    const dataSize = data instanceof Blob ? data.size : data.length;
    if (dataSize !== size) throw new Error(`Invalid expanded size for ${name}`);
    expanded += size;
    if (expanded > limits.expandedBytes) throw new Error(`Expanded project exceeds the ${Math.round(limits.expandedBytes / MiB)} MB analysis limit.`);
    let content;
    const ext = name.split('.').pop().toLowerCase();
    const retainBudget = limits.retainedTextBytes ?? PROJECT_LIMITS.retainedTextBytes;
    if (size >= PROJECT_LIMITS.largeFileThreshold || retainedTextBytes + size > retainBudget) {
      const streamed = await scanLargeTextFile(data, name, ext, (done, total) => onProgress({ phase: 'scanning', done, bytesTotal: total, path: name, entry: entriesSeen, totalEntries: entryTotal }));
      if (streamed.binary) { skippedFiles.push({ path: name, reason: 'Binary file excluded from text analysis', size }); continue; }
      if (streamed.invalidText) { skippedFiles.push({ path: name, reason: 'File is not valid UTF-8 text', size }); continue; }
      files.push({ path: name, content: '', size, ext, ...streamed, metadataOnly: true });
    } else {
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data instanceof Blob ? await data.arrayBuffer() : data); }
      catch { skippedFiles.push({ path: name, reason: 'File is not UTF-8 text', size }); continue; }
      if (content.includes('\0')) { skippedFiles.push({ path: name, reason: 'Binary file excluded from text analysis', size }); continue; }
      files.push({ path: name, content, size, ext });
      retainedTextBytes += size;
    }
  }
  if (offset > centralEnd) throw new Error('This ZIP archive has a damaged file directory.');
  files.skippedFiles = skippedFiles;
  return files;
}

export function lineMetrics(content) {
  const lines = content.split(/\r?\n/); let blank = 0, comments = 0, block = false;
  for (const raw of lines) {
    const text = raw.trim();
    if (!text) { blank++; continue; }
    if (block) { comments++; if (text.includes('*/')) block = false; continue; }
    if (/^\/\//.test(text) || /^#/.test(text) || /^\*/.test(text) || /^<!--/.test(text) || /^--/.test(text)) {
      comments++; if (text.includes('/*') && !text.includes('*/')) block = true;
    }
  }
  return { lines: lines.length, blank, comments, code: lines.length - blank - comments };
}

export function parseImports(content) {
  const out = [], pattern = /(?:\bimport\s+(?:[^'";]*?\s+from\s*)?|\bexport\s+(?:[^'";]*?\s+from\s*)?|\bimport\s*\(|\brequire\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(pattern)) out.push({ specifier: match[1], line: content.slice(0, match.index).split('\n').length });
  return out;
}

// Lightweight symbol inventory for navigation. These are declaration-shaped
// source matches, not AST guarantees, so the UI labels them as static evidence.
const sourceSymbolPattern = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?\s+([\w$]+)|class\s+([\w$]+)|interface\s+([\w$]+)|type\s+([\w$]+)|enum\s+([\w$]+)|(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?:=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[\w$]+)(?:\s*:\s*[^=]+)?\s*=>)|:\s*[^=]+=>))/;
function parseSymbolLine(line, number = 1) {
  const match = line.match(sourceSymbolPattern);
  if (!match) return null;
  const name = match.slice(1).find(Boolean);
  if (!name) return null;
  const kind = /\bclass\b/.test(line) ? 'class' : /\binterface\b/.test(line) ? 'interface' : /\btype\b/.test(line) ? 'type' : /\benum\b/.test(line) ? 'enum' : /\bfunction\b/.test(line) || /=>/.test(line) ? 'function' : 'declaration';
  return { name, line: number, kind };
}

export function parseSymbols(content) {
  const symbols = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const symbol = parseSymbolLine(line, index + 1);
    if (symbol) symbols.push(symbol);
  }
  return symbols;
}

function isCommentLine(text) { return /^\/\//.test(text) || /^#/.test(text) || /^\*/.test(text) || /^<!--/.test(text) || /^--/.test(text); }

async function scanLargeTextFile(file, path, ext, onProgress = () => {}) {
  const fileSize = file.size ?? file.byteLength;
  let byteOffset = 0;
  const stream = typeof file.stream === 'function' ? file.stream() : new ReadableStream({
    pull(controller) {
      if (byteOffset >= file.byteLength) { controller.close(); return; }
      const end = Math.min(byteOffset + 64 * 1024, file.byteLength);
      controller.enqueue(file.subarray(byteOffset, end)); byteOffset = end;
    }
  });
  const reader = stream.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', lineCount = 0, blank = 0, comments = 0, blockComment = false, bytesRead = 0, lastProgress = 0;
  let recentLines = [], imports = [], symbols = [], seen = new Set(), hadBytes = false, endedWithNewline = false;
  const sourceCode = ['ts','tsx','js','jsx','mjs','cjs'].includes(ext);
  const consumeLine = (line) => {
    const text = line.trim(); lineCount++;
    if (!text) blank++;
    else if (blockComment) { comments++; if (text.includes('*/')) blockComment = false; }
    else if (isCommentLine(text)) { comments++; if (text.includes('/*') && !text.includes('*/')) blockComment = true; }
    if (!sourceCode) return;
    if (symbols.length < 600) { const symbol = parseSymbolLine(line, lineCount); if (symbol) symbols.push(symbol); }
    recentLines.push(line); if (recentLines.length > 24) recentLines.shift();
    const joined = recentLines.join('\n'), baseLine = lineCount - recentLines.length;
    for (const ref of parseImports(joined)) {
      const absoluteLine = baseLine + ref.line, key = `${absoluteLine}\0${ref.specifier}`;
      if (!seen.has(key)) { seen.add(key); imports.push({ ...ref, line: absoluteLine }); }
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    hadBytes = true; bytesRead += value.byteLength;
    if (value.includes(0)) { await reader.cancel(); return { binary: true }; }
    let text;
    try { text = decoder.decode(value, { stream: true }); }
    catch { await reader.cancel(); return { binary: false, invalidText: true }; }
    endedWithNewline = /(?:\r?\n)$/.test(text);
    const parts = (pending + text).split(/\r?\n/); pending = parts.pop();
    for (const line of parts) consumeLine(line);
    if (bytesRead - lastProgress >= 8 * MiB) { lastProgress = bytesRead; onProgress(bytesRead, fileSize); }
  }
  try { pending += decoder.decode(); }
  catch { return { binary: false, invalidText: true }; }
  if (pending || !hadBytes || endedWithNewline) consumeLine(pending);
  onProgress(fileSize, fileSize);
  return { metrics: { lines: lineCount, blank, comments, code: lineCount - blank - comments }, imports, symbols, binary: false };
}

export async function readProjectFiles(inputFiles, { limits = PROJECT_LIMITS, onProgress = () => {} } = {}) {
  const files = [], skippedFiles = []; let totalBytes = 0, examined = 0, retainedTextBytes = 0;
  if (inputFiles.length > limits.files) throw new Error(`Project exceeds the ${limits.files.toLocaleString()} file limit.`);
  for (const file of inputFiles) {
    const path = file.webkitRelativePath || file.name;
    const skip = (reason, size = file.size) => { skippedFiles.push({ path: path || '(unknown path)', reason, size }); examined++; onProgress(examined, inputFiles.length, path, size, size); };
    if (!path || path.split(/[\\/]+/).some(part => part === '..' || part === '.')) { skip('Unsafe relative file path'); continue; }
    if (path.split(/[\\/]+/).some(part => IGNORED_DIRS.has(part.toLowerCase()))) { skip('Generated or dependency directory ignored'); continue; }
    if (file.size > limits.fileBytes) { skip(`File exceeds the ${Math.round(limits.fileBytes / MiB)} MB analysis limit`); continue; }
    totalBytes += file.size;
    if (totalBytes > limits.totalBytes) throw new Error(`Project exceeds the ${Math.round(limits.totalBytes / MiB)} MB total analysis limit.`);
    const ext = path.split('.').pop().toLowerCase();
    let entry;
    if (file.size >= limits.largeFileThreshold || retainedTextBytes + file.size > (limits.retainedTextBytes ?? PROJECT_LIMITS.retainedTextBytes)) {
      const scanned = await scanLargeTextFile(file, path, ext, (done, size) => onProgress(examined, inputFiles.length, path, done, size));
      if (scanned.binary) { skip('Binary file excluded from text analysis'); continue; }
      if (scanned.invalidText) { skip('File is not valid UTF-8 text'); continue; }
      entry = { path, content: '', ext, size: file.size, metrics: scanned.metrics, imports: scanned.imports, symbols: scanned.symbols, metadataOnly: true };
    } else {
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
      catch { skip('File is not valid UTF-8 text'); continue; }
      if (content.includes('\0')) { skip('Binary file excluded from text analysis'); continue; }
      entry = { path, content, ext, size: file.size };
      retainedTextBytes += file.size;
    }
    files.push(entry); examined++;
    onProgress(examined, inputFiles.length, path, file.size, file.size);
  }
  files.skippedFiles = skippedFiles;
  return files;
}

function resolveTarget(source, specifier, paths) {
  if (!specifier.startsWith('.')) return null;
  const parts = source.split('/'); parts.pop();
  for (const part of specifier.split('/')) { if (part === '..') parts.pop(); else if (part !== '.') parts.push(part); }
  const base = parts.join('/');
  for (const candidate of [base, ...['ts','tsx','js','jsx','mjs','cjs','css','scss','sass','less','vue','svelte','html','json'].map(ext => `${base}.${ext}`), ...['ts','tsx','js','jsx','css','json'].map(ext => `${base}/index.${ext}`)]) if (paths.has(candidate)) return candidate;
  return null;
}

export function stronglyConnectedComponents(files, edges) {
  const nodes = [...new Set(files)], adjacency = new Map(nodes.map(node => [node, []])), reverse = new Map(nodes.map(node => [node, []]));
  for (const edge of edges) if (adjacency.has(edge.source) && adjacency.has(edge.target)) { adjacency.get(edge.source).push(edge.target); reverse.get(edge.target).push(edge.source); }
  const visited = new Set(), order = [];
  for (const root of nodes) {
    if (visited.has(root)) continue;
    visited.add(root); const stack = [[root, 0]];
    while (stack.length) {
      const frame = stack[stack.length - 1], children = adjacency.get(frame[0]);
      if (frame[1] < children.length) {
        const next = children[frame[1]++];
        if (!visited.has(next)) { visited.add(next); stack.push([next, 0]); }
      } else { order.push(frame[0]); stack.pop(); }
    }
  }
  const assigned = new Set(), components = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const root = order[i]; if (assigned.has(root)) continue;
    assigned.add(root); const component = [], stack = [root];
    while (stack.length) { const node = stack.pop(); component.push(node); for (const previous of reverse.get(node)) if (!assigned.has(previous)) { assigned.add(previous); stack.push(previous); } }
    if (component.length > 1 || adjacency.get(root).includes(root)) components.push(component);
  }
  return components;
}

export function analyzeFiles(files) {
  const languages = {}, paths = new Set(files.map(file => file.path)); let sourceFiles = 0, totalCode = 0;
  for (const file of files) {
    const language = extensionLanguage[file.ext] || 'Other'; file.language = language; file.content ||= ''; file.metrics ||= lineMetrics(file.content);
    if (!codeLanguages.has(language)) continue;
    sourceFiles++; totalCode += file.metrics.code;
    const stat = languages[language] ||= { files: 0, lines: 0, code: 0, comments: 0, blank: 0, dirs: new Set() };
    stat.files++; stat.lines += file.metrics.lines; stat.code += file.metrics.code; stat.comments += file.metrics.comments; stat.blank += file.metrics.blank;
    stat.dirs.add(file.path.includes('/') ? file.path.split('/')[0] : '(root)');
  }
  const edges = [];
  for (const file of files.filter(item => ['TypeScript','JavaScript'].includes(item.language))) {
    file.imports ||= parseImports(file.content);
    file.symbols ||= parseSymbols(file.content);
    for (const ref of file.imports) { const target = resolveTarget(file.path, ref.specifier, paths); if (target) edges.push({ source: file.path, target, line: ref.line, specifier: ref.specifier }); }
  }
  const pkgFile = files.find(file => file.path === 'package.json' || file.path.endsWith('/package.json'));
  let pkg = {}; if (pkgFile) try { pkg = JSON.parse(pkgFile.content); } catch { /* invalid manifests remain evidence, but yield no dependency claims */ }
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}), ...(pkg.peerDependencies || {}) };
  const lockfiles = [['pnpm-lock.yaml','pnpm'],['yarn.lock','Yarn'],['bun.lockb','Bun'],['bun.lock','Bun'],['package-lock.json','npm'],['poetry.lock','Poetry'],['uv.lock','uv'],['Pipfile.lock','Pipenv'],['Cargo.lock','Cargo'],['composer.lock','Composer'],['go.sum','Go modules'],['Gemfile.lock','Bundler'],['pom.xml','Maven'],['gradlew','Gradle']];
  const lockfile = lockfiles.find(([name]) => files.some(file => file.path === name || file.path.endsWith(`/${name}`)));
  const manager = lockfile?.[1] || (pkgFile ? 'npm' : files.some(file => file.path.endsWith('pyproject.toml')) ? 'Poetry / pip' : files.some(file => file.path.endsWith('Cargo.toml')) ? 'Cargo' : files.some(file => file.path.endsWith('go.mod')) ? 'Go modules' : 'Undetermined');
  const technologies = [];
  const add = (name, category, evidence, version = 'Undetermined') => technologies.push({ name, category, evidence, version });
  if (pkgFile) {
    add('Node.js ecosystem', 'Runtime', pkgFile.path, pkg.engines?.node || 'Undetermined');
    const packageSignals = [
      [/^(pg|postgres|mysql|mysql2|sqlite3|better-sqlite3|mongodb|mongoose|redis|ioredis|sequelize|typeorm|knex|prisma|@prisma\/client|drizzle-orm|drizzle-kit)$/i, 'Database / ORM package'],
      [/^(axios|got|graphql|@apollo\/client|@apollo\/server|@trpc\/client|@trpc\/server|socket\.io-client|stripe|@supabase\/supabase-js|firebase|firebase-admin)$/i, 'API / service package'],
      [/^(vitest|jest|playwright|@playwright\/test|cypress|mocha|chai|@testing-library\/react|@testing-library\/jest-dom)$/i, 'Testing package']
    ];
    for (const [name, version] of Object.entries(dependencies)) {
      if (/^(react|next|vue|nuxt|@angular\/core|svelte|astro|express|@nestjs\/core|fastify|vite|typescript|electron|react-native)$/.test(name)) add(name, 'Framework / tool', pkgFile.path, version);
      else { const signal = packageSignals.find(([pattern]) => pattern.test(name)); if (signal) add(name, signal[1], pkgFile.path, version); }
    }
  }
  for (const file of files) {
    const path = file.path.toLowerCase();
    if (/vite\.config\.(ts|js|mjs)$/.test(path)) add('Vite', 'Build tool', file.path);
    if (/next\.config\.(js|ts|mjs)$/.test(path)) add('Next.js', 'Framework', file.path);
    if (path.endsWith('/dockerfile') || path === 'dockerfile') add('Docker', 'Infrastructure', file.path);
    if (path.includes('.github/workflows/')) add('GitHub Actions', 'CI', file.path);
    if (/prisma\/schema\.prisma$/.test(path)) add('Prisma', 'Database toolkit', file.path);
  }
  const technologiesUnique = [...new Map(technologies.map(item => [`${item.name}|${item.evidence}`, item])).values()];
  const cycles = stronglyConnectedComponents(files.filter(file => ['TypeScript','JavaScript'].includes(file.language)).map(file => file.path), edges);
  const manifest = pkgFile ? { path: pkgFile.path, name: pkg.name || '', engines: pkg.engines || {}, scripts: pkg.scripts || {}, dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {}, optionalDependencies: pkg.optionalDependencies || {}, peerDependencies: pkg.peerDependencies || {} } : null;
  return { files, languages, sourceFiles, totalCode, totalFiles: files.length, skippedFiles: files.skippedFiles || [], metadataOnlyFiles: files.filter(file => file.metadataOnly).length, edges, cycles, dependencies, manager, technologies: technologiesUnique, manifest, projectName: pkg.name || files.find(file => file.path.includes('/'))?.path.split('/')[0] || 'Analyzed project', rootFiles: files.filter(file => !file.path.includes('/')).length };
}
