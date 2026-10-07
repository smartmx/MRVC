/**
 * .project (Eclipse CDT project description) read/write.
 */
import * as fs from 'fs';
import * as path from 'path';
import { XElement, parseXml, serializeXml } from './xml';
import { makeLocationUri, resolveLocationUri } from './macros';
import { readTemplate, templateSet } from './templateFile';

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
      const ltype = Number(link.child('type')?.text ?? '2') || 2;
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

/**
 * Re-point an existing linked folder to a new target — MRS2
 * changelinkedFolderPath semantics: the link NAME (and every .cproject
 * reference keyed by it) stays untouched, only the location changes, so
 * build configuration keeps resolving through the same logic name.
 * Returns the updated resource, or undefined when the link name does not
 * exist. The new target does not have to exist (MRS2 allows it; the tree
 * renders unresolved links without collapsing).
 */
export function changeLinkedFolderTarget(projectRoot: string, name: string, newTarget: string): LinkedResource | undefined {
  const p = readProjectFile(projectRoot);
  const pd = p.root.child('projectDescription')!;
  const lr = pd.child('linkedResources');
  if (!lr) return undefined;
  const link = lr.childrenNamed('link').find((l) => l.child('name')?.text === name);
  if (!link) return undefined;
  const locEl = link.child('location') ?? link.child('locationURI');
  if (!locEl) return undefined;
  const uri = makeLocationUri(projectRoot, newTarget);
  // MRS1-style <location> elements must become <locationURI> (the same
  // conversion repairLinkedResources applies) — a plain relative <location>
  // would resolve against the wrong base
  locEl.name = 'locationURI';
  locEl.text = uri;
  saveProjectFile(projectRoot, p);
  return { name: link.child('name')?.text ?? name, type: 2, locationUri: uri, location: resolveLocationUri(projectRoot, uri), element: link };
}

export function saveProjectFile(projectRoot: string, p: MrsProjectFile): void {
  fs.writeFileSync(projectRoot + '/.project', serializeXml(p.root), 'utf-8');
}

/**
 * Logically-removed resources — the `.project filteredResources` filter
 * list (Eclipse standard, same storage MRS2 uses for its Remove command):
 * entries are hidden from the project tree AND excluded from the build
 * scan, while the files stay on disk. Structure per entry:
 *   <filter><name>parent-logic-path</name><type>6|10</type><matcher>
 *   <id>org.eclipse.ui.ide.multiFilter</id>
 *   <arguments>1.0-name-matches-false-false-<basename></arguments></matcher>
 */
export interface RemovedResource {
  /** parent folder's workspace-relative logic path ('' = project root) */
  parentLogic: string;
  /** resource basename */
  name: string;
  isFolder: boolean;
}

const MULTI_FILTER_ID = 'org.eclipse.ui.ide.multiFilter';

function filteredListElement(projectRoot: string, create: boolean): { file: MrsProjectFile; pd: XElement; list: XElement } | undefined {
  const file = readProjectFile(projectRoot);
  const pd = file.root.child('projectDescription')!;
  let list = pd.child('filteredResources');
  if (!list) {
    if (!create) return undefined;
    list = new XElement('filteredResources');
    const anchor = pd.child('linkedResources');
    if (anchor) {
      const idx = pd.children.indexOf(anchor);
      pd.children.splice(idx + 1, 0, list);
      list.parent = pd;
    } else {
      pd.append(list);
    }
  }
  return { file, pd, list };
}

/** all logically-removed resources of a project */
export function listRemovedResources(projectRoot: string): RemovedResource[] {
  const holder = filteredListElement(projectRoot, false);
  if (!holder) return [];
  const out: RemovedResource[] = [];
  for (const filter of holder.list.childrenNamed('filter')) {
    const nameEl = filter.child('name');
    const typeEl = filter.child('type');
    const matcher = filter.child('matcher');
    const args = matcher?.child('arguments')?.text ?? '';
    const m = args.match(/^1\.0-name-matches-false-false-(.*)$/s);
    if (!nameEl || !typeEl || !m) continue; // foreign filter — leave untouched
    out.push({
      parentLogic: nameEl.text,
      name: m[1],
      isFolder: typeEl.text === '10' || typeEl.text === '26',
    });
  }
  return out;
}

