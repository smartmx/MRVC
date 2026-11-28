/*
 * Output-directory maintenance tests — the FILE-LEVEL claimed-set model
 * (review round7): only paths the build model claims are ever deleted, the
 * generated makefile is the ownership anchor, same resolved directories are
 * grouped before validation, and execution never uses a recursive rm.
 * Run: node tools/output-test.js
 */
const path = require('path');
const fs = require('fs');
const { clearOutputDir, removeOutputDir, deleteConfigOutputs } = require('../out/core/output.js');
const { imageKeepNames, buildOutputFiles, generateMakefiles, legacyPrintSizeCleanOverride } = require('../out/core/makefile.js');
const { Cproject } = require('../out/core/cproject.js');
const { snapshotExistingOutputs, recordBuildOutputs, recordWrittenFiles, outputHistoryPath, loadDirHistory, mayReclaim, updateHistory, withHistoryLock, ensureMrvcGitignoreEntries } = require('../out/core/outputHistory.js');
const { encodeArtifact, decodeArtifact } = require('../out/core/platformEncoding.js');
const iconv = require('iconv-lite');

const scratch = path.join(path.dirname(__dirname), '.scratch', 'output');
let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  << ${extra ?? ''}`}`);
  if (!cond) failures++;
};
const readText = (p) => fs.readFileSync(p, 'utf8');
const safeRm = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  } catch {
    // SMB share handle release lag — next run cleans scratch
  }
};

safeRm(scratch);

const GENERATED_HEADER = '# Automatically-generated file. Do not edit!';
/** A realistic claimed output set (what makefile.buildOutputFiles returns
 *  for a project with one Debug/ source) — mrvc_flash.cfg is claimed but the
 *  fixtures do not write it (absent claimed paths are simply skipped). */
const CLAIMED = ['makefile', 'sources.mk', 'objects.mk', 'subdir.mk', 'Debug/subdir.mk', 'Debug/main.o', 'Debug/main.d', 'mrvc_flash.cfg'];
/** write a directory that looks like a finished build: generated makefile
 *  (header + whole-word target mention) + makefile family + objects + deps
 *  + product + images. 10 claimed files exist on disk (7 + 3 products). */
function buildFixture(dir, target) {
  fs.mkdirSync(path.join(dir, 'Debug'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'makefile'), `${GENERATED_HEADER}\n\nRM := rm -rf\n\nall: ${target}.elf\n\nmain-build: ${target}.elf\n${target}.elf: Debug/main.o\n`);
  for (const f of ['sources.mk', 'objects.mk', 'subdir.mk']) fs.writeFileSync(path.join(dir, f), `${GENERATED_HEADER}\nx\n`);
  fs.writeFileSync(path.join(dir, 'Debug', 'subdir.mk'), `${GENERATED_HEADER}\nx\n`);
  fs.writeFileSync(path.join(dir, 'Debug', 'main.o'), 'x');
  fs.writeFileSync(path.join(dir, 'Debug', 'main.d'), 'x');
  fs.writeFileSync(path.join(dir, `${target}.elf`), 'x');
  fs.writeFileSync(path.join(dir, `${target}.hex`), 'x');
  fs.writeFileSync(path.join(dir, `${target}.bin`), 'x');
  return [...CLAIMED, `${target}.elf`, `${target}.hex`, `${target}.bin`];
}

fs.mkdirSync(scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, 'vendor-input.a'), 'vendor-archive\n'); // restore source for the input probes
fs.writeFileSync(path.join(scratch, 'factory-image.bin'), 'factory-image\n');

// build a fake project: root with src/ + obj output dir
const root = path.join(scratch, 'LED');
const obj = path.join(root, 'obj');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'main.c'), 'int main(void){return 0;}\n');

// 1 (review round7 P1-A): the claimed-set clear deletes ONLY what the build
//    writes — a vendor .a linked through USER_OBJS and stored in obj/
//    survives BOTH deletion modes
let claimed = buildFixture(obj, 'LED');
fs.copyFileSync(path.join(scratch, 'vendor-input.a'), path.join(obj, 'vendor.a'));
const r1 = clearOutputDir(root, obj, ['LED.hex', 'LED.bin'], 'LED', claimed);
let left = fs.readdirSync(obj).sort().join(',');
check('claimed-set clear deletes exactly the claimed files (8)', r1.removed === 8, `removed=${r1.removed} left=${left}`);
check('the vendor .a input SURVIVES the keep-clear (hash unchanged)', readText(path.join(obj, 'vendor.a')) === 'vendor-archive\n', left);
check('the kept images survive', fs.existsSync(path.join(obj, 'LED.hex')) && fs.existsSync(path.join(obj, 'LED.bin')));
check('the survivors are reported', r1.kept.includes('vendor.a'), JSON.stringify(r1.kept));
check('clearOutputDir leaves unrelated dirs untouched', fs.existsSync(path.join(root, 'src', 'main.c')));

// 1b: whole-dir remove REFUSES while the input is inside — and the
//     validate-first order must not have deleted anything before refusing
const vendorSha = fs.readFileSync(path.join(obj, 'vendor.a'));
let threw = '';
try {
  removeOutputDir(root, obj, 'LED', buildFixture(obj, 'LED'));
} catch (e) {
  threw = String(e.message || e);
}
check('remove mode with an unclaimed input refuses', threw.includes('not written by this build'), threw.slice(0, 160));
check('the refusal deleted NOTHING first (makefile still there)', fs.existsSync(path.join(obj, 'makefile')));
check('the vendor .a survived the refusal', fs.readFileSync(path.join(obj, 'vendor.a')).equals(vendorSha));
fs.rmSync(path.join(obj, 'vendor.a'), { force: true });
removeOutputDir(root, obj, 'LED', buildFixture(obj, 'LED'));
check('remove mode removes the directory once inputs are gone', !fs.existsSync(obj));

// 2 (review round8 test fix): keep-list matches production `imageKeepNames('LED', '')`
//    while an extra case-differing `LED.HEX` survives untouched on Linux
//    (and folds on Windows)
claimed = buildFixture(obj, 'LED');
fs.writeFileSync(path.join(obj, 'LED.HEX'), 'upper-image\n');
const r2 = clearOutputDir(root, obj, imageKeepNames('LED', ''), 'LED', claimed);
check(
  'case-differing image survives alongside kept production images',
  r2.removed === 8 &&
    fs.existsSync(path.join(obj, 'LED.bin')) &&
    fs.existsSync(path.join(obj, 'LED.hex')) &&
    readText(path.join(obj, 'LED.HEX')) === 'upper-image\n',
  `removed=${r2.removed} left=${fs.readdirSync(obj).sort().join(',')}`
);
fs.rmSync(path.join(obj, 'LED.HEX'), { force: true });

// 3: a zero-change keep re-run (only kept images remain) touches nothing
buildFixture(obj, 'LED');
clearOutputDir(root, obj, ['LED.hex', 'LED.bin'], 'LED', claimed);
const r3 = clearOutputDir(root, obj, ['LED.hex', 'LED.bin'], 'LED', claimed);
check('keep re-run right after itself is a zero-change success', r3.removed === 0 && fs.existsSync(path.join(obj, 'LED.hex')), JSON.stringify(r3));

// 4: whole-dir remove after re-materializing the build (the keep-clear
//    removed the generated makefile, so a plain images-only remove refuses —
//    a rebuild or this fixture rewrite restores the anchor)
buildFixture(obj, 'LED');
removeOutputDir(root, obj, 'LED', buildFixture(obj, 'LED'));
check('removeOutputDir removes the directory itself', !fs.existsSync(obj));

// 5: containment guard: project root and outside dirs are refused
threw = '';
try {
  clearOutputDir(root, root, [], 'LED', CLAIMED);
} catch (e) {
  threw = String(e.message || e);
}
check('guard: clearing the project root is refused', threw.includes('outside the project root'), threw.slice(0, 120));
fs.mkdirSync(path.join(scratch, 'elsewhere'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'elsewhere', 'keep.txt'), 'x');
threw = '';
try {
  removeOutputDir(root, path.join(scratch, 'elsewhere'), 'LED', CLAIMED);
} catch (e) {
  threw = String(e.message || e);
}
check('guard: an outside directory (existing) is refused', threw.includes('outside the project root'), threw.slice(0, 120));
check('guard: nothing outside was touched', fs.existsSync(path.join(scratch, 'elsewhere', 'keep.txt')));

