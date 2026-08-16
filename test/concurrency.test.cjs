/**
 * Regression test for concurrent-write corruption.
 *
 * Each open IDE window runs its own extension host, and they all patch the SAME
 * Claude Code files on disk. Before the lock/atomic-write fix, their
 * copyFile + read + write cycles interleaved and truncated the shared files
 * (observed in the wild: webview/index.js shrinking from 4.8 MB to ~1 MB, which
 * blanked the Claude panel).
 *
 * This test simulates several windows patching one extension simultaneously and
 * asserts that the result is never truncated, backups stay pristine, injection
 * doesn't stack, and removal restores the original.
 *
 * Run via `npm test` (compiles src -> out-test first).
 */
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const assert = require('assert');
process.env.NODE_ENV = 'test';
process.env.RTL_TEST_LOCK_TIMEOUT_MS = '250';
const { addRtlAuto, addRtlAlways, removeRtl, getStatus, isModeFullyInstalled } = require('../out-test/injector.js');
const {
  PLAN_CSS_START_MARKER, PLAN_JS_START_MARKER, RTL_AUTO_JS_CODE,
  JS_MODE_ACTIVE_MARKER, JS_MODE_AUTO_MARKER,
  PLAN_JS_MODE_ACTIVE_MARKER, PLAN_JS_MODE_AUTO_MARKER,
} = require('../out-test/content.js');

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccrtl-race-'));
  const extDir = path.join(tmp, 'anthropic.claude-code-9.9.9-test');
  const webview = path.join(extDir, 'webview');
  await fs.mkdir(webview, { recursive: true });

  const cssPath = path.join(webview, 'index.css');
  const jsPath = path.join(webview, 'index.js');
  const extensionJsPath = path.join(extDir, 'extension.js');

  // index.js is large (~5 MB) — the file that got truncated in the wild.
  const bigJs = '/* claude code webview bundle */\n' + 'a'.repeat(5_000_000) + '\nexport{};\n';
  const css = ':root{--x:1}\n.foo{color:red}\n';
  // extension.js carries the Plan Preview template the injector edits.
  const extJs =
    'globalThis.x=1;\n<style>.p{a:b}</style>\n<div id="content"></div>\n' +
    "vscode.postMessage({ type: 'ready' })\n";

  await fs.writeFile(jsPath, bigJs);
  await fs.writeFile(cssPath, css);
  await fs.writeFile(extensionJsPath, extJs);

  const origJs = (await fs.stat(jsPath)).size;
  const origCss = (await fs.stat(cssPath)).size;
  const origExt = (await fs.stat(extensionJsPath)).size;

  const ext = {
    dir: extDir,
    cssPath,
    jsPath,
    extensionJsPath,
    name: 'anthropic.claude-code-9.9.9-test',
  };

  // A stale lock must fail closed without touching target files. Users can
  // remove it manually only after closing all IDE windows.
  const staleLock = path.join(extDir, '.ybyrtl.lock');
  await fs.writeFile(staleLock, '999999999');
  await assert.rejects(
    addRtlAuto(ext),
    (error) => error.message.includes('remove this lock manually') && error.message.includes(staleLock),
    'stale lock did not fail closed with manual recovery instructions',
  );
  assert.strictEqual(await fs.readFile(jsPath, 'utf-8'), bigJs, 'mutation ran while stale lock existed');
  assert.strictEqual(await fs.readFile(staleLock, 'utf-8'), '999999999', 'stale lock was reclaimed automatically');
  await fs.rm(staleLock);
  process.env.RTL_TEST_LOCK_TIMEOUT_MS = '5000';

  // Simulate N IDE windows patching the SAME files at once.
  const WINDOWS = 8;
  await Promise.all(Array.from({ length: WINDOWS }, () => addRtlAuto(ext)));

  const finalJs = (await fs.stat(jsPath)).size;
  const finalCss = (await fs.stat(cssPath)).size;
  const finalExt = (await fs.stat(extensionJsPath)).size;

  // 1. No truncation: injection only adds, so the result must be >= original.
  assert.ok(finalJs >= origJs, `index.js truncated! ${finalJs} < ${origJs}`);
  assert.ok(finalCss >= origCss, `index.css shrank! ${finalCss} < ${origCss}`);
  assert.ok(finalExt >= origExt, `extension.js shrank! ${finalExt} < ${origExt}`);

  // 2. Backups are the pristine originals.
  assert.strictEqual((await fs.stat(jsPath + '.bak')).size, origJs, 'js backup size drift');
  assert.strictEqual((await fs.stat(cssPath + '.bak')).size, origCss, 'css backup size drift');

  // 3. Injection happened exactly once — never stacked across windows.
  const jsContent = await fs.readFile(jsPath, 'utf-8');
  const cssContent = await fs.readFile(cssPath, 'utf-8');
  const jsMarkers = (jsContent.match(/RTL Toggle Button - Added by script/g) || []).length;
  assert.ok(cssContent.length > origCss, 'css RTL rules not injected');
  assert.ok(jsMarkers <= 1, `JS injected ${jsMarkers}x (must never stack)`);
  assert.ok(bigJs.length <= jsContent.length, 'original JS body lost');

  // 4. No lock / temp litter left behind.
  const leftovers = (await fs.readdir(extDir))
    .concat(await fs.readdir(webview))
    .filter((f) => f.includes('.ybyrtl.lock') || f.includes('.ybytmp'));
  assert.strictEqual(leftovers.length, 0, `leftover lock/tmp files: ${leftovers}`);

  // 5. If an injected file is truncated, its known-good backup wins instead of
  //    being replaced by the corrupt marker-bearing file.
  await fs.writeFile(jsPath, '/* truncated vendor bundle */\n' + RTL_AUTO_JS_CODE);
  await addRtlAuto(ext);
  assert.ok((await fs.readFile(jsPath, 'utf-8')).includes('claude code webview bundle'), 'known-good JS backup was not used');
  assert.strictEqual((await fs.stat(jsPath + '.bak')).size, origJs, 'corrupt marker-bearing file replaced JS backup');

  await fs.writeFile(jsPath, bigJs.slice(0, 1_000_000));
  await addRtlAuto(ext);
  assert.ok((await fs.readFile(jsPath, 'utf-8')).includes('claude code webview bundle'), 'markerless truncation replaced known-good JS backup');
  assert.strictEqual((await fs.stat(jsPath + '.bak')).size, origJs, 'markerless truncation replaced JS backup');

  // 6. A clean vendor update in the same directory replaces stale backups instead of
  //    being overwritten by them during reinjection.
  const updatedJs = '/* updated vendor webview */\n' + 'b'.repeat(1_000_000);
  const updatedCss = ':root{--vendor-version:2}\n';
  const updatedExtJs =
    'globalThis.vendorVersion=2;\n<style>.p{version:2}</style>\n<div id="content"></div>\n' +
    "vscode.postMessage({ type: 'ready' })\n";
  await fs.writeFile(jsPath, updatedJs);
  await fs.writeFile(cssPath, updatedCss);
  await fs.writeFile(extensionJsPath, updatedExtJs);
  await addRtlAuto(ext);

  assert.ok((await fs.readFile(jsPath, 'utf-8')).includes('updated vendor webview'), 'stale JS backup overwrote vendor update');
  assert.ok((await fs.readFile(cssPath, 'utf-8')).includes('--vendor-version:2'), 'stale CSS backup overwrote vendor update');
  assert.ok((await fs.readFile(extensionJsPath, 'utf-8')).includes('vendorVersion=2'), 'stale Plan backup overwrote vendor update');
  assert.strictEqual(await fs.readFile(jsPath + '.bak', 'utf-8'), updatedJs, 'JS backup was not refreshed');
  assert.strictEqual(await fs.readFile(cssPath + '.bak', 'utf-8'), updatedCss, 'CSS backup was not refreshed');

  const [healthy] = await getStatus([ext]);
  assert.ok(isModeFullyInstalled(healthy, 'auto'), 'complete Auto installation reported unhealthy');
  assert.ok(!isModeFullyInstalled({ ...healthy, jsInstalled: false }, 'auto'), 'Auto mode ignored missing webview JS');
  assert.ok(!isModeFullyInstalled({ ...healthy, planPreviewJsInstalled: false }, 'auto'), 'Auto mode ignored missing Plan JS');
  assert.ok(!isModeFullyInstalled({ ...healthy, mode: 'inactive', planPreviewJsInstalled: true }, 'inactive'), 'Inactive mode ignored leftover Plan JS');

  await fs.writeFile(jsPath, (await fs.readFile(jsPath, 'utf-8')).replace(JS_MODE_AUTO_MARKER, JS_MODE_ACTIVE_MARKER));
  await fs.writeFile(extensionJsPath, (await fs.readFile(extensionJsPath, 'utf-8')).replace(PLAN_JS_MODE_AUTO_MARKER, PLAN_JS_MODE_ACTIVE_MARKER));
  const [wrongInteractiveMode] = await getStatus([ext]);
  assert.strictEqual(wrongInteractiveMode.mode, 'auto', 'test setup changed CSS mode');
  assert.ok(!isModeFullyInstalled(wrongInteractiveMode, 'auto'), 'Auto mode accepted Active interactive scripts');
  await addRtlAuto(ext);

  // 7. Older Claude versions without the Plan Preview template remain healthy.
  const unsupportedPlan = path.join(extDir, 'unsupported-extension.js');
  await fs.writeFile(unsupportedPlan, 'module.exports = {};\n');
  const unsupportedExt = { ...ext, extensionJsPath: unsupportedPlan };
  await addRtlAuto(unsupportedExt);
  const [unsupportedStatus] = await getStatus([unsupportedExt]);
  assert.strictEqual(unsupportedStatus.planPreviewSupported, false, 'unsupported Plan template reported supported');
  assert.ok(isModeFullyInstalled(unsupportedStatus, 'auto'), 'unsupported optional Plan template made Auto unhealthy');

  const noReadyPlan = path.join(extDir, 'no-ready-extension.js');
  await fs.writeFile(noReadyPlan, '<style>.p{version:3}</style>\n<div id="content"></div>\n');
  const noReadyExt = { ...ext, extensionJsPath: noReadyPlan };
  await addRtlAuto(noReadyExt);
  const [noReadyStatus] = await getStatus([noReadyExt]);
  assert.strictEqual(noReadyStatus.planPreviewSupported, true, 'static Plan injection points should be supported');
  assert.strictEqual(noReadyStatus.planPreviewInteractiveSupported, false, 'missing ready hook reported interactive support');
  assert.ok(!noReadyStatus.planPreviewInstalled, 'partial Plan CSS was injected without its required JS hook');
  assert.ok(isModeFullyInstalled(noReadyStatus, 'auto'), 'unsupported interactive Plan template made Auto unhealthy');

  // 8. Noninteractive modes are unhealthy if restoring the webview JS backup
  //    fails and leaves an old toggle/observer behind.
  await fs.rm(jsPath + '.bak');
  await addRtlAlways(ext);
  const [incompleteAlways] = await getStatus([ext]);
  assert.strictEqual(incompleteAlways.mode, 'always', 'Always CSS mode was not installed');
  assert.ok(incompleteAlways.jsInstalled, 'test setup did not retain interactive JS');
  assert.ok(!isModeFullyInstalled(incompleteAlways, 'always'), 'Always mode ignored leftover interactive JS');

  // 9. removeRtl strips Plan markers even when its backup has gone missing.
  await fs.rm(extensionJsPath + '.bak');
  await removeRtl(ext);
  const restoredJs = (await fs.stat(jsPath)).size;
  assert.strictEqual(restoredJs, Buffer.byteLength(updatedJs), 'removeRtl did not restore updated index.js');
  const restoredPlan = await fs.readFile(extensionJsPath, 'utf-8');
  assert.ok(restoredPlan.includes('vendorVersion=2'), 'Plan fallback lost vendor content');
  assert.ok(!restoredPlan.includes(PLAN_CSS_START_MARKER), 'Plan CSS marker remained without backup');
  assert.ok(!restoredPlan.includes(PLAN_JS_START_MARKER), 'Plan JS marker remained without backup');

  console.log(`PASS — ${WINDOWS} concurrent windows, no corruption`);
  console.log(`  index.js  orig=${origJs} inject=${finalJs} remove=${restoredJs}`);
  console.log(`  index.css orig=${origCss} inject=${finalCss}`);
  console.log(`  JS markers after race: ${jsMarkers} (no stacking)`);

  await fs.rm(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
