/**
 * The logic path a TREE ROW keys on (exclude / flag / removed-resource /
 * single-file-compile state). Lives in its own module with NO vscode-class
 * dependencies — the shape is structural (`import type` semantics: the real
 * TreeNode and the command layers' loose casts both satisfy it) — so test
 * suites with minimal vscode stubs can load consumers (tasks.js) without
 * pulling TreeItem-derived classes in.
 */
import * as path from 'path';
import { isOutsideRelPath } from '../core/macros';

export interface LogicKeyable {
  fsPath?: string;
  project?: {
    projectFile: { linkedResources: Array<{ name: string; type: number; location: string }> };
    logicPathOf(f: string): string | undefined;
  };
  nodeType?: string;
  linkedName?: string;
}

/**
 * A linkedFolder row and EVERYTHING under it keys on the LINK's logic root —
 * carried down by `linkedName` — plus the target-relative path. Relying on
 * `logicPathOf(fsPath)` alone resolves a link that lives INSIDE the project
 * root to the physical directory name (Alias -> Shared), so a child exclude
 * wrote the physical token while the link logic tree kept building, and a
 * `parentLogic: "Alias"` removal never matched the expanded children
 * (round1/round2/round3 P2). Rows outside any link have no linkedName and
 * fall through to logicPathOf as before.
 */
export function nodeLogicPath(el: LogicKeyable): string | undefined {
  if (!el.fsPath || !el.project) return undefined;
  if (el.linkedName) {
    if (el.nodeType === 'linkedFolder') return el.linkedName;
    const loc = el.project.projectFile.linkedResources.find((l) => l.name === el.linkedName)?.location;
    if (loc) {
      const rel = path.relative(loc, el.fsPath);
      if (rel && !isOutsideRelPath(rel)) {
        return [el.linkedName, ...rel.split(path.sep)].join('/');
      }
    }
    return el.linkedName;
  }
  return el.project.logicPathOf(el.fsPath);
}
