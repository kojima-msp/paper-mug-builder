import { unzipSync } from 'fflate';

export type ProjectFiles = Map<string, Uint8Array>;

/** zip を展開し、ゴミを除いて単一のトップフォルダを剥がす。 */
export function readZip(data: Uint8Array): ProjectFiles {
  const entries = unzipSync(data);
  const files: ProjectFiles = new Map();
  for (const [rawPath, content] of Object.entries(entries)) {
    const path = rawPath.replace(/\\/g, '/');
    if (path.endsWith('/')) continue;
    if (path.startsWith('__MACOSX/') || path.split('/').pop() === '.DS_Store') continue;
    files.set(path, content);
  }
  return stripCommonTopFolder(files);
}

export function stripCommonTopFolder(files: ProjectFiles): ProjectFiles {
  const paths = [...files.keys()];
  if (paths.length === 0) return files;
  const top = paths[0].split('/')[0];
  if (!paths.every((p) => p.includes('/') && p.split('/')[0] === top)) return files;
  const out: ProjectFiles = new Map();
  for (const [p, c] of files) out.set(p.slice(top.length + 1), c);
  return out;
}
