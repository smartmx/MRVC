/**
 * .project (Eclipse CDT project description) read/write.
 */
import * as fs from 'fs';
import * as path from 'path';
import { XElement, parseXml, serializeXml } from './xml';
import { makeLocationUri, resolveLocationUri } from './macros';

export interface LinkedResource {
  name: string;
  type: number; // 2 = folder
  /** raw location or locationURI, e.g. PARENT-1-PROJECT_LOC/SRC/Ld */
  locationUri: string;
  /** resolved absolute path */
  location: string;
  element: XElement;
}

export interface MrsProjectFile {
  root: XElement;
  name: string;
  natures: string[];
  linkedResources: LinkedResource[];
  raw: string;
}

export function readProjectFile(projectRoot: string): MrsProjectFile {
  const raw = fs.readFileSync(projectRoot + '/.project', 'utf-8');
  const root = parseXml(raw);
  const pd = root.child('projectDescription');
  if (!pd) {
    throw new Error('.project: <projectDescription> not found');
  }
  const name = pd.child('name')?.text ?? '';
  const natures =
    pd
      .child('natures')
      ?.childrenNamed('nature')
      .map((n) => n.text) ?? [];

  const linkedResources: LinkedResource[] = [];
  const lr = pd.child('linkedResources');
  if (lr) {
    for (const link of lr.childrenNamed('link')) {
      const lname = link.child('name')?.text ?? '';
      const ltype = Number(link.child('type')?.text ?? '2');
      const locEl = link.child('location') ?? link.child('locationURI');
      const uri = locEl?.text ?? '';
      linkedResources.push({
        name: lname,
        type: ltype,
        locationUri: uri,
        location: resolveLocationUri(projectRoot, uri),
        element: link,
      });
    }
  }
  const result: MrsProjectFile = { root, name, natures, linkedResources, raw };
  // EVT trees often ship stale absolute linked paths from the packager's
  // machine; repair them (like MRS2's rewriteLinkedFolders) on first open.
  repairLinkedResources(projectRoot, result);
  return result;
}

/** Build the linked-folder name -> absolute target map. */
export function linkedFolderMap(p: MrsProjectFile): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of p.linkedResources) {
    if (l.type === 2) {
      m.set(l.name, l.location);
    }
  }
  return m;
}

/**
 * Append a linked folder to .project (in place) and save.
 * `target` may be outside the workspace; it will be expressed with
 * PARENT-N-PROJECT_LOC when possible.
 */
export function addLinkedFolder(projectRoot: string, name: string, target: string): LinkedResource {
  const p = readProjectFile(projectRoot);
  const existing = p.linkedResources.find((l) => l.name === name);
  if (existing) {
    throw new Error(`A linked resource named "${name}" already exists`);
  }
  const pd = p.root.child('projectDescription')!;
  let lr = pd.child('linkedResources');
  if (!lr) {
    lr = new XElement('linkedResources');
    const anchor = pd.child('filteredResources');
    if (anchor) {
      const idx = pd.children.indexOf(anchor);
      pd.children.splice(idx, 0, lr);
      lr.parent = pd;
    } else {
      pd.append(lr);
    }
  }
  const link = new XElement('link');
  link.append(new XElement('name')).text = name;
  link.append(new XElement('type')).text = '2';
  const loc = new XElement('locationURI');
  loc.text = makeLocationUri(projectRoot, target);
  link.append(loc);
  lr.append(link);
  saveProjectFile(projectRoot, p);
  return {
    name,
    type: 2,
    locationUri: loc.text,
    location: resolveLocationUri(projectRoot, loc.text),
    element: link,
  };
}

export function removeLinkedFolder(projectRoot: string, name: string): void {
  const p = readProjectFile(projectRoot);
  const pd = p.root.child('projectDescription')!;
  const lr = pd.child('linkedResources');
  if (!lr) return;
  const link = lr.childrenNamed('link').find((l) => l.child('name')?.text === name);
  if (!link) return;
  lr.removeChild(link);
  if (!lr.children.length) {
    pd.removeChild(lr);
  }
  saveProjectFile(projectRoot, p);
}

export function saveProjectFile(projectRoot: string, p: MrsProjectFile): void {
  fs.writeFileSync(projectRoot + '/.project', serializeXml(p.root), 'utf-8');
}

/**
 * Repair linked resources whose target does not exist on this machine.
 * EVT packages often ship .project files with absolute paths from the
 * packager's machine (e.g. E:/a_QingHeng/.../EXAM/SRC/StdPeriphDriver).
 * MRS2 rewrites such links when opening a project; we do the same: search
 * the stale path's trailing segments against the project's ancestors and,
 * when a match is found, rewrite the link as a portable
 * PARENT-N-PROJECT_LOC URI. Returns the number of repaired links.
 */
export function repairLinkedResources(projectRoot: string, p: MrsProjectFile): number {
  let repaired = 0;
  for (const link of p.linkedResources) {
    if (link.type !== 2 || fs.existsSync(link.location)) continue;
    const staleSegs = toPosixParts(link.location);
    if (staleSegs.length < 2) continue;
    let fixed: string | null = null;
    // closest ancestor wins (the tree the project actually lives in), then
    // most specific trailing path — otherwise a stale EVT path can match a
    // nested leftover copy of the same EVT instead of the real workspace
    search: for (let level = 0; level <= 6; level++) {
      let base = projectRoot;
      for (let i = 0; i < level; i++) base = path.dirname(base);
      for (let tail = staleSegs.length - 1; tail >= 1; tail--) {
        const suffix = staleSegs.slice(staleSegs.length - tail);
        const cand = path.join(base, ...suffix);
        if (fs.existsSync(cand)) {
          fixed = path.normalize(cand);
          break search;
        }
      }
    }
    if (!fixed) continue;
    const uri = makeLocationUri(projectRoot, fixed);
    const locEl = link.element.child('location') ?? link.element.child('locationURI');
    if (locEl) {
      locEl.text = uri;
    } else {
      continue;
    }
    link.locationUri = uri;
    link.location = fixed;
    repaired++;
  }
  if (repaired > 0) {
    saveProjectFile(projectRoot, p);
  }
  return repaired;
}

function toPosixParts(p: string): string[] {
  return p.split('\\').join('/').split('/').filter((s) => s.length > 0 && !/^[A-Za-z]:$/.test(s) && s !== '.');
}
