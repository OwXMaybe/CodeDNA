/** Build a folder/file graph. Containment edges are path-derived; import edges
 * retain source evidence supplied by the static analyzer.
 */
export function buildGraphModel(files, imports = [], projectName = 'Project') {
  const nodeMap = new Map();
  const edges = [];
  const fileKeys = new Map(files.map(file => [file.path, `file:${file.path}`]));
  const root = {
    id: 'folder://root', path: '', label: 'PROJECT ROOT', kind: 'folder',
    fileCount: 0, lines: 0, code: 0, size: 0, languages: new Set(), children: []
  };
  nodeMap.set(root.id, root);

  for (const file of files) {
    const parts = file.path.split(/[\\/]+/).filter(Boolean);
    const dirs = parts.slice(0, -1);
    let parent = root;

    for (let index = 0; index < dirs.length; index++) {
      const path = dirs.slice(0, index + 1).join('/');
      const id = `folder:${path}`;
      if (!nodeMap.has(id)) {
        const folder = {
          id, path, label: dirs[index], kind: 'folder',
          fileCount: 0, lines: 0, code: 0, size: 0, languages: new Set(), children: []
        };
        nodeMap.set(id, folder);
        parent.children.push(id);
        edges.push({ source: parent.id, target: id, kind: 'contains' });
      }
      parent = nodeMap.get(id);
    }

    const fileNode = {
      id: fileKeys.get(file.path), path: file.path, label: parts.at(-1) || file.path,
      kind: 'file', file, language: file.language || 'Other', metrics: file.metrics, size: file.size || 0
    };
    nodeMap.set(fileNode.id, fileNode);
    parent.children.push(fileNode.id);
    edges.push({ source: parent.id, target: fileNode.id, kind: 'contains' });

    root.fileCount++;
    root.lines += file.metrics.lines;
    root.code += file.metrics.code;
    root.size += file.size || 0;
    root.languages.add(file.language || 'Other');
    for (let index = 0; index < dirs.length; index++) {
      const folder = nodeMap.get(`folder:${dirs.slice(0, index + 1).join('/')}`);
      folder.fileCount++;
      folder.lines += file.metrics.lines;
      folder.code += file.metrics.code;
      folder.size += file.size || 0;
      folder.languages.add(file.language || 'Other');
    }
  }

  const visibleFileKeys = new Set(fileKeys.values());
  for (const edge of imports) {
    const source = fileKeys.get(edge.source);
    const target = fileKeys.get(edge.target);
    if (source && target && visibleFileKeys.has(source) && visibleFileKeys.has(target)) {
      edges.push({ ...edge, source, target, kind: 'imports' });
    }
  }

  root.projectName = projectName;
  return { nodes: [...nodeMap.values()], edges, fileKeys, rootId: root.id };
}
