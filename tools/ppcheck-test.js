/*
 * Preprocessor consistency (0.3.3, user request): the C / C++ / Assembler
 * define lists may define the SAME macro with DIFFERENT values — the check
 * reports the divergent macros (raw compare, same semantics as the
 * properties page's macroConflicts gate) and the unify flow rewrites the
 * picked value in place + appends it to lists the macro was absent from.
 *
 * Core cases run against synthetic .cproject fixtures; the host flows run
 * under the vscode stub with scripted QuickPick / warning answers.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return require('./vscode-stub.js');
  return origLoad.apply(this, arguments);
};

const { Cproject } = require('../out/core/cproject.js');
const { ppDivergences } = require('../out/core/ppConsistency.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

const OPT = 'ilg.gnumcueclipse.managedbuild.cross.riscv.option.';
const makeCproject = (c, cpp, asm) => `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<cproject>
	<cconfiguration id="x">
		<storageModule moduleId="cdtBuildSystem">
			<configuration artifactName="\${ProjName}" name="obj">
				<folderInfo name="/">
					<toolChain superClass="ilg.gnumcueclipse.managedbuild.cross.riscv.toolchain.elf.release">
						<option superClass="${OPT}c.compiler.defs" valueType="definedSymbols">
${c.map((v) => `							<listOptionValue builtIn="false" value="&quot;${v}&quot;"/>`).join('\n')}
						</option>
						<option superClass="${OPT}cpp.compiler.defs" valueType="definedSymbols">
${cpp.map((v) => `							<listOptionValue builtIn="false" value="&quot;${v}&quot;"/>`).join('\n')}
						</option>
						<option superClass="${OPT}assembler.defs" valueType="definedSymbols">
${asm.map((v) => `							<listOptionValue builtIn="false" value="&quot;${v}&quot;"/>`).join('\n')}
						</option>
					</toolChain>
				</folderInfo>
			</configuration>
		</storageModule>
	</cconfiguration>
</cproject>`;

const scratch = path.join(__dirname, '..', '.scratch', 'ppcheck');
fs.rmSync(scratch, { recursive: true, force: true });

// literal directory names per case (no dynamic path segments)
function loadFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.cproject'), makeCproject(CVALS[dir], CPPVALS[dir], ASMVALS[dir]));
  return Cproject.load(dir);
}
const CVALS = {};
const CPPVALS = {};
const ASMVALS = {};
const set = (dir, c, cpp, asm) => {
  CVALS[dir] = c;
  CPPVALS[dir] = cpp;
  ASMVALS[dir] = asm;
};
const D = (name) => path.join(scratch, name);
const names = (dvs) => dvs.map((d) => d.name);
const vals = (d) => d.occurrences.map((o) => `${o.tool}=${o.value}`);

// ---- 1. core detection ----
{
  const dir = D('consistent');
  set(dir, ['DEBUG=1'], ['DEBUG=1'], ['DEBUG=1']);
  check('consistent lists -> no divergence', ppDivergences(loadFixture(dir)).length === 0);
}
{
  const dir = D('basic');
  set(dir, ['DEBUG=1', 'ONLY_C'], ['DEBUG=2'], []);
  const dvs = ppDivergences(loadFixture(dir));
  check('C/C++ divergence found, ASM-absent not counted', JSON.stringify(names(dvs)) === '["DEBUG"]', JSON.stringify(names(dvs)));
  check('occurrences in page order (c, cpp), ASM absent', JSON.stringify(vals(dvs[0])) === '["c=1","cpp=2"]', JSON.stringify(vals(dvs[0])));
  check('single-tool macro not flagged', !dvs.some((d) => d.name === 'ONLY_C'));
}
{
  // raw compare = the properties page macroConflicts semantics: bare NAME
  // (empty value) differs from NAME=1
  const dir = D('bare');
  set(dir, ['FOO'], ['FOO=1'], []);
  check('bare FOO vs FOO=1 -> divergent (raw semantics)', ppDivergences(loadFixture(dir)).some((d) => d.name === 'FOO'));
}
{
  // GCC: later -D wins within one command line — last entry is the value
  const dir = D('lastwins');
  set(dir, ['X=1', 'X=3'], ['X=3'], ['X=3']);
  check('duplicate entries: last wins -> consistent', ppDivergences(loadFixture(dir)).length === 0);
}
{
  const dir = D('ws');
  set(dir, ['PAD=1'], [' PAD = 1 '], []);
  check('whitespace-normalised entry matches', ppDivergences(loadFixture(dir)).length === 0);
}
{
  const dir = D('empty');
  set(dir, ['EMPTY='], ['EMPTY=1'], []);
  check('EMPTY= (explicit empty value) vs EMPTY=1 -> divergent', ppDivergences(loadFixture(dir)).some((d) => d.name === 'EMPTY'));
}
{
  const dir = D('sorted');
  set(dir, ['B=1'], ['B=2', 'A=1'], ['A=2']);
  check('divergences sorted by name', JSON.stringify(names(ppDivergences(loadFixture(dir)))) === '["A","B"]');
}

// ---- 2. host: unify flow (scripted QuickPicks) ----
const vscode = require('./vscode-stub.js');
if (!vscode.window.createOutputChannel) {
  vscode.window.createOutputChannel = () => ({ appendLine() {}, show() {}, dispose() {} });
}
const { ppCheckAfterApply, ppCheckCommand } = require('../out/vscode/ppCheck.js');

const infoMessages = [];
const warnMessages = [];
let quickPickScript = [];
const quickPickCalls = [];
vscode.window.showInformationMessage = (...a) => {
  infoMessages.push(a.join(' | '));
  return Promise.resolve(undefined);
};
vscode.window.showWarningMessage = (...a) => {
  warnMessages.push(a.join(' | '));
  return Promise.resolve(undefined);
};
vscode.window.showQuickPick = (items, options) => {
  quickPickCalls.push(options && options.title);
  const next = quickPickScript.length ? quickPickScript.shift() : undefined;
  const arr = [...items];
  return Promise.resolve(typeof next === 'function' ? next(arr, options) : next);
};

const reloadSpy = [];
const fakeStore = () => ({ reloadProject: (p) => reloadSpy.push(p.projectName), active: null });
const fakeProject = (dir, name) => ({ root: dir, projectName: name, cproject: Cproject.load(dir), reload() {} });

(async () => {
  // Apply-time check: divergent -> the unify flow opens (per-macro QuickPicks)
  // unify DEBUG=1 everywhere (C keeps, C++ rewritten in place, ASM appended)
  {
    const dir = D('unify');
    set(dir, ['DEBUG=1', 'PRIVATE_C'], ['DEBUG=2', 'PRIVATE_CPP'], []);
    loadFixture(dir);
    const before = fs.readFileSync(path.join(dir, '.cproject'));
    reloadSpy.length = 0;
    quickPickScript = [
      (items) => items.find((i) => i.value === '1'), // pick the C entry
      (items) => items.filter((i) => i.label === 'C' || i.label === 'C++' || i.label === 'Assembler'),
    ];
    await ppCheckAfterApply(fakeStore(), fakeProject(dir, 'UNIFY'));
    const cp = Cproject.load(dir);
    check('unify: value question + lists question asked', quickPickCalls.length === 2, JSON.stringify(quickPickCalls));
    check('unify: C list keeps DEBUG=1, private macro untouched', JSON.stringify(cp.listOption('c.compiler.defs').values) === '["DEBUG=1","PRIVATE_C"]');
    check('unify: C++ rewritten in place, private macro untouched', JSON.stringify(cp.listOption('cpp.compiler.defs').values) === '["DEBUG=1","PRIVATE_CPP"]');
    check('unify: ASM (absent) got the macro appended', JSON.stringify(cp.listOption('assembler.defs').values) === '["DEBUG=1"]');
    check('unify: project reloaded through the store', reloadSpy.join(',') === 'UNIFY');
    check('unify: summary message posted', infoMessages.some((m) => m.includes('1') && m.includes('UNIFY')));
    check('unify: .cproject actually rewritten', !before.equals(fs.readFileSync(path.join(dir, '.cproject'))));
    // consistent project -> COMPLETELY silent (Apply happens constantly)
    quickPickCalls.length = 0;
    infoMessages.length = 0;
    warnMessages.length = 0;
    await ppCheckAfterApply(fakeStore(), fakeProject(dir, 'UNIFY'));
    check('check: consistent project -> no QuickPick, no message, no warning', quickPickCalls.length === 0 && infoMessages.length === 0 && warnMessages.length === 0);
  }
  // skip path: nothing written
  {
    const dir = D('skip');
    set(dir, ['E=1'], ['E=2'], []);
    loadFixture(dir);
    const before = fs.readFileSync(path.join(dir, '.cproject'));
    quickPickScript = [(items) => items.find((i) => i.skip)];
    reloadSpy.length = 0;
    await ppCheckAfterApply(fakeStore(), fakeProject(dir, 'SKIP'));
    check('skip: no save, no reload', before.equals(fs.readFileSync(path.join(dir, '.cproject'))) && reloadSpy.length === 0);
    check('skip: no-change message', infoMessages.some((m) => m.toLowerCase().includes('nothing')));
  }
  // subset write: keep only C++ + ASM (C unchecked)
  {
    const dir = D('subset');
    set(dir, ['G=1'], ['G=2'], []);
    loadFixture(dir);
    quickPickScript = [(items) => items.find((i) => i.value === '2'), (items) => items.filter((i) => i.label !== 'C')];
    await ppCheckAfterApply(fakeStore(), fakeProject(dir, 'SUBSET'));
    const cp = Cproject.load(dir);
    check('subset: C untouched', JSON.stringify(cp.listOption('c.compiler.defs').values) === '["G=1"]');
    check('subset: C++ + ASM hold the picked value', cp.listOption('cpp.compiler.defs').values.join() === 'G=2' && cp.listOption('assembler.defs').values.join() === 'G=2');
  }
  // Esc on the value question (undefined pick) — nothing written, no reload
  {
    const dir = D('esc');
    set(dir, ['K=1'], ['K=2'], []);
    loadFixture(dir);
    const before = fs.readFileSync(path.join(dir, '.cproject'));
    quickPickScript = [() => undefined];
    reloadSpy.length = 0;
    infoMessages.length = 0;
    await ppCheckAfterApply(fakeStore(), fakeProject(dir, 'ESC'));
    check('esc: Esc on the value question writes nothing', before.equals(fs.readFileSync(path.join(dir, '.cproject'))) && reloadSpy.length === 0);
    check('esc: aborting the flow reports no change', infoMessages.some((m) => m.toLowerCase().includes('nothing')));
  }
  // two divergent macros confirmed in one flow -> both saved (per-macro save)
  {
    const dir = D('twomacs');
    set(dir, ['M1=1'], ['M1=2', 'M2=9'], ['M2=8']);
    loadFixture(dir);
    quickPickScript = [
      (items) => items.find((i) => i.value === '1'), // M1 -> 1
      (items) => items.filter((i) => i.label !== 'Assembler'), // write C + C++
      (items) => items.find((i) => i.value === '8'), // M2 -> asm's 8
      (items) => items.filter((i) => i.label === 'C' || i.label === 'Assembler'),
    ];
    await ppCheckAfterApply(fakeStore(), fakeProject(dir, 'TWO'));
    const cp = Cproject.load(dir);
    check('two: C holds M1=1 + appended M2=8', cp.listOption('c.compiler.defs').values.join() === 'M1=1,M2=8');
    check('two: C++ holds unified M1=1, untouched M2=9', cp.listOption('cpp.compiler.defs').values.join() === 'M1=1,M2=9');
    check('two: ASM holds M2=8', cp.listOption('assembler.defs').values.join() === 'M2=8');
    check('two: summary counts 2 macros', infoMessages.some((m) => m.includes('2') && m.includes('TWO')));
  }

  // ---- manual right-click check: same flow, but an all-clear ANSWERS ----
  {
    const dir = D('cmd-ok');
    set(dir, ['C=1'], ['C=1'], ['C=1']);
    loadFixture(dir);
    infoMessages.length = 0;
    quickPickCalls.length = 0;
    await ppCheckCommand(fakeStore(), fakeProject(dir, 'CMDOK'));
    check('command: consistent -> all-clear message, no QuickPick', infoMessages.length === 1 && quickPickCalls.length === 0);
  }
  {
    const dir = D('cmd-fix');
    set(dir, ['N=1'], ['N=2'], []);
    loadFixture(dir);
    quickPickScript = [
      (items) => items.find((i) => i.value === '1'),
      (items) => items.filter((i) => i.label === 'C' || i.label === 'C++'),
    ];
    await ppCheckCommand(fakeStore(), fakeProject(dir, 'CMDFIX'));
    const cp = Cproject.load(dir);
    check('command: divergent -> unify flow ran (C/C++ unified)', cp.listOption('c.compiler.defs').values.join() === 'N=1' && cp.listOption('cpp.compiler.defs').values.join() === 'N=1');
    check('command: command path reads a FRESH cproject (divergence seen after external edit)', quickPickCalls.length === 2);
  }

  // ---- round53 P2: an external .cproject edit made WHILE the QuickPicks
  // are open must survive the unify save (the model is re-loaded after the
  // last await; the write path holds no stale snapshot) ----
  {
    const dir = D('ext-edit');
    set(dir, ['R=1'], ['R=2'], []);
    loadFixture(dir);
    quickPickScript = [
      // during the FIRST QuickPick an external editor adds a macro on disk
      (items) => {
        const ext = Cproject.load(dir);
        ext.setOptionList('c.compiler.defs', [...ext.listOption('c.compiler.defs').values, 'EXTERNAL=9']);
        ext.save();
        return items.find((i) => i.value === '1');
      },
      (items) => items.filter((i) => i.label === 'C' || i.label === 'C++' || i.label === 'Assembler'),
    ];
    await ppCheckAfterApply(fakeStore(), fakeProject(dir, 'EXT'));
    const cpAfter = Cproject.load(dir);
    const after = fs.readFileSync(path.join(dir, '.cproject'), 'utf-8');
    check('round53 P2: external edit made during the flow SURVIVES the unify save', after.includes('EXTERNAL=9') && cpAfter.listOption('c.compiler.defs').values.join() === 'R=1,EXTERNAL=9');
  }

  // ---- round53 P2: only ONE unify flow at a time ----
  {
    const dir = D('busy');
    set(dir, ['S=1'], ['S=2'], []);
    loadFixture(dir);
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    quickPickScript = [() => firstGate]; // the first flow parks on the value question
    const firstDone = ppCheckAfterApply(fakeStore(), fakeProject(dir, 'BUSY1'));
    await new Promise((r) => setTimeout(r, 50));
    warnMessages.length = 0;
    quickPickCalls.length = 0;
    // a second (command) trigger while the flow is open gets refused loudly
    const dir2 = D('busy2');
    set(dir2, ['T=1'], ['T=2'], []);
    loadFixture(dir2);
    await ppCheckCommand(fakeStore(), fakeProject(dir2, 'BUSY2'));
    check('round53 P2: a second trigger while the flow is open gets the busy warning', warnMessages.length === 1 && quickPickCalls.length === 0, warnMessages.join(' ;; '));
    // and the Apply path skips SILENTLY (no second QuickPick for the same file)
    infoMessages.length = 0;
    const dir3 = D('busy3');
    set(dir3, ['U=1'], ['U=2'], []);
    loadFixture(dir3);
    await ppCheckAfterApply(fakeStore(), fakeProject(dir3, 'BUSY3'));
    check('round53 P2: the Apply path skips silently while the flow is open', quickPickCalls.length === 0 && infoMessages.length === 0);
    // release the first flow: skip through -> nothing written
    releaseFirst({ skip: true, label: 'skip' });
    await firstDone;
    check('round53 P2: the open flow still completes normally after a refused trigger', true);
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILURES` : '\nall ppcheck tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