// 6 (0.3.6): the batch — every configuration's output dir in one pass, keep
//    lists per configuration, missing dirs skipped
const root2 = path.join(scratch, 'TWO');
fs.mkdirSync(root2, { recursive: true });
{
  const objA = path.join(root2, 'obj');
  const objB = path.join(root2, 'objDbg');
  const claimA = buildFixture(objA, 'TWO');
  const claimB = buildFixture(objB, 'TWO_DBG');
  const keepRes = deleteConfigOutputs(root2, [
    { dir: objA, target: 'TWO', claimed: claimA, keep: ['TWO.hex', 'TWO.bin'] },
    { dir: objB, target: 'TWO_DBG', claimed: claimB, keep: ['TWO_DBG.hex', 'TWO_DBG.bin'] },
  ]);
  check('allConfigs: two configs cleared (8 + 8 claimed files)', keepRes.files === 16, JSON.stringify(keepRes));
  check(
    'allConfigs: each config keeps its OWN hex/bin',
    fs.readdirSync(objA).sort().join(',') === 'TWO.bin,TWO.hex' && fs.readdirSync(objB).sort().join(',') === 'TWO_DBG.bin,TWO_DBG.hex'
  );
  const dirsRes = deleteConfigOutputs(root2, [
    { dir: objA, target: 'TWO', claimed: buildFixture(objA, 'TWO') },
    { dir: objB, target: 'TWO_DBG', claimed: buildFixture(objB, 'TWO_DBG') },
    { dir: path.join(root2, 'objNever'), target: 'NEVER', claimed: CLAIMED }, // never built — skipped silently
  ]);
  check('allConfigs: dirs variant removes both, missing config skipped', dirsRes.dirs === 2 && dirsRes.files === 20, JSON.stringify(dirsRes));
  check('allConfigs: output dirs gone', !fs.existsSync(objA) && !fs.existsSync(objB));
  threw = '';
  try {
    deleteConfigOutputs(root2, [{ dir: root2, target: 'TWO', claimed: CLAIMED }]);
  } catch (e) {
    threw = String(e.message || e);
  }
  check('allConfigs: a project-root spec is refused (containment guard)', threw.includes('outside the project root'), threw.slice(0, 120));
}

