'use strict';
// Runs on the Windows GitHub Actions runner after electron-builder produces the
// unsigned NSIS installer and win-unpacked directory. The goal is to catch
// installers that look valid but cannot start the actual PF editor.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const appPath = path.join(dist, 'win-unpacked', 'Flexcel Collaborative.exe');
const archive = path.join(dist, 'win-unpacked', 'resources', 'app.asar');
const required = [
  'main.js', 'preload.js', 'package.json', 'main-menu.html', 'pf-flow.html',
  'js/pf-display-fix.js', 'js/pf-layout-fix.js', 'js/pf-modern-controls.js',
  'collaboration/pf-collaboration.js',
  'handsontable/handsontable.full.js',
  'textboxio-client/textboxio/textboxio.js',
  'node_modules/vex-js/dist/js/vex.combined.min.js'
];

function verifyArchive() {
  assert.equal(process.platform, 'win32', 'This smoke test must run on Windows');
  assert(fs.existsSync(appPath), `Missing Windows executable: ${appPath}`);
  assert(fs.existsSync(archive), `Missing packaged source: ${archive}`);
  const packaged = new Set(asar.listPackage(archive).map(p => p.replace(/^[/\\]+/, '').replace(/\\/g, '/')));
  for (const file of required) assert(packaged.has(file), `Packaged app is missing ${file}`);
  const html = asar.extractFile(archive, 'pf-flow.html').toString('utf8');
  for (const file of ['js/pf-modern-controls.js', 'collaboration/pf-collaboration.js', 'js/pf-display-fix.js', 'js/pf-layout-fix.js']) {
    assert(html.includes(file), `PF page is not loading ${file}`);
  }
  const installers = fs.readdirSync(dist).filter(name => name.toLowerCase().endsWith('.exe'));
  assert.equal(installers.length, 1, 'Exactly one Windows installer expected');
  assert(fs.statSync(path.join(dist, installers[0])).size > 20_000_000, 'Windows installer appears too small');
  console.log('Packaging PASS: executable, installer, PF page, assets and collaboration client are present.');
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = 18000 + Math.floor(Math.random() * 20000);
const endpoint = `http://127.0.0.1:${port}/json/list`;

async function targets() {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(1800) });
  if (!response.ok) throw new Error(`Debug endpoint HTTP ${response.status}`);
  return response.json();
}

function evaluate(target, expression) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 4000 });
    const timer = setTimeout(() => finish(new Error('DevTools evaluation timed out')), 5500);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    }
    socket.once('error', finish);
    socket.once('open', () => socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: false }
    })));
    socket.on('message', message => {
      let response;
      try { response = JSON.parse(message.toString('utf8')); }
      catch (error) { return finish(error); }
      if (response.id !== 1) return;
      if (response.error || response.result?.exceptionDetails) {
        finish(new Error('Renderer evaluation failed: ' + JSON.stringify(response.error || response.result.exceptionDetails)));
      } else finish(null, response.result?.result?.value);
    });
  });
}

async function until(label, fn, timeoutMs) {
  let lastError;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) { lastError = error; }
    await pause(450);
  }
  throw new Error(`Timed out waiting for ${label}. Last error: ${lastError?.message || 'not ready'}`);
}

async function smoke() {
  let logs = '';
  const child = spawn(appPath, [
    `--remote-debugging-port=${port}`,
    '--disable-gpu',
    '--disable-software-rasterizer'
  ], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', data => { logs = (logs + data).slice(-15000); });
  child.stderr?.on('data', data => { logs = (logs + data).slice(-15000); });
  try {
    const main = await until('packaged main menu', async () => {
      const pages = await targets();
      return pages.find(p => p.type === 'page' && p.url?.includes('main-menu.html'));
    }, 60000);
    assert.equal(await evaluate(main, 'typeof window.flexcel?.openFlow'), 'function', 'Secure preload bridge is missing');
    console.log('Startup PASS: packaged Windows app opened the main menu.');

    await evaluate(main, 'window.flexcel.openFlow("pf-flow.html"); "PF navigation requested"');
    const pfData = await until('PF flowing editor and Collaborate UI', async () => {
      const pages = await targets();
      const pf = pages.find(p => p.type === 'page' && p.url?.includes('pf-flow.html'));
      if (!pf) return null;
      const result = await evaluate(pf, `(() => ({
        tabs: [document.getElementById('1AC')?.textContent?.trim(), document.getElementById('1NC')?.textContent?.trim()],
        grids: Array.isArray(window.handsontable_flows) ? window.handsontable_flows.length : 0,
        firstHeader: window.handsontable_flows?.[0]?.getDataAtCell(0,0),
        fileBridge: typeof window.pfFiles?.open === 'function',
        saveButton: !!document.getElementById('pf-save-button'),
        collab: !!document.getElementById('pf-collab-panel'),
        loaderGone: !document.querySelector('.loader'),
        visible: document.getElementById('df')?.style.visibility === 'visible'
      }))()`);
      if (result?.grids === 2 && result.collab && result.saveButton && result.loaderGone && result.visible) return result;
      return null;
    }, 60000);
    assert.deepEqual(pfData.tabs, ['AFF', 'NEG'], 'AFF/NEG tab names missing');
    assert.equal(pfData.firstHeader, 'AFF Constructive', 'First PF header incorrect');
    assert.equal(pfData.fileBridge, true, 'Save/open bridge missing');
    console.log('PF UI PASS:', JSON.stringify(pfData));
  } catch (error) {
    console.error('Packaged app output (last 15000 chars):\n' + logs);
    throw error;
  } finally {
    if (child.pid) {
      try {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        await new Promise(resolve => { killer.once('exit', resolve); killer.once('error', resolve); });
      } catch { /* Best effort cleanup */ }
    }
  }
}

(async () => {
  verifyArchive();
  await smoke();
  console.log('PHASE 5 WINDOWS TEST PASSED');
})().catch(error => { console.error(error); process.exitCode = 1; });