/** hide a resource from the tree and the build scan (idempotent) */
export function appendRemovedResource(projectRoot: string, parentLogic: string, name: string, isFolder: boolean): void {
  const existing = listRemovedResources(projectRoot);
  if (existing.some((r) => r.parentLogic === parentLogic && r.name === name && r.isFolder === isFolder)) return;
  const holder = filteredListElement(projectRoot, true)!;
  const filter = new XElement('filter');
  filter.append(new XElement('name')).text = parentLogic;
  filter.append(new XElement('type')).text = isFolder ? '10' : '6';
  const matcher = new XElement('matcher');
  matcher.append(new XElement('id')).text = MULTI_FILTER_ID;
  matcher.append(new XElement('arguments')).text = `1.0-name-matches-false-false-${name}`;
  filter.append(matcher);
  holder.list.append(filter);
  saveProjectFile(projectRoot, holder.file);
}

/** make a removed resource visible/active again (no-op when absent) */
export function clearRemovedResource(projectRoot: string, parentLogic: string, name: string, isFolder: boolean): void {
  const holder = filteredListElement(projectRoot, false);
  if (!holder) return;
  let removed = false;
  for (const filter of [...holder.list.childrenNamed('filter')]) {
    const parent = filter.child('name')?.text;
    const type = filter.child('type')?.text;
    const args = filter.child('matcher')?.child('arguments')?.text ?? '';
    const m = args.match(/^1\.0-name-matches-false-false-(.*)$/s);
    if (parent === parentLogic && m && m[1] === name && (type === '10' || type === '26') === isFolder) {
      holder.list.removeChild(filter);
      removed = true;
    }
  }
  if (removed) {
    if (!holder.list.children.length) holder.pd.removeChild(holder.list);
    saveProjectFile(projectRoot, holder.file);
  }
}

const NATURE_CXX = 'org.eclipse.cdt.core.cxxnature';

/**
 * Toggle the CDT C++ nature — the "C++ project" switch MRS2/CDT key off in
 * `.project <natures>`: only C++ projects show the C++ compiler/linker
 * property pages, and MRVC's scanner/build pick .cpp sources for them.
 * The nature is inserted right after cnature; the file stays MRS2-openable.
 */
export function setCppNature(projectRoot: string, on: boolean): void {
  const p = readProjectFile(projectRoot);
  const has = p.natures.includes(NATURE_CXX);
  if (on === has) return;
  const natures = p.root.child('projectDescription')?.child('natures');
  if (!natures) {
    throw new Error('.project: <natures> not found');
  }
  const items = natures.childrenNamed('nature');
  if (on) {
    const el = new XElement('nature');
    el.text = NATURE_CXX;
    const cnature = items.find((n) => n.text === 'org.eclipse.cdt.core.cnature');
    if (cnature) {
      natures.insertChild(el, natures.children.indexOf(cnature) + 1);
    } else {
      natures.append(el);
    }
  } else {
    const el = items.find((n) => n.text === NATURE_CXX);
    if (el) natures.removeChild(el);
  }
  saveProjectFile(projectRoot, p);
}

/**
 * Rename a project the way MRS2 does — the display name only, the directory
 * stays put (which keeps .wvsln member paths and PARENT-N linked folders
 * valid):
 *   1. .project <projectDescription><name> = newName
 *   2. every *.wvproj is deleted and an empty `<newName>.wvproj` written
 *      (the marker/state file embeds the old name and is rebuilt by the IDE)
 *   3. a `.launch` debug configuration, if present, gets its
 *      PROGRAM_NAME (…\Old.elf → …\New.elf), PROJECT_ATTR and
 *      MAPPED_RESOURCE_PATHS (/Old → /New) updated and the file renamed to
 *      `<newName>.launch`
 *   4. `.template` Target Path filename segment (obj\Old.hex → obj\New.hex),
 *      skipped for slave kernels (`isSlave`) whose Target Path belongs to
 *      the master build
 */
