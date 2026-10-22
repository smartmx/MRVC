/**
 * C / C++ project-type conversion — the pair of writes behind the
 * "switch project type" command:
 *
 *   1. the `.project` nature. MRS2's own typing reads exactly
 *      `org.eclipse.cdt.core.ccnature` (its getEclipseProperties helper) —
 *      the same key CDT uses; "cxxnature" is not a real id.
 *   2. when converting TO C++, the `.cproject` option mirror. A C project's
 *      .cproject carries only a handful of cpp.* options, so a nature-only
 *      toggle builds C++ with an empty option set — no include paths, no
 *      linker script (verified with a real build: the link dies on a bare
 *      "Link.ld"). MRS2 reads the cpp.* set for a C++ project, so the values
 *      must live there.
 *
 * Converting back to C removes the `<inputType>` the conversion added — MRS2's
 * own C projects carry input types for assembler / c.compiler / c.linker only,
 * so a round trip must not leave a fourth one behind. The mirrored cpp.* option
 * VALUES stay: real C++ projects maintain both option sets and the values are
 * simply ignored while the nature says C (removing them would throw away
 * settings the project may need again).
 *
 * Known scope: only the FIRST `<cconfiguration>` of a .cproject is modeled, so
 * a multi-configuration project converts its first configuration only. No
 * multi-configuration C project exists in the sampled EVT trees (1,777 C
 * projects, all single-configuration); MRS2's own C++ projects are obj+dbg
 * because MRS2 wrote both from the start.
 */
import { Cproject } from './cproject';
import { hasLegacyCppNature, setCppNature } from './projectFile';

/**
 * Switch the project type; returns how many C options were mirrored into the
 * C++ set (0 when switching to C or when there was nothing to mirror).
 *
 * Contract of the C++ direction — the mirror is a COVERING write: every C
 * option value is copied onto its cpp twin, overwriting what the twin held.
 * That is only correct for a project whose cpp set is empty or residual: a C
 * project being converted, or one repaired by {@link migrateLegacyCppNature}.
 * A NATIVE MRS2 C++ project keeps two deliberately different sets — all 952
 * real C++ projects sampled across the CH585/CH592/CH587 EVT trees have c/cpp
 * twins that differ (include paths, std, picolibc, defs) — so this must never
 * be called on one just to "sync" it.
 *
 * Do not turn that into a guard keyed on the project already reading as C++:
 * the projects MRVC <= 0.2.2 converted read as C++ (the fake id is accepted on
 * read) while their cpp set is still empty, and they need exactly this mirror.
 * The safe call sites are the type switch (passes `!isCpp`) and the legacy
 * migration (fires only on the mis-spelled nature).
 */
export function setProjectCpp(projectRoot: string, on: boolean): { mirrored: number } {
  setCppNature(projectRoot, on);
  const cp = Cproject.load(projectRoot);
  if (!on) {
    if (cp.removeCppCompilerInputType()) cp.save();
    return { mirrored: 0 };
  }
  const mirrored = cp.ensureCppOptionsFromC();
  // MRS2's C++ projects also carry the C++ compiler's <inputType>; a project
  // converted to C++ must look like one when MRS2 opens it
  const inputTypeAdded = cp.ensureCppCompilerInputType();
  if (mirrored || inputTypeAdded) cp.save();
  return { mirrored };
}

/**
 * One-time repair for projects converted by MRVC <= 0.2.2: they carry the
 * mis-spelled legacy nature — MRS2 never recognized it (so the project reads
 * as C there) while MRVC reads it as C++ — and their C++ option set was never
 * filled. Normalizes the nature AND mirrors the options, so clicking "switch
 * type" once is not needed to reach a sane state. Returns true when the
 * project carried the legacy marker (and was repaired).
 */
export function migrateLegacyCppNature(projectRoot: string): boolean {
  if (!hasLegacyCppNature(projectRoot)) return false;
  setProjectCpp(projectRoot, true);
  return true;
}
