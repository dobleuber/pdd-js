export interface ManifestDiff {
  changed: string[];
  added: string[];
  removed: string[];
}

export function diffManifests(expected: Record<string, string>, actual: Record<string, string>): ManifestDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [name, hash] of Object.entries(expected)) {
    if (!(name in actual)) removed.push(name);
    else if (actual[name] !== hash) changed.push(name);
  }
  for (const name of Object.keys(actual)) if (!(name in expected)) added.push(name);
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

export function isEmptyDiff(d: ManifestDiff): boolean {
  return d.changed.length === 0 && d.added.length === 0 && d.removed.length === 0;
}
