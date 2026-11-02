import path from 'node:path';

function validate(snapshot) {
  for (const [name, hash] of Object.entries(snapshot)) {
    if (!name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..')) {
      throw new Error(`Ruta no válida: ${name}`);
    }
    if (typeof hash !== 'string' || !hash) throw new Error(`Huella no válida: ${name}`);
  }
}

/** Snapshots map relative file paths to content hashes. null baseline = first sync.
 * Planning never touches disk or network. Deletion actions represent recoverable trash; the executor must check its baseline.
 */
export function planSync(local, remote, baseline = null) {
  [local, remote, baseline ?? {}].forEach(validate);
  const actions = [];
  const names = [...new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(baseline ?? {})])].sort();
  for (const name of names) {
    const l = local[name], r = remote[name], b = baseline?.[name];
    if (l === r) continue;
    let type;
    if (baseline === null || b === undefined) {
      type = l === undefined ? 'download' : r === undefined ? 'upload' : 'conflict';
    } else if (l === b) {
      type = r === undefined ? 'delete-local' : 'download';
    } else if (r === b) {
      type = l === undefined ? 'delete-remote' : 'upload';
    } else {
      type = 'conflict';
    }
    actions.push({ path: name, type, recoverable: type.startsWith('delete-'), expected: { local: l ?? null, remote: r ?? null } });
  }
  return actions;
}