// 7: ownership / claimed-set refusals — every refusal leaves the files
{
  const mk = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  // a pure source directory: nothing claimed exists → loud refusal
  const srcDir = mk(path.join(root2, 'SRC'));
  fs.writeFileSync(path.join(srcDir, 'main.c'), 'int main(void){return 0;}\n');
  fs.writeFileSync(path.join(srcDir, 'app.h'), '#pragma once\n');
  const beforeSrc = fs.readFileSync(path.join(srcDir, 'main.c'));
  threw = '';
  try {
    deleteConfigOutputs(root2, [{ dir: srcDir, target: 'app', claimed: CLAIMED, keep: ['x.hex'] }]);
  } catch (e) {
    threw = String(e.message || e);
  }
  check('proof: clearing a pure source directory is refused (nothing claimed matches)', threw.includes('none of the'), threw.slice(0, 140));
  threw = '';
  try {
    deleteConfigOutputs(root2, [{ dir: srcDir, target: 'app', claimed: CLAIMED }]);
  } catch (e) {
    threw = String(e.message || e);
  }
  check('proof: removing a pure source directory is refused (unclaimed files inside)', threw.includes('not written by this build'), threw.slice(0, 140));
  check('proof: the sources survived both refusals byte-identical', fs.readFileSync(path.join(srcDir, 'main.c')).equals(beforeSrc) && fs.existsSync(path.join(srcDir, 'app.h')));

  // a NON-generated makefile among real sources: the claimed makefile matches
  // but the ownership anchor refuses — nothing is deleted (keep mode reaches
  // the ownership gate; remove mode refuses earlier on the unclaimed sources)
  fs.writeFileSync(path.join(srcDir, 'makefile'), 'all:\n\t@echo hand-written\n');
  threw = '';
  try {
    deleteConfigOutputs(root2, [{ dir: srcDir, target: 'app', claimed: [...CLAIMED, 'main.o'], keep: ['x.hex'] }]);
  } catch (e) {
    threw = String(e.message || e);
  }
  check('proof: a hand-written makefile is not a generated build makefile', threw.includes('not a generated build makefile'), threw.slice(0, 160));
  check('proof: the mixed dir sources survived', fs.readFileSync(path.join(srcDir, 'main.c')).equals(beforeSrc));
  fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'sub', 'keep.c'), 'x');
  threw = '';
  try {
    deleteConfigOutputs(root2, [{ dir: srcDir, target: 'app', claimed: [...CLAIMED, 'sub/keep.o'], keep: ['x.hex'] }]);
  } catch (e) {
    threw = String(e.message || e);
  }
  check('proof: a nested source under one makefile is refused (same anchor)', threw.includes('not a generated build makefile'), threw.slice(0, 140));
  check('proof: the nested source survived', fs.existsSync(path.join(srcDir, 'sub', 'keep.c')));

  // a FILE carrying the configuration's name is not an output directory
  const fileTarget = path.join(root2, 'objfile');
  fs.writeFileSync(fileTarget, 'x');
  threw = '';
  try {
    deleteConfigOutputs(root2, [{ dir: fileTarget, target: 'app', claimed: CLAIMED }]);
  } catch (e) {
    threw = String(e.message || e);
  }
  check('proof: a FILE with the config name is refused (not a directory)', threw.includes('not a directory'), threw.slice(0, 120));
  check('proof: the file itself survived', fs.existsSync(fileTarget));
  fs.rmSync(fileTarget, { force: true });

  // (round3 P1) a factory flash IMAGE alone: keep-mode with the image KEPT
  // is a no-op success (it IS claimed); whole-dir remove still refuses —
  // there is no generated makefile to prove ownership
  const fwDir = mk(path.join(root2, 'firmware'));
  fs.copyFileSync(path.join(scratch, 'factory-image.bin'), path.join(fwDir, 'factory.bin'));
  const fwClaimed = ['makefile', 'sources.mk', 'objects.mk', 'factory.bin'];
  const fwKeep = deleteConfigOutputs(root2, [{ dir: fwDir, target: 'firmware', claimed: fwClaimed, keep: ['factory.bin'] }]);
  check('proof: image-only keep-clear with the image KEPT is a no-op success', fwKeep.files === 0 && readText(path.join(fwDir, 'factory.bin')) === 'factory-image\n', JSON.stringify(fwKeep));
  threw = '';
  try {
    deleteConfigOutputs(root2, [{ dir: fwDir, target: 'firmware', claimed: fwClaimed }]);
  } catch (e) {
    threw = String(e.message || e);
  }
  check('proof: image-only whole-dir delete is refused (no generated makefile)', threw.includes('no generated makefile'), threw.slice(0, 160));
  check('proof: the factory image survived', readText(path.join(fwDir, 'factory.bin')) === 'factory-image\n');
  fs.rmSync(fwDir, { recursive: true, force: true });

  // (round4 P1) a VENDOR static library alone — nothing claimed matches
  const vDir = mk(path.join(root2, 'libstore'));
  fs.writeFileSync(path.join(vDir, 'vendor.a'), 'vendor-archive\n');
  threw = '';
  try {
    deleteConfigOutputs(root2, [{ dir: vDir, target: 'projfix', claimed: ['makefile', 'sources.mk', 'projfix.a'], keep: ['x.hex'] }]);
  } catch (e) {
    threw = String(e.message || e);
  }
  check('proof: a vendor .a alone is refused (nothing this build writes)', threw.includes('none of the'), threw.slice(0, 140));
  check('proof: the vendor archive survived', readText(path.join(vDir, 'vendor.a')) === 'vendor-archive\n');

  // (round5 P1) a hand-written makefile BESIDE the stored library: the
  // claimed makefile matches but the ownership anchor refuses
  fs.writeFileSync(path.join(vDir, 'makefile'), 'all:\n\t@echo vendor build\n');
  threw = '';
  try {
    deleteConfigOutputs(root2, [{ dir: vDir, target: 'projfix', claimed: ['makefile', 'sources.mk', 'projfix.a'], keep: ['vendor.a'] }]);
  } catch (e) {
    threw = String(e.message || e);
  }
  check('proof: hand-written makefile + vendor.a keep-clear is refused', threw.includes('not a generated build makefile'), threw.slice(0, 160));
  threw = '';
  try {
    deleteConfigOutputs(root2, [{ dir: vDir, target: 'projfix', claimed: ['makefile', 'sources.mk', 'projfix.a'] }]);
  } catch (e) {
    threw = String(e.message || e);
  }
  check('proof: hand-written makefile + vendor.a whole-dir delete is refused', threw.includes('not written by this build'), threw.slice(0, 160));
  check('proof: the vendor archive survived both', readText(path.join(vDir, 'vendor.a')) === 'vendor-archive\n');

  // (round6 P1-A) a GENERATED-header makefile whose text only mentions the
  // target inside a longer word (application ⊃ app) is not ownership proof
  fs.writeFileSync(path.join(vDir, 'makefile'), `${GENERATED_HEADER}\n# application notes\nall: vendor.a\n`);
  threw = '';
  try {
    deleteConfigOutputs(root2, [{ dir: vDir, target: 'app', claimed: ['makefile'], keep: ['vendor.a'] }]);
  } catch (e) {
    threw = String(e.message || e);
  }
  check('proof: a comment containing a target-substring word is not ownership proof', threw.includes("not proven to be THIS build's output directory"), threw.slice(0, 160));
  check('proof: the vendor archive survived the comment probe', readText(path.join(vDir, 'vendor.a')) === 'vendor-archive\n');

  // the REAL build directory (generated header + whole-word mention) deletes,
  // and the vendor .a beside it STILL survives (round7 P1 — the same layout
  // the reviewer proved deletes real linker inputs)
  claimed = buildFixture(vDir, 'projfix');
  fs.writeFileSync(path.join(vDir, 'vendor.a'), 'vendor-archive\n');
  const realRes = deleteConfigOutputs(root2, [{ dir: vDir, target: 'projfix', claimed, keep: ['projfix.hex', 'projfix.bin'] }]);
  const leftV = fs.readdirSync(vDir).sort().join(',');
  check('proof: a real build directory clears its claimed files (8)', realRes.files === 8 && leftV.includes('vendor.a'), `files=${realRes.files} left=${leftV}`);
  check('proof: the vendor .a beside a real build survives', readText(path.join(vDir, 'vendor.a')) === 'vendor-archive\n', leftV);
  fs.rmSync(vDir, { recursive: true, force: true });

  // (round7 P2-B) DEPTH does not matter: two nested levels of claimed
  // compiler outputs clear fine, and a stored artifact in a SIBLING branch
  // survives (traversal is separate from classification)
  const deep = mk(path.join(root2, 'objdeep'));
  claimed = buildFixture(deep, 'real');
  fs.mkdirSync(path.join(deep, 'Drivers', 'Board'), { recursive: true });
  fs.writeFileSync(path.join(deep, 'Drivers', 'subdir.mk'), `${GENERATED_HEADER}\nx\n`);
  fs.writeFileSync(path.join(deep, 'Drivers', 'Board', 'subdir.mk'), `${GENERATED_HEADER}\nx\n`);
  fs.writeFileSync(path.join(deep, 'Drivers', 'Board', 'uart.o'), 'x');
  fs.writeFileSync(path.join(deep, 'Drivers', 'Board', 'uart.d'), 'x');
  fs.mkdirSync(path.join(deep, 'golden'), { recursive: true });
  fs.writeFileSync(path.join(deep, 'golden', 'factory.elf'), 'factory\n');
  const deepClaimed = [...claimed, 'Drivers/subdir.mk', 'Drivers/Board/subdir.mk', 'Drivers/Board/uart.o', 'Drivers/Board/uart.d'];
  const deepRes = deleteConfigOutputs(root2, [{ dir: deep, target: 'real', claimed: deepClaimed, keep: ['real.hex', 'real.bin'] }]);
  check(
    'proof: one AND two nested claimed levels clear; the golden branch survives',
    deepRes.files === 12 && fs.existsSync(path.join(deep, 'golden', 'factory.elf')) && fs.existsSync(path.join(deep, 'real.hex')),
    `files=${deepRes.files} left=${fs.readdirSync(deep).sort().join(',')}`
  );
  fs.rmSync(deep, { recursive: true, force: true });

  // (round7 P2-C) two same-named configurations SHARE one output directory —
  // grouped FIRST: the makefile generated by the last-built config does not
  // name the other, and the union keep keeps BOTH images
  const shared = mk(path.join(root2, 'dbg'));
  fs.writeFileSync(path.join(shared, 'makefile'), `${GENERATED_HEADER}\nRM := rm -rf\n\nall: B.elf\nB.elf: main.o\n`);
  fs.writeFileSync(path.join(shared, 'A.hex'), 'a-image\n');
  fs.writeFileSync(path.join(shared, 'B.hex'), 'b-image\n');
  fs.writeFileSync(path.join(shared, 'main.o'), 'x');
  const sharedClaimed = ['makefile', 'sources.mk', 'objects.mk', 'main.o'];
  const rShared = deleteConfigOutputs(root2, [
    { dir: shared, target: 'A', claimed: [...sharedClaimed, 'A.hex'], keep: ['A.hex'] },
    { dir: shared, target: 'B', claimed: [...sharedClaimed, 'B.hex'], keep: ['B.hex'] },
  ]);
  const leftShared = fs.readdirSync(shared).sort().join(',');
  check('proof: shared directory grouped before validation — both images survive', rShared.files === 2 && leftShared === 'A.hex,B.hex', `files=${rShared.files} left=${leftShared}`);
  // the mirror case: the makefile names A (and main.o is already gone after
  // the first pass), the batch still proceeds
  fs.writeFileSync(path.join(shared, 'makefile'), `${GENERATED_HEADER}\nall: A.elf\nA.elf: main.o\n`);
  const rShared2 = deleteConfigOutputs(root2, [
    { dir: shared, target: 'A', claimed: [...sharedClaimed, 'A.hex'], keep: ['A.hex'] },
    { dir: shared, target: 'B', claimed: [...sharedClaimed, 'B.hex'], keep: ['B.hex'] },
  ]);
  check('proof: shared directory works with EITHER last-built config', rShared2.files === 1 && fs.readdirSync(shared).sort().join(',') === 'A.hex,B.hex', JSON.stringify(rShared2));
  // and an unclaimed input mixed into the shared dir survives it
  fs.writeFileSync(path.join(shared, 'makefile'), `${GENERATED_HEADER}\nall: B.elf\nB.elf: main.o\n`);
  fs.writeFileSync(path.join(shared, 'vendor.a'), 'vendor-archive\n');
  const rShared3 = deleteConfigOutputs(root2, [
    { dir: shared, target: 'A', claimed: [...sharedClaimed, 'A.hex'], keep: ['A.hex'] },
    { dir: shared, target: 'B', claimed: [...sharedClaimed, 'B.hex'], keep: ['B.hex'] },
  ]);
  check('proof: an input beside the shared build survives', rShared3.files === 1 && readText(path.join(shared, 'vendor.a')) === 'vendor-archive\n', fs.readdirSync(shared).sort().join(','));
  fs.rmSync(shared, { recursive: true, force: true });

  // (round4 P2) an EMPTY directory in keep mode is SKIPPED, not a batch
  // failure; in remove mode it deletes via plain rmdir
  const emptyCfg = mk(path.join(root2, 'objempty'));
  const realDir = mk(path.join(root2, 'objreal'));
  const realClaimed = buildFixture(realDir, 'real');
  const rr = deleteConfigOutputs(root2, [
    { dir: emptyCfg, target: 'real', claimed: CLAIMED, keep: ['x.hex'] },
    { dir: realDir, target: 'real', claimed: realClaimed, keep: ['real.hex', 'real.bin'] },
  ]);
  check('proof: an empty directory in keep mode is skipped (batch proceeds)', rr.files === 8 && fs.existsSync(path.join(realDir, 'real.hex')), JSON.stringify(rr));
  const rr2 = deleteConfigOutputs(root2, [{ dir: realDir, target: 'real', claimed: realClaimed, keep: ['real.hex', 'real.bin'] }]);
  check('proof: re-running the keep-clear right after itself is a no-op success', rr2.files === 0 && fs.existsSync(path.join(realDir, 'real.hex')), JSON.stringify(rr2));
  const rr3 = deleteConfigOutputs(root2, [{ dir: emptyCfg, target: 'real', claimed: CLAIMED }]);
  check('proof: an EMPTY directory deletes via rmdir in remove mode', rr3.dirs === 1 && !fs.existsSync(emptyCfg), JSON.stringify(rr3));
  fs.rmSync(realDir, { recursive: true, force: true });

  // (round7 P2-B) the round6 case-differing image: an UNCLAIMED file on a
  // case-sensitive host — now it SURVIVES as a non-deleted input on every
  // host instead of refusing (the reviewer's hash-unchanged criterion)
  const caseDir = mk(path.join(root2, 'objcase'));
  const caseClaimed = buildFixture(caseDir, 'real');
  fs.writeFileSync(path.join(caseDir, 'APP.HEX'), 'upper\n');
  const caseRes = deleteConfigOutputs(root2, [{ dir: caseDir, target: 'real', claimed: caseClaimed, keep: ['app.hex'] }]);
  check(
    'proof: a case-differing image is never deleted (kept on win32, survivor elsewhere)',
    caseRes.files === 10 && readText(path.join(caseDir, 'APP.HEX')) === 'upper\n',
    `files=${caseRes.files} left=${fs.readdirSync(caseDir).sort().join(',')}`
  );
  fs.rmSync(caseDir, { recursive: true, force: true });

  // MRVC's OWN extras are claimed outputs: the flash script the download
  // writes into the build dir and a static library's .a product
  const cfgDir = mk(path.join(root2, 'objcfg'));
  claimed = buildFixture(cfgDir, 'app');
  fs.writeFileSync(path.join(cfgDir, 'mrvc_flash.cfg'), '# openocd script\n');
  const cfgRes = deleteConfigOutputs(root2, [{ dir: cfgDir, target: 'app', claimed }]);
  check('proof: the flash script and the product are claimed outputs', cfgRes.files === 11 && !fs.existsSync(cfgDir), JSON.stringify(cfgRes));

  // (round3 P2) a batch validates EVERY spec first — one bad directory
  // refuses the whole batch and the good directory is untouched
  const goodDir = mk(path.join(root2, 'objgood'));
  const goodClaimed = buildFixture(goodDir, 'good');
  const badDir = mk(path.join(root2, 'objbad'));
  fs.writeFileSync(path.join(badDir, 'main.o'), 'x'); // claimed path, NO makefile
  threw = '';
  try {
    deleteConfigOutputs(root2, [
      { dir: goodDir, target: 'good', claimed: goodClaimed },
      { dir: badDir, target: 'good', claimed: ['makefile', 'main.o'] },
    ]);
  } catch (e) {
    threw = String(e.message || e);
  }
  check(
    'proof: a batch with one unproven directory refuses WHOLLY',
    threw.includes('failed the output-directory checks') && threw.includes(badDir) && fs.existsSync(path.join(goodDir, 'makefile')),
    threw.slice(0, 200)
  );
  fs.rmSync(goodDir, { recursive: true, force: true });
  fs.rmSync(badDir, { recursive: true, force: true });

  // a link INSIDE the output directory is refused (entries would follow it)
  const linkDir = mk(path.join(root2, 'objlink'));
  buildFixture(linkDir, 'real');
  let linkOk = true;
  try {
    fs.symlinkSync(path.join(root2, 'SRC'), path.join(linkDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    linkOk = false; // no symlink privilege on this host — skip the probe
  }
  if (linkOk) {
    threw = '';
    try {
      deleteConfigOutputs(root2, [{ dir: linkDir, target: 'real', claimed: buildFixture(linkDir, 'real'), keep: ['real.hex', 'real.bin'] }]);
    } catch (e) {
      threw = String(e.message || e);
    }
    check('proof: a link inside the output directory refuses the clear', threw.includes('refusing a link'), threw.slice(0, 160));
    check('proof: the link target contents survived', fs.existsSync(path.join(root2, 'SRC', 'main.c')));
    fs.rmSync(path.join(linkDir, 'escape'), { recursive: true, force: true });
  }
  fs.rmSync(linkDir, { recursive: true, force: true });
}

// 8 (0.3.6 review P2): prefixed flash images survive "keep hex/bin" — the
//    keep list shares the generator's naming, the legacy prefix-less image
//    is an unclaimed survivor now
{
  check('imageKeepNames: prefixed + legacy names', JSON.stringify(imageKeepNames('app', 'boot_')) === JSON.stringify(['boot_app.hex', 'boot_app.bin', 'app.hex', 'app.bin']));
  const pdir = path.join(root2, 'objPre');
  fs.mkdirSync(pdir, { recursive: true });
  const claimedPre = buildFixture(pdir, 'boot_app');
  fs.writeFileSync(path.join(pdir, 'app.hex'), 'stale-legacy');
  const keepRes2 = deleteConfigOutputs(root2, [{ dir: pdir, target: 'boot_app', claimed: claimedPre, keep: imageKeepNames('app', 'boot_') }]);
  const left2 = fs.readdirSync(pdir).sort().join(',');
  check('allConfigs: the PREFIXED images survive keep hex/bin', keepRes2.files === 8 && left2 === 'app.hex,boot_app.bin,boot_app.hex', `files=${keepRes2.files} left=${left2}`);
  fs.rmSync(pdir, { recursive: true, force: true });
}

// 9. wiring (0.3.6): the two ORIGINAL commands keep their labels and menu
//    places (active-config semantics), the two all-configurations commands
//    sit BELOW them in the title-bar menu
{
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const vt = pkg.contributes.menus['view/title'].filter((m) => m.group.startsWith('2_delete'));
  check('wiring: four delete-output entries in the title-bar menu', vt.length === 4, JSON.stringify(vt.map((m) => m.command)));
  check(
    'wiring: order = keepImages, dirs, allConfigs dirs, allConfigs keepImages',
    JSON.stringify(vt.map((m) => m.command)) ===
      JSON.stringify(['mrvc.deleteOutputKeepImages', 'mrvc.deleteOutputDirs', 'mrvc.deleteAllConfigsOutputDirs', 'mrvc.deleteAllConfigsOutputKeepImages'])
  );
  check('wiring: all four gated on mrvc.hasProjects', vt.every((m) => m.when.includes('mrvc.hasProjects')));
  const enNls = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.json'), 'utf8'));
  const zhNls = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.zh-cn.json'), 'utf8'));
  check(
    'wiring: new command titles exist in BOTH languages',
    ['command.mrvc.deleteAllConfigsOutputDirs.title', 'command.mrvc.deleteAllConfigsOutputKeepImages.title'].every((k) => k in enNls && k in zhNls)
  );
  const extSrc = fs.readFileSync(path.join(__dirname, '..', 'out', 'extension.js'), 'utf-8');
  check('wiring: both new commands registered in the extension', extSrc.includes('mrvc.deleteAllConfigsOutputDirs') && extSrc.includes('mrvc.deleteAllConfigsOutputKeepImages'));
  check('wiring: original commands keep active-config semantics (p.buildDir)', /deleteOutputOne[\s\S]{0,700}p\.buildDir/.test(extSrc));
  check('wiring: new commands route through deleteConfigOutputs', /deleteAllConfigsOne[\s\S]{0,700}deleteConfigOutputs/.test(extSrc));
  // (review round7 P1) the delete paths feed the build model's claimed set
  check('wiring: the active-config delete passes buildOutputFiles', /deleteOutputOne[\s\S]{0,900}buildOutputFiles\(p\.cproject\)/.test(extSrc));
  check('wiring: the batch delete passes per-config buildOutputFiles', /deleteAllConfigsOne[\s\S]{0,700}buildOutputFiles\(ci\)/.test(extSrc));
}

// 10 (review round8 P1-1 / P2-1 / P2-2 / P2-3): realistic build artifacts
//    including linker .map (default + custom), analysis .su, and legacy
//    mrs2_flash.cfg; empty-subdir refusal; batch containment on missing path
{
  const realProj = path.join(scratch, 'MAPPROJ');
  const realObj = path.join(realProj, 'obj');
  fs.mkdirSync(path.join(realProj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(realProj, 'src', 'main.c'), 'int main(void){return 0;}\n');
  fs.writeFileSync(path.join(realProj, 'MAPPROJ.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(path.join(realProj, '.project'), '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>MAPPROJ</name></projectDescription>');
  fs.writeFileSync(
    path.join(realProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n' +
      '<option id="ilg.gnumcueclipse.managedbuild.cross.riscv.option.c.linker.mapfilename.1" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.c.linker.mapfilename" value="${BuildArtifactFileBaseName}_custom"/>\n' +
      '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries>\n' +
      '</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  const cpReal = Cproject.load(realProj, { repairProject: false });
  const realClaimed = buildOutputFiles(cpReal);
  check(
    'buildOutputFiles: claims custom linker .map, analysis .su, and legacy mrs2_flash.cfg',
    realClaimed.includes('MAPPROJ_custom.map') && realClaimed.includes('src/main.su') && realClaimed.includes('mrs2_flash.cfg'),
    JSON.stringify(realClaimed)
  );
  // populate the real output dir with all build outputs including .map, .su, mrs2_flash.cfg
  // (no root source -> no root subdir.mk, matching makefile generator output)
  fs.mkdirSync(path.join(realObj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(realObj, 'makefile'), `${GENERATED_HEADER}\nall: MAPPROJ.elf\nMAPPROJ.elf: src/main.o\n`);
  for (const f of ['sources.mk', 'objects.mk', 'src/subdir.mk', 'src/main.o', 'src/main.d', 'src/main.su', 'MAPPROJ.elf', 'MAPPROJ.hex', 'MAPPROJ_custom.map', 'mrs2_flash.cfg']) {
    fs.writeFileSync(path.join(realObj, f), 'x');
  }
  const clrMap = clearOutputDir(realProj, realObj, imageKeepNames(cpReal.targetName, cpReal.outputPrefix), cpReal.targetName, realClaimed);
  check(
    'buildOutputFiles: keep-clear removes .map, .su, mrs2_flash.cfg and leaves only kept .hex',
    clrMap.removed === 10 && fs.readdirSync(realObj).join(',') === 'MAPPROJ.hex',
    JSON.stringify({ clrMap, left: fs.readdirSync(realObj) })
  );
  fs.writeFileSync(path.join(realObj, 'makefile'), `${GENERATED_HEADER}\nall: MAPPROJ.elf\nMAPPROJ.elf: src/main.o\n`);
  for (const f of ['sources.mk', 'objects.mk', 'src/subdir.mk', 'src/main.o', 'src/main.d', 'src/main.su', 'MAPPROJ.elf', 'MAPPROJ_custom.map', 'mrs2_flash.cfg']) {
    fs.mkdirSync(path.dirname(path.join(realObj, f)), { recursive: true });
    fs.writeFileSync(path.join(realObj, f), 'x');
  }
  removeOutputDir(realProj, realObj, cpReal.targetName, realClaimed);
  check('buildOutputFiles: whole-dir delete succeeds with .map, .su, and mrs2_flash.cfg present', !fs.existsSync(realObj));

  // P2-1: a directory holding only an EMPTY subdirectory (no files, no makefile)
  // must be refused in remove mode instead of wiping unowned empty subtrees
  const emptyTreeDir = path.join(realProj, 'unowned_tree');
  fs.mkdirSync(path.join(emptyTreeDir, 'empty_sub'), { recursive: true });
  let subErr = '';
  try {
    removeOutputDir(realProj, emptyTreeDir, 'MAPPROJ', realClaimed);
  } catch (e) {
    subErr = String(e.message || e);
  }
  check('proof (P2-1): unowned dir with empty subdirectory is refused in remove mode', subErr.includes('no generated makefile') && fs.existsSync(path.join(emptyTreeDir, 'empty_sub')), subErr);
  fs.rmSync(emptyTreeDir, { recursive: true, force: true });

  // P2-2: deleteConfigOutputs refuses a non-existent outside-root path
  let batchOutsideErr = '';
  try {
    deleteConfigOutputs(realProj, [{ dir: path.join(scratch, 'outside_missing'), target: 'MAPPROJ', claimed: realClaimed }]);
  } catch (e) {
    batchOutsideErr = String(e.message || e);
  }
  check('guard (P2-2): deleteConfigOutputs refuses non-existent outside-root path', batchOutsideErr.includes('outside the project root'), batchOutsideErr);
  fs.rmSync(realProj, { recursive: true, force: true });
}

// 11 (review round8 A/B/C/D): print-size phony goal + .siz protection + legacy
//    clean override, renamed-source output history, ANSI/GBK/Shift-JIS
//    makefile decoding, and removeOutputDir error propagation / return shape
{
  const fakeTc = {
    name: 'GCC12',
    dir: path.join(scratch, 'tc'),
    prefix: 'riscv-none-elf-',
    compilerC: 'riscv-none-elf-gcc',
    compilerCpp: 'riscv-none-elf-g++',
    linkerC: 'riscv-none-elf-gcc',
    linkerCpp: 'riscv-none-elf-g++',
    debugger: 'riscv-none-elf-gdb',
    objcopy: 'riscv-none-elf-objcopy',
    objdump: 'riscv-none-elf-objdump',
    size: 'riscv-none-elf-size',
  };

  // A (P1): Print Size uses phony target mrvc-print-size, never deletes hand-saved .siz
  const sizProj = path.join(scratch, 'SIZPROJ');
  const sizObj = path.join(sizProj, 'obj');
  fs.mkdirSync(path.join(sizProj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sizProj, 'src', 'main.c'), 'int main(void){return 0;}\n');
  fs.writeFileSync(path.join(sizProj, 'SIZPROJ.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(path.join(sizProj, '.project'), '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>SIZPROJ</name></projectDescription>');
  fs.writeFileSync(
    path.join(sizProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n' +
      '<option id="printsize.1" superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.option.addtools.printsize" value="true"/>\n' +
      '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries>\n' +
      '</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  const cpSiz = Cproject.load(sizProj, { repairProject: false });
  generateMakefiles(cpSiz, fakeTc);
  const mkSiz = readText(path.join(sizObj, 'makefile'));
  const claimedSiz = buildOutputFiles(cpSiz);
  check(
    'round8 A: Print Size emits phony mrvc-print-size and excludes .siz from clean & buildOutputFiles',
    mkSiz.includes('SECONDARY_SIZE += mrvc-print-size') &&
      /\.PHONY: mrvc-print-size\r?\nmrvc-print-size:/.test(mkSiz) &&
      !/^clean:\r?\n\t[^\r\n]*\$\(SECONDARY_SIZE\)/m.test(mkSiz) &&
      !claimedSiz.includes('SIZPROJ.siz'),
    mkSiz.slice(-300)
  );
  fs.writeFileSync(path.join(sizObj, 'SIZPROJ.siz'), 'user-annotated-report\n');
  fs.writeFileSync(path.join(sizObj, 'SIZPROJ.elf'), 'elf');
  fs.writeFileSync(path.join(sizObj, 'SIZPROJ.hex'), 'hex');
  const sizClr = clearOutputDir(sizProj, sizObj, imageKeepNames('SIZPROJ', ''), 'SIZPROJ', claimedSiz);
  check(
    'round8 A: keep-clear leaves hand-saved .siz byte-identical',
    readText(path.join(sizObj, 'SIZPROJ.siz')) === 'user-annotated-report\n' && sizClr.kept.includes('SIZPROJ.siz'),
    JSON.stringify(sizClr)
  );
  // restore makefiles and verify whole-dir delete refuses before touching anything
  generateMakefiles(cpSiz, fakeTc);
  let sizDelErr = '';
  try {
    removeOutputDir(sizProj, sizObj, 'SIZPROJ', claimedSiz);
  } catch (e) {
    sizDelErr = String(e.message || e);
  }
  check(
    'round8 A: whole-dir delete refuses with .siz inside without deleting makefile',
    sizDelErr.includes('not written by this build') && fs.existsSync(path.join(sizObj, 'makefile')) && readText(path.join(sizObj, 'SIZPROJ.siz')) === 'user-annotated-report\n',
    sizDelErr
  );
  // legacy Print Size clean override (pre-fix generated makefile vs custom redirecting makefile)
  const legDir = path.join(scratch, 'LEGACY_SIZ');
  fs.mkdirSync(legDir, { recursive: true });
  fs.writeFileSync(path.join(legDir, 'makefile'), `${GENERATED_HEADER}\nSECONDARY_SIZE += \\\napp.siz \\\n\napp.siz: app.elf\n\triscv-none-elf-size --format=berkeley "app.elf"\n`);
  check('round8 A: legacyPrintSizeCleanOverride detects pre-fix print-size makefile', JSON.stringify(legacyPrintSizeCleanOverride(legDir)) === '["SECONDARY_SIZE="]');
  fs.writeFileSync(path.join(legDir, 'makefile'), `${GENERATED_HEADER}\nSECONDARY_SIZE += \\\napp.siz \\\n\napp.siz: app.elf\n\triscv-none-elf-size "app.elf" > "app.siz"\n`);
  check('round8 A: legacyPrintSizeCleanOverride spares makefile that redirects > app.siz', legacyPrintSizeCleanOverride(legDir).length === 0);
  safeRm(legDir);
  safeRm(sizProj);

  // B (P2): Renamed source outputs cleaned via persistent build history, untouched inputs spared
  const renProj = path.join(scratch, 'RENPROJ');
  const renObj = path.join(renProj, 'obj');
  fs.mkdirSync(path.join(renProj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(renProj, 'src', 'old.c'), 'int f(void){return 1;}\n');
  fs.writeFileSync(path.join(renProj, 'RENPROJ.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
  fs.writeFileSync(path.join(renProj, '.project'), '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>RENPROJ</name></projectDescription>');
  fs.writeFileSync(
    path.join(renProj, '.cproject'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n' +
      '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries>\n' +
      '</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
  );
  // Build 1 with src/old.c + an unrecorded vendor.o already sitting in obj/
  let cpRen = Cproject.load(renProj, { repairProject: false });
  generateMakefiles(cpRen, fakeTc);
  fs.writeFileSync(path.join(renObj, 'vendor.o'), 'vendor-input-untouched\n');
  let cand1 = buildOutputFiles(cpRen);
  const snap1 = snapshotExistingOutputs(renObj, cand1);
  fs.writeFileSync(path.join(renObj, 'src', 'old.o'), 'obj-old-1');
  fs.writeFileSync(path.join(renObj, 'src', 'old.d'), 'dep-old-1');
  fs.writeFileSync(path.join(renObj, 'RENPROJ.elf'), 'elf-1');
  fs.writeFileSync(path.join(renObj, 'RENPROJ.hex'), 'hex-1');
  fs.writeFileSync(path.join(renObj, 'RENPROJ.map'), 'map-1');
  recordBuildOutputs(renProj, renObj, cand1, snap1);

  // Rename src/old.c -> src/new.c and Build 2
  fs.renameSync(path.join(renProj, 'src', 'old.c'), path.join(renProj, 'src', 'new.c'));
  cpRen = Cproject.load(renProj, { repairProject: false });
  generateMakefiles(cpRen, fakeTc);
  const cand2 = buildOutputFiles(cpRen);
  const snap2 = snapshotExistingOutputs(renObj, cand2);
  fs.writeFileSync(path.join(renObj, 'src', 'new.o'), 'obj-new-2');
  fs.writeFileSync(path.join(renObj, 'src', 'new.d'), 'dep-new-2');
  recordBuildOutputs(renProj, renObj, cand2, snap2);

  // Unrecorded vendor.o survives keep-clear while old.o & old.d ARE cleaned
  const clrRen = clearOutputDir(renProj, renObj, imageKeepNames('RENPROJ', ''), 'RENPROJ', cand2);
  check(
    'round8 B: keep-clear cleans renamed src/old.o & src/old.d while sparing unrecorded vendor.o',
    !fs.existsSync(path.join(renObj, 'src', 'old.o')) &&
      !fs.existsSync(path.join(renObj, 'src', 'old.d')) &&
      !fs.existsSync(path.join(renObj, 'src', 'new.o')) &&
      fs.existsSync(path.join(renObj, 'RENPROJ.hex')) &&
      readText(path.join(renObj, 'vendor.o')) === 'vendor-input-untouched\n',
    JSON.stringify({ clrRen, left: fs.readdirSync(renObj) })
  );
  // Whole-dir delete after removing vendor.o succeeds when renamed outputs exist, and refuses if recorded file was externally modified
  generateMakefiles(cpRen, fakeTc);
  const snap3 = snapshotExistingOutputs(renObj, cand2);
  fs.writeFileSync(path.join(renObj, 'src', 'temp_old.o'), 'built-temp');
  recordBuildOutputs(renProj, renObj, ['src/temp_old.o'], snap3);
  fs.writeFileSync(path.join(renObj, 'src', 'temp_old.o'), 'user-edited-after-build');
  fs.rmSync(path.join(renObj, 'vendor.o'), { force: true });
  let modErr = '';
  try {
    removeOutputDir(renProj, renObj, 'RENPROJ', cand2);
  } catch (e) {
    modErr = String(e.message || e);
  }
  check(
    'round8 B: externally modified history entry refuses whole-dir delete',
    modErr.includes('not written by this build') && readText(path.join(renObj, 'src', 'temp_old.o')) === 'user-edited-after-build',
    modErr
  );
  // Restore hash match -> whole-dir delete succeeds
  fs.writeFileSync(path.join(renObj, 'src', 'temp_old.o'), 'built-temp');
  const remRen = removeOutputDir(renProj, renObj, 'RENPROJ', cand2);
  check('round8 B: whole-dir delete succeeds cleanly once only owned/history-verified files remain', remRen.removed === true && !fs.existsSync(renObj), JSON.stringify(remRen));
  // Pure updateHistory / mayReclaim sanity check
  const merged = updateHistory(new Map([['a.o', 'h1']]), [{ rel: 'b.o', sha256: 'h2' }]);
  check('round8 B: updateHistory preserves prior entries and mayReclaim enforces SHA-256', mayReclaim('a.o', 'h1', merged) && !mayReclaim('a.o', 'bad', merged) && mayReclaim('b.o', 'h2', merged));
  try {
    fs.rmSync(renProj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  } catch {
    // SMB share directory handle release lag — next test run cleans scratch
  }

  // C (P2): ANSI / GBK / Shift-JIS makefile target decoding
  const encProj = path.join(scratch, 'ENCPROJ');
  const encObj = path.join(encProj, 'obj');
  fs.mkdirSync(encObj, { recursive: true });
  const gbkText = `${GENERATED_HEADER}\nall: 测温.elf\n测温.elf: main.o\n`;
  fs.writeFileSync(path.join(encObj, 'makefile'), iconv.encode(gbkText, 'gbk'));
  fs.writeFileSync(path.join(encObj, 'main.o'), 'o');
  check('round8 C: decodeArtifact round-trips GBK', decodeArtifact(iconv.encode(gbkText, 'gbk'), 'gbk') === gbkText);
  const gbkClear = clearOutputDir(encProj, encObj, ['测温.hex'], '测温', ['makefile', 'main.o'], 'gbk');
  check('round8 C: GBK-encoded makefile with Chinese target clears cleanly', gbkClear.removed === 2 && !fs.existsSync(path.join(encObj, 'main.o')), JSON.stringify(gbkClear));
  const sjisText = `${GENERATED_HEADER}\nall: 温度.elf\n温度.elf: main.o\n`;
  fs.writeFileSync(path.join(encObj, 'makefile'), iconv.encode(sjisText, 'shift-jis'));
  fs.writeFileSync(path.join(encObj, 'main.o'), 'o');
  let sjisMismatch = '';
  try {
    clearOutputDir(encProj, encObj, ['別.hex'], '別名', ['makefile', 'main.o'], 'shift-jis');
  } catch (e) {
    sjisMismatch = String(e.message || e);
  }
  const sjisOk = clearOutputDir(encProj, encObj, ['温度.hex'], '温度', ['makefile', 'main.o'], 'shift-jis');
  check('round8 C: Shift-JIS target matches its own name and rejects foreign name', sjisMismatch.includes('does not reference') && sjisOk.removed === 2, sjisMismatch);
  safeRm(encProj);

  // D (P2): removeOutputDir returns removed:false on already-missing dir, and throws if rmdirSync fails (EACCES)
  const dProj = path.join(scratch, 'DPROJ');
  const dMissing = path.join(dProj, 'obj_missing');
  fs.mkdirSync(dProj, { recursive: true });
  const missRes = removeOutputDir(dProj, dMissing, 'DPROJ', ['makefile']);
  check('round8 D: missing dir returns removed=false instead of claiming removal', missRes.removed === false && missRes.files === 0, JSON.stringify(missRes));
  const dObj = path.join(dProj, 'obj');
  const dClaimed = buildFixture(dObj, 'DPROJ');
  const origRmdir = fs.rmdirSync;
  fs.rmdirSync = () => {
    const err = new Error('EACCES: permission denied');
    err.code = 'EACCES';
    throw err;
  };
  let rmdirErr = '';
  try {
    removeOutputDir(dProj, dObj, 'DPROJ', dClaimed);
  } catch (e) {
    rmdirErr = String(e.message || e);
  } finally {
    fs.rmdirSync = origRmdir;
  }
  check('round8 D: root rmdir failure throws loudly instead of reporting removed=true', rmdirErr.includes('EACCES') && fs.existsSync(dObj), rmdirErr);
  safeRm(dProj);
  // encodeArtifact unused-import suppression sanity
  check('round8 C: encodeArtifact callable', Buffer.isBuffer(encodeArtifact('ok')));
}

// 12 (review round9 A/B): SHA-256 protection on recorded current-config
//    products (app.map, app.hex, src/main.o) + U+FFFD cross-locale diagnostic
{
  const fakeTc9 = {
    name: 'GCC12',
    dir: path.join(scratch, 'tc'),
    prefix: 'riscv-none-elf-',
    compilerC: 'riscv-none-elf-gcc',
    compilerCpp: 'riscv-none-elf-g++',
    linkerC: 'riscv-none-elf-gcc',
    linkerCpp: 'riscv-none-elf-g++',
    debugger: 'riscv-none-elf-gdb',
    objcopy: 'riscv-none-elf-objcopy',
    objdump: 'riscv-none-elf-objdump',
    size: 'riscv-none-elf-size',
  };
  let seq9 = 0;
  const setupRecordedBuild = () => {
    const r9Proj = path.join(scratch, `R9PROJ_${++seq9}`);
    const r9Obj = path.join(r9Proj, 'obj');
    fs.rmSync(r9Proj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    fs.mkdirSync(path.join(r9Proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(r9Proj, 'src', 'main.c'), 'int main(void){return 0;}\n');
    fs.writeFileSync(path.join(r9Proj, 'R9PROJ.wvproj'), '<?xml version="1.0" encoding="UTF-8"?><project/>');
    fs.writeFileSync(path.join(r9Proj, '.project'), '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>R9PROJ</name></projectDescription>');
    fs.writeFileSync(
      path.join(r9Proj, '.cproject'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n<cconfiguration id="x" name="obj">\n<folderInfo>\n<toolChain>\n' +
        '<sourceEntries><entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name=""/></sourceEntries>\n' +
        '</toolChain>\n</folderInfo>\n</cconfiguration>\n</cproject>'
    );
    const cp9 = Cproject.load(r9Proj, { repairProject: false });
    generateMakefiles(cp9, fakeTc9);
    const cand9 = buildOutputFiles(cp9);
    const snap9 = snapshotExistingOutputs(r9Obj, cand9);
    fs.writeFileSync(path.join(r9Obj, 'src', 'main.o'), 'orig-o');
    fs.writeFileSync(path.join(r9Obj, 'src', 'main.d'), 'orig-d');
    fs.writeFileSync(path.join(r9Obj, 'R9PROJ.elf'), 'orig-elf');
    fs.writeFileSync(path.join(r9Obj, 'R9PROJ.hex'), 'orig-hex');
    fs.writeFileSync(path.join(r9Obj, 'R9PROJ.map'), 'orig-map');
    recordBuildOutputs(r9Proj, r9Obj, cand9, snap9);
    return { r9Proj, r9Obj, cp9, cand9 };
  };

  // A (P1): modifying any recorded claimed artifact (R9PROJ.map, R9PROJ.hex, src/main.o)
  // protects it from clearOutputDir AND refuses removeOutputDir without deleting anything
  for (const rel of ['R9PROJ.map', 'R9PROJ.hex', 'src/main.o']) {
    const { r9Proj: pClr, r9Obj: oClr, cand9 } = setupRecordedBuild();
    const abs = path.join(oClr, rel);
    fs.writeFileSync(abs, `USER_ANNOTATION:${rel}\n`);
    const clr9 = clearOutputDir(pClr, oClr, imageKeepNames('R9PROJ', ''), 'R9PROJ', cand9);
    check(
      `round9 A: keep-clear preserves modified current artifact ${rel} and reports it`,
      readText(abs) === `USER_ANNOTATION:${rel}\n` && clr9.kept.includes(rel),
      JSON.stringify({ clr9, rel })
    );
    try { fs.rmSync(pClr, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}

    const { r9Proj: pRem, r9Obj: oRem, cand9: cand9b } = setupRecordedBuild();
    const absB = path.join(oRem, rel);
    fs.writeFileSync(absB, `USER_ANNOTATION:${rel}\n`);
    let errB = '';
    try {
      removeOutputDir(pRem, oRem, 'R9PROJ', cand9b);
    } catch (e) {
      errB = String(e.message || e);
    }
    check(
      `round9 A: remove refuses modified current artifact ${rel} before touching makefile`,
      errB.includes('not written by this build') && fs.existsSync(path.join(oRem, 'makefile')) && readText(absB) === `USER_ANNOTATION:${rel}\n`,
      errB
    );
    try { fs.rmSync(pRem, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  }
  // positive case: unmodified outputs still clear and remove cleanly
  const { r9Proj: pOk, r9Obj: oOk, cand9: candOk } = setupRecordedBuild();
  const remOk9 = removeOutputDir(pOk, oOk, 'R9PROJ', candOk);
  check('round9 A: unmodified recorded outputs still remove cleanly', remOk9.removed === true && !fs.existsSync(oOk), JSON.stringify(remOk9));
  try { fs.rmSync(pOk, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}

  // B (P2): cross-codepage GBK makefile decoded on UTF-8 emits actionable encoding diagnostic
  const xProj = path.join(scratch, 'XLOCALE');
  const xObj = path.join(xProj, 'obj');
  fs.mkdirSync(xObj, { recursive: true });
  fs.writeFileSync(path.join(xObj, 'makefile'), iconv.encode(`${GENERATED_HEADER}\nall: 测温.elf\n测温.elf: main.o\n`, 'gbk'));
  fs.writeFileSync(path.join(xObj, 'main.o'), 'o');
  let xErr = '';
  try {
    clearOutputDir(xProj, xObj, ['测温.hex'], '测温', ['makefile', 'main.o'], 'utf-8');
  } catch (e) {
    xErr = String(e.message || e);
  }
  check(
    'round9 B: GBK makefile decoded as utf-8 gives cross-locale rebuild diagnostic',
    xErr.includes('not valid utf-8') && xErr.includes('rebuild the project once') && fs.existsSync(path.join(xObj, 'main.o')),
    xErr
  );
  // rebuilding in local UTF-8 succeeds cleanly
  fs.writeFileSync(path.join(xObj, 'makefile'), Buffer.from(`${GENERATED_HEADER}\nall: 测温.elf\n测温.elf: main.o\n`, 'utf-8'));
  const xClr = clearOutputDir(xProj, xObj, ['测温.hex'], '测温', ['makefile', 'main.o'], 'utf-8');
  check('round9 B: regenerated utf-8 makefile clears cleanly', xClr.removed === 2 && !fs.existsSync(path.join(xObj, 'main.o')), JSON.stringify(xClr));
  safeRm(xProj);
}

// 13 (review round35): fail-closed corrupted history, TOCTOU re-hash check,
//    append-only .gitignore, and metadata symlink containment
{
  // A (P2-1): corrupt / invalid output-history.json fails closed (never falls back to claimed deletion)
  const r35Proj = path.join(scratch, 'R35PROJ');
  const r35Obj = path.join(r35Proj, 'obj');
  const claimed35 = buildFixture(r35Obj, 'R35PROJ');
  const histFile = outputHistoryPath(r35Proj);
  fs.mkdirSync(path.dirname(histFile), { recursive: true });
  for (const [label, payload] of [
    ['corrupt JSON', '{not json'],
    ['unsupported version', JSON.stringify({ version: 2, dirs: {} })],
    ['invalid dirs shape', JSON.stringify({ version: 1, dirs: [] })],
  ]) {
    fs.writeFileSync(histFile, payload, 'utf-8');
    let clrErr = '';
    let remErr = '';
    try {
      clearOutputDir(r35Proj, r35Obj, ['R35PROJ.hex', 'R35PROJ.bin'], 'R35PROJ', claimed35);
    } catch (e) {
      clrErr = String(e.message || e);
    }
    try {
      removeOutputDir(r35Proj, r35Obj, 'R35PROJ', claimed35);
    } catch (e) {
      remErr = String(e.message || e);
    }
    check(
      `round35 fail-closed (${label}): clear and remove refuse while preserving files`,
      clrErr.length > 0 && remErr.length > 0 && fs.existsSync(path.join(r35Obj, 'makefile')) && fs.existsSync(path.join(r35Obj, 'Debug', 'main.o')),
      `clrErr=${clrErr} | remErr=${remErr}`
    );
  }
  safeRm(r35Proj);

  // B (P3-1): TOCTOU — modifying a planned file after planGroup aborts executePlan
  const tProj = path.join(scratch, 'R35TOCTOU');
  const tObj = path.join(tProj, 'obj');
  const tClaimed = buildFixture(tObj, 'R35TOCTOU');
  const origUnlink = fs.unlinkSync;
  const origWrite = fs.writeFileSync;
  let mutatedTarget = '';
  let tripped = false;
  fs.unlinkSync = function (p) {
    if (!tripped) {
      tripped = true;
      const candA = path.join(tObj, 'R35TOCTOU.elf');
      const candB = path.join(tObj, 'R35TOCTOU.hex');
      mutatedTarget = path.resolve(String(p)) === path.resolve(candA) ? candB : candA;
      origWrite.call(fs, mutatedTarget, 'TOCTOU_MODIFIED_BY_USER\n', 'utf-8');
    }
    return origUnlink.call(fs, p);
  };
  let toctouErr = '';
  try {
    removeOutputDir(tProj, tObj, 'R35TOCTOU', tClaimed);
  } catch (e) {
    toctouErr = String(e.message || e);
  } finally {
    fs.unlinkSync = origUnlink;
  }
  check(
    'round35 TOCTOU: file modified between planGroup and unlinkSync is refused and preserved',
    toctouErr.includes('content changed after validation') && !!mutatedTarget && readText(mutatedTarget) === 'TOCTOU_MODIFIED_BY_USER\n',
    toctouErr
  );
  try { fs.rmSync(tProj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}

  // C (P3-2): .gitignore maintenance is append-only (preserves existing comments/spaces)
  const giProj = path.join(scratch, 'R35GI');
  const giObj = path.join(giProj, 'obj');
  fs.mkdirSync(giObj, { recursive: true });
  fs.writeFileSync(path.join(giObj, 'makefile'), `${GENERATED_HEADER}\nall: R35GI.elf\n`);
  const mrvcDir = path.join(giProj, '.vscode', 'mrvc');
  fs.mkdirSync(mrvcDir, { recursive: true });
  const origGi = '# keep comment\ntrail   \n\nother.log';
  const giFile = path.join(mrvcDir, '.gitignore');
  fs.writeFileSync(giFile, origGi, 'utf-8');
  recordWrittenFiles(giProj, giObj, ['makefile']);
  const afterFirstGi = fs.readFileSync(giFile, 'utf-8');
  recordWrittenFiles(giProj, giObj, ['makefile']);
  const afterSecondGi = fs.readFileSync(giFile, 'utf-8');
  check(
    'round35 .gitignore: append-only preserves formatting and avoids duplicate entry',
    afterFirstGi === `${origGi}\noutput-history.json\noutput-history.lock\noutput-history.lock.stale.*\n` && afterSecondGi === afterFirstGi,
    JSON.stringify({ afterFirstGi, afterSecondGi })
  );
  try { fs.rmSync(giProj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}

  // D (P3-2): symlinked/junction .vscode/mrvc outside project root is refused for read & write
  const symProj = path.join(scratch, 'R35SYM');
  const symObj = path.join(symProj, 'obj');
  const outsideMeta = path.join(scratch, 'R35OUTSIDE_META');
  const symClaimed = buildFixture(symObj, 'R35SYM');
  fs.mkdirSync(path.join(symProj, '.vscode'), { recursive: true });
  fs.mkdirSync(outsideMeta, { recursive: true });
  let linked = false;
  try {
    fs.symlinkSync(outsideMeta, path.join(symProj, '.vscode', 'mrvc'), process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch {
    linked = false;
  }
  if (linked) {
    let symReadErr = '';
    try {
      clearOutputDir(symProj, symObj, ['R35SYM.hex', 'R35SYM.bin'], 'R35SYM', symClaimed);
    } catch (e) {
      symReadErr = String(e.message || e);
    }
    recordWrittenFiles(symProj, symObj, ['makefile']);
    check(
      'round35 containment: linked .vscode/mrvc refuses clear and blocks outside history write',
      symReadErr.includes('refusing to use') && !fs.existsSync(path.join(outsideMeta, 'output-history.json')),
      symReadErr
    );
  } else {
    check('round35 containment: symlink creation skipped cleanly (platform privilege)', true);
  }
  try { fs.rmSync(symProj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  try { fs.rmSync(outsideMeta, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}

  // E (round36 P2): execution-time subdirectory link check blocks unlink before it touches disk
  const subProj = path.join(scratch, 'R36SUBLINK');
  const subObj = path.join(subProj, 'obj');
  const subClaimed = buildFixture(subObj, 'R36SUBLINK');
  const origLstat = fs.lstatSync;
  const origSubUnlink = fs.unlinkSync;
  let unlinkedAfterSwap = 0;
  let swappedSub = false;
  const fakeSubPath = path.resolve(subObj, 'Debug');
  fs.lstatSync = function (p) {
    const st = origLstat.call(fs, p);
    // Simulate `obj/Debug` becoming a junction right before executePlan checks intermediate dirs
    if (!swappedSub && path.resolve(String(p)) === path.resolve(subObj, 'Debug', 'main.o')) {
      return st;
    }
    if (path.resolve(String(p)) === fakeSubPath && st.isDirectory()) {
      // Wait until planning has already recorded Debug/main.o via inspectTree (readdirSync),
      // so intercept on the first execution-phase directory check for Debug
      return {
        isSymbolicLink: () => true,
        isDirectory: () => false,
        isFile: () => false,
      };
    }
    return st;
  };
  fs.unlinkSync = function (p) {
    if (path.resolve(String(p)) === path.resolve(subObj, 'Debug', 'main.o')) unlinkedAfterSwap++;
    return origSubUnlink.call(fs, p);
  };
  let subErr = '';
  try {
    clearOutputDir(subProj, subObj, ['R36SUBLINK.hex', 'R36SUBLINK.bin'], 'R36SUBLINK', subClaimed);
  } catch (e) {
    subErr = String(e.message || e);
  } finally {
    fs.lstatSync = origLstat;
    fs.unlinkSync = origSubUnlink;
  }
  check(
    'round36 P2: execution-time intermediate dir link check refuses traversal and spares target file',
    subErr.includes('refusing to traverse linked') && unlinkedAfterSwap === 0 && fs.existsSync(path.join(subObj, 'Debug', 'main.o')),
    `subErr=${subErr} unlinkedAfterSwap=${unlinkedAfterSwap}`
  );
  try { fs.rmSync(subProj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}

  // F (round36 P3): stale output-history.lock recovery + clean unlock
  const lockProj = path.join(scratch, 'R36LOCK');
  const lockObj = path.join(lockProj, 'obj');
  fs.mkdirSync(path.join(lockProj, '.vscode', 'mrvc'), { recursive: true });
  fs.mkdirSync(lockObj, { recursive: true });
  fs.writeFileSync(path.join(lockObj, 'makefile'), `${GENERATED_HEADER}\nall: R36LOCK.elf\n`);
  const lockFile = path.join(lockProj, '.vscode', 'mrvc', 'output-history.lock');
  fs.writeFileSync(lockFile, '999999\n0\n', 'utf-8');
  const staleSec = (Date.now() - 60_000) / 1000;
  fs.utimesSync(lockFile, staleSec, staleSec);
  recordWrittenFiles(lockProj, lockObj, ['makefile']);
  const histAfterLock = loadDirHistory(lockProj, fs.realpathSync.native(lockObj));
  check(
    'round36 P3: stale output-history.lock is recovered, history updates, and lock file is removed',
    histAfterLock.files.has('makefile') && !fs.existsSync(lockFile),
    JSON.stringify({ hasMakefile: histAfterLock.files.has('makefile'), lockExists: fs.existsSync(lockFile) })
  );
  const mrvcLockEntries = fs.readdirSync(path.join(lockProj, '.vscode', 'mrvc'));
  check(
    'round37 P3 (stale claim cleanup): no stale claim temp files remain after recovery',
    !mrvcLockEntries.some((n) => n.startsWith('output-history.lock')),
    JSON.stringify(mrvcLockEntries)
  );
  try { fs.rmSync(lockProj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}

  // G (round37 P3): owner-safe unlock never deletes another process's newly acquired lock
  const ownProj = path.join(scratch, 'R37OWNER');
  const ownMrvc = path.join(ownProj, '.vscode', 'mrvc');
  fs.mkdirSync(ownMrvc, { recursive: true });
  const ownLock = path.join(ownMrvc, 'output-history.lock');
  withHistoryLock(ownMrvc, () => {
    fs.writeFileSync(ownLock, 'foreign-owner-999\n', 'utf-8');
  });
  check(
    'round37 P3 (owner-safe unlock): foreign lock file replaced mid-section is preserved on unlock',
    fs.existsSync(ownLock) && readText(ownLock).trim() === 'foreign-owner-999',
    fs.existsSync(ownLock) ? readText(ownLock) : 'missing'
  );
  try { fs.rmSync(ownProj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}

  // H (round37 P2): post-hash immediate pre-unlink check catches intermediate dir swap right before unlinkSync
  const preUnlinkProj = path.join(scratch, 'R37PREUNLINK');
  const preUnlinkObj = path.join(preUnlinkProj, 'obj');
  const preClaimed = buildFixture(preUnlinkObj, 'R37PREUNLINK');
  const origLstat37 = fs.lstatSync;
  const origUnlink37 = fs.unlinkSync;
  const targetO = path.resolve(preUnlinkObj, 'Debug', 'main.o');
  const targetDebug = path.resolve(preUnlinkObj, 'Debug');
  let debugLstatCount = 0;
  let unlinked37 = 0;
  fs.lstatSync = function (p) {
    const st = origLstat37.call(fs, p);
    if (path.resolve(String(p)) === targetDebug && st.isDirectory()) {
      debugLstatCount++;
      // 1st call = initial assertContainedExecutionPath (passes),
      // 2nd call = post-hash pre-unlink assertContainedExecutionPath (refuses)
      if (debugLstatCount >= 2) {
        return {
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false,
        };
      }
    }
    return st;
  };
  fs.unlinkSync = function (p) {
    if (path.resolve(String(p)) === targetO) unlinked37++;
    return origUnlink37.call(fs, p);
  };
  let preErr = '';
  try {
    clearOutputDir(preUnlinkProj, preUnlinkObj, ['R37PREUNLINK.hex', 'R37PREUNLINK.bin'], 'R37PREUNLINK', preClaimed);
  } catch (e) {
    preErr = String(e.message || e);
  } finally {
    fs.lstatSync = origLstat37;
    fs.unlinkSync = origUnlink37;
  }
  check(
    'round37 P2: post-hash pre-unlink intermediate dir swap check aborts before unlinkSync',
    debugLstatCount >= 2 && preErr.includes('refusing to traverse linked') && unlinked37 === 0 && fs.existsSync(targetO),
    `debugLstatCount=${debugLstatCount} preErr=${preErr} unlinked37=${unlinked37}`
  );
  try { fs.rmSync(preUnlinkProj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}

  // I (round39 P3): shared locked .gitignore helper converges receipt + history appends cleanly
  const r39GiProj = path.join(scratch, 'R39GI');
  const r39Mrvc = path.join(r39GiProj, '.vscode', 'mrvc');
  fs.mkdirSync(r39Mrvc, { recursive: true });
  const r39GiFile = path.join(r39Mrvc, '.gitignore');
  const r39Seed = '# user comment\nkeep_space   \n';
  fs.writeFileSync(r39GiFile, r39Seed, 'utf-8');
  ensureMrvcGitignoreEntries(r39Mrvc, ['flash-verified.json', 'power-verified.json']);
  ensureMrvcGitignoreEntries(r39Mrvc, ['output-history.json', 'output-history.lock', 'output-history.lock.stale.*']);
  ensureMrvcGitignoreEntries(r39Mrvc, ['flash-verified.json', 'output-history.json']);
  const r39GiAfter = fs.readFileSync(r39GiFile, 'utf-8');
  check(
    'round39 P3 (shared .gitignore helper): converges entries under lock without duplicates or comment loss',
    r39GiAfter === `${r39Seed}flash-verified.json\npower-verified.json\noutput-history.json\noutput-history.lock\noutput-history.lock.stale.*\n` &&
      !fs.existsSync(path.join(r39Mrvc, 'output-history.lock')),
    JSON.stringify(r39GiAfter)
  );
  try { fs.rmSync(r39GiProj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}

  // J (round39 P3): atomic write cleans up temp files when renameSync fails
  const r39TmpProj = path.join(scratch, 'R39TMPCLEAN');
  const r39TmpObj = path.join(r39TmpProj, 'obj');
  fs.mkdirSync(path.join(r39TmpProj, '.vscode', 'mrvc'), { recursive: true });
  fs.mkdirSync(r39TmpObj, { recursive: true });
  fs.writeFileSync(path.join(r39TmpObj, 'makefile'), `${GENERATED_HEADER}\nall: R39TMPCLEAN.elf\n`);
  const origRename39 = fs.renameSync;
  fs.renameSync = function () {
    const err = new Error('EACCES: blocked rename');
    err.code = 'EACCES';
    throw err;
  };
  try {
    recordWrittenFiles(r39TmpProj, r39TmpObj, ['makefile']);
  } finally {
    fs.renameSync = origRename39;
  }
  const tmpLeftovers = fs.readdirSync(path.join(r39TmpProj, '.vscode', 'mrvc'));
  check(
    'round39 P3 (atomic temp cleanup on rename failure): no *.tmp or lock file remains after failed rename',
    !tmpLeftovers.some((n) => n.endsWith('.tmp') || n === 'output-history.lock'),
    JSON.stringify(tmpLeftovers)
  );
  try { fs.rmSync(r39TmpProj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}

  // K (round44 P3): writeHistoryStore fails closed when .vscode/mrvc/.gitignore cannot be confirmed
  const r44DirProj = path.join(scratch, 'R44GI_FAIL');
  const r44DirObj = path.join(r44DirProj, 'obj');
  fs.mkdirSync(path.join(r44DirProj, '.vscode', 'mrvc', '.gitignore'), { recursive: true });
  fs.mkdirSync(r44DirObj, { recursive: true });
  fs.writeFileSync(path.join(r44DirObj, 'makefile'), `${GENERATED_HEADER}\nall: R44GI_FAIL.elf\n`);
  recordWrittenFiles(r44DirProj, r44DirObj, ['makefile']);
  const r44DirLeft = fs.readdirSync(path.join(r44DirProj, '.vscode', 'mrvc'));
  check(
    'round44 P3 (fail-closed .gitignore dir): refuses writing output-history.json and leaves no tmp/lock',
    !fs.existsSync(path.join(r44DirProj, '.vscode', 'mrvc', 'output-history.json')) &&
      !r44DirLeft.some((n) => n.endsWith('.tmp') || n === 'output-history.lock'),
    JSON.stringify(r44DirLeft)
  );
  try { fs.rmSync(r44DirProj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}

  const r44AccProj = path.join(scratch, 'R44GI_EACCES');
  const r44AccObj = path.join(r44AccProj, 'obj');
  fs.mkdirSync(path.join(r44AccProj, '.vscode', 'mrvc'), { recursive: true });
  fs.mkdirSync(r44AccObj, { recursive: true });
  fs.writeFileSync(path.join(r44AccProj, '.vscode', 'mrvc', '.gitignore'), '', 'utf-8');
  fs.writeFileSync(path.join(r44AccObj, 'makefile'), `${GENERATED_HEADER}\nall: R44GI_EACCES.elf\n`);
  const origAppend44 = fs.appendFileSync;
  fs.appendFileSync = function () {
    const err = new Error('EACCES: blocked .gitignore append');
    err.code = 'EACCES';
    throw err;
  };
  try {
    recordWrittenFiles(r44AccProj, r44AccObj, ['makefile']);
  } finally {
    fs.appendFileSync = origAppend44;
  }
  const r44AccLeft = fs.readdirSync(path.join(r44AccProj, '.vscode', 'mrvc'));
  check(
    'round44 P3 (fail-closed .gitignore EACCES): refuses writing output-history.json and leaves no tmp/lock',
    !fs.existsSync(path.join(r44AccProj, '.vscode', 'mrvc', 'output-history.json')) &&
      !r44AccLeft.some((n) => n.endsWith('.tmp') || n === 'output-history.lock'),
    JSON.stringify(r44AccLeft)
  );
  try { fs.rmSync(r44AccProj, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
}

console.log(failures ? `\n${failures} FAILURES` : '\nall output tests passed');
process.exit(failures ? 1 : 0);
