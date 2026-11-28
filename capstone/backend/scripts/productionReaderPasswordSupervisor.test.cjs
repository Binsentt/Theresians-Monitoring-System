'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runBounded, cleanEnvironment, assertExecutableReady } = require('./productionReaderPasswordOperator.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('executable redirection artifacts are rejected before runtime startup', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-operator-redirect-'));
  const exe = path.join(root, 'reviewed.exe'); fs.writeFileSync(exe, 'synthetic placeholder');
  try {
    for (const suffix of ['.config', '.manifest', '.local']) {
      fs.writeFileSync(exe + suffix, 'synthetic unexpected redirection');
      assert.throws(() => assertExecutableReady(exe), /EXECUTABLE_REDIRECTION/);
      fs.unlinkSync(exe + suffix);
    }
    fs.writeFileSync(path.join(root, 'untrusted.dll'), 'synthetic placeholder');
    assert.throws(() => assertExecutableReady(exe), /EXECUTABLE_REDIRECTION/);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('supervisor uses only explicit system environment and never ambient database credentials', () => {
  const env = cleanEnvironment({ SystemRoot: 'system', PATH: 'path', PGPASSWORD: 'never', DATABASE_URL: 'never', TQ_READER_PASSFILE_SOURCE: 'never' });
  assert.deepEqual(env, { SystemRoot: 'system', PATH: 'path' });
});
test('supervisor captures completion without forwarding arbitrary child output', async () => {
  const r = await runBounded(process.execPath, ['-e', 'console.log("SYNC=PASS\\nOPERATOR_RESULT=PASS")'], { timeoutMs: 5000 });
  assert.equal(r.exitCode, 0); assert.equal(r.completed, true); assert.equal(r.outputComplete, true);
  assert.equal(Object.hasOwn(r, 'stdout'), false);
});
test('supervisor bounds a stuck worker and reports unknown without retry', async () => {
  const r = await runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 150 });
  assert.equal(r.timedOut, true); assert.equal(r.completed, false); assert.equal(r.terminated, true);
});
test('supervisor fails closed on unexpected output and output overflow', async () => {
  const bad = await runBounded(process.execPath, ['-e', 'console.log("sensitive unexpected text")'], { timeoutMs: 5000 });
  assert.equal(bad.outputComplete, false); assert.equal(bad.completed, false);
  const cap = await runBounded(process.execPath, ['-e', 'process.stdout.write("X".repeat(70000));setInterval(()=>{},1000)'], { timeoutMs: 5000 });
  assert.equal(cap.outputComplete, false); assert.equal(cap.terminated, true); assert.equal(cap.completed, false);
});
test('supervisor rejects nonzero exit, missing completion, and stderr', async () => {
  for (const code of ['process.exit(3)', 'console.log("TARGET_IDENTITY=PASS")', 'console.error("unexpected");console.log("SYNC=PASS")']) {
    assert.equal((await runBounded(process.execPath, ['-e', code], { timeoutMs: 5000 })).completed, false);
  }
});
test('supervisor rejects contradictory completion even with a zero exit', async () => {
  const r = await runBounded(process.execPath, ['-e', 'console.log("AUTH_OR_TLS=FAIL\\nSYNC=PASS\\nOPERATOR_RESULT=PASS")'], { timeoutMs: 5000 });
  assert.equal(r.completed, false);
});
test('a POSIX descendant retaining output handles cannot turn incomplete output into success', {
  skip: process.platform === 'win32' ? 'Windows Node stdio does not retain these POSIX-style inherited pipe handles' : false
}, async () => {
  const script = 'const c=require("node:child_process").spawn(process.execPath,["-e",\'process.stdout.write("TARGET_IDENTITY=PASS\\n");process.send("ready");setTimeout(()=>process.stdout.write("X"),1800)\'],{stdio:["ignore",1,2,"ipc"],windowsHide:true});c.once("message",()=>{console.log("SYNC=PASS\\nOPERATOR_RESULT=PASS");c.disconnect();c.unref()})';
  const started = Date.now();
  const r = await runBounded(process.execPath, ['-e', script], { timeoutMs: 5000 });
  assert.equal(r.outputComplete, false); assert.equal(r.completed, false);
  assert.ok(Date.now() - started < 4000);
});