export function renameProject(projectRoot: string, newName: string, opts: { isSlave?: boolean } = {}): void {
  // newName lands in file names (.wvproj/.launch) and make targets — reject
  // illegal filename characters and whitespace up front
  if (!newName || !newName.trim() || /[\\/:*?"<>|\s]/.test(newName)) {
    throw new Error(`Invalid project name "${newName}" (no spaces or \\ / : * ? " < > |)`);
  }
  // 1. .project display name — read only, nothing written yet
  const p = readProjectFile(projectRoot);
  const nameEl = p.root.child('projectDescription')?.child('name');
  if (!nameEl) {
    throw new Error('.project: <projectDescription><name> not found');
  }
  const oldName = nameEl.text;
  nameEl.text = newName;

  // 2/3. .launch edits are prepared IN MEMORY before anything is written:
  // a failure here (locked or broken .launch) must abort while the old
  // name is still on disk — otherwise a retry sees oldName === newName
  // and can never match/fix the .launch's MAPPED_RESOURCE_PATHS again
  const oldLaunch = fs.readdirSync(projectRoot).find((f) => f.toLowerCase().endsWith('.launch'));
  let launchDom: XElement | undefined;
  if (oldLaunch) {
    launchDom = parseXml(fs.readFileSync(path.join(projectRoot, oldLaunch), 'utf-8'));
    for (const attr of launchDom.findAll((e) => e.name === 'stringAttribute')) {
      const key = attr.attr('key');
      if (key === 'org.eclipse.cdt.launch.PROGRAM_NAME') {
        const v = attr.attr('value');
        if (v) {
          // swap the basename, keep the artifact's REAL extension — the
          // old (\ .elf)$ anchor left .axf (and any non-elf artifact)
          // projects pointing at the old executable forever
          const sep = Math.max(v.lastIndexOf('\\'), v.lastIndexOf('/'));
          const base = v.slice(sep + 1);
          const dot = base.lastIndexOf('.');
          if (dot > 0) attr.setAttr('value', (sep >= 0 ? v.slice(0, sep + 1) : '') + newName + base.slice(dot));
        }
      } else if (key === 'org.eclipse.cdt.launch.PROJECT_ATTR') {
        attr.setAttr('value', newName);
      }
    }
    for (const list of launchDom.findAll((e) => e.name === 'listAttribute')) {
      if (list.attr('key') !== 'org.eclipse.debug.core.MAPPED_RESOURCE_PATHS') continue;
      for (const le of list.findAll((e) => e.name === 'listEntry')) {
        const v = le.attr('value');
        // replace only the leading project segment, keep sub-paths intact;
        // real .launch files use the bare form ("Proj"), CDT also allows "/Proj"
        if (v) {
          const slashed = v.startsWith('/');
          const body = slashed ? v.slice(1) : v;
          const slash = body.indexOf('/');
          const head = slash >= 0 ? body.slice(0, slash) : body;
          if (head === oldName) {
            le.setAttr('value', (slashed ? '/' : '') + newName + (slash >= 0 ? body.slice(slash) : ''));
          }
        }
      }
    }
  }

  // ---- all reads and in-memory edits done — now write ----
  // .launch first: it is the write most likely to fail (AV lock on the old
  // file), and while .project still carries the OLD name a failure here
  // leaves the tree fully consistent — a retry re-reads oldName and heals
  // everything. Writing .project first would flip the commit point: a
  // failed .launch write then leaves MAPPED_RESOURCE_PATHS pointing at the
  // old project forever (the retry can no longer match the old name).
  if (oldLaunch && launchDom) {
    fs.writeFileSync(path.join(projectRoot, oldLaunch), serializeXml(launchDom), 'utf-8');
    fs.renameSync(path.join(projectRoot, oldLaunch), path.join(projectRoot, newName + '.launch'));
  }

  saveProjectFile(projectRoot, p);

  // reset .wvproj state under the new name
  for (const ent of fs.readdirSync(projectRoot)) {
    if (ent.toLowerCase().endsWith('.wvproj')) {
      fs.rmSync(path.join(projectRoot, ent), { force: true });
    }
  }
  fs.writeFileSync(path.join(projectRoot, newName + '.wvproj'), '', 'utf-8');

  // 4. .template flash target
  if (!opts.isSlave) {
    const tpl = readTemplate(projectRoot);
    const tp = tpl.values['Target Path'];
    if (tp) {
      const m = tp.match(/^(.+[\\/]).+?(\.[^\\/]+)$/); // dir + basename + extension
      if (m) {
        templateSet(projectRoot, 'Target Path', m[1] + newName + m[2]);
      }
    }
  }
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
      // a variable URI only belongs in <locationURI>; a plain <location>
      // element (MRS1-style absolute path) must be converted, not reused —
      // otherwise Eclipse/CDT resolves the link as a relative filesystem
      // path and MRS2 shows the folder as broken
      locEl.name = 'locationURI';
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
