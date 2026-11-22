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

// Dispatch real mouse events through Chrome DevTools, rather than DOM .click().
// This catches UI overlays that can make visible buttons impossible to press.
function physicalClick(target, x, y) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 4000 });
    let done = false;
    const timer = setTimeout(() => finish(new Error('Physical button click timed out')), 7000);
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve();
    }
    socket.once('error', finish);
    const pos = { x, y, button: 'left', clickCount: 1 };
    socket.once('open', () => socket.send(JSON.stringify({
      id: 1, method: 'Input.dispatchMouseEvent', params: { ...pos, type: 'mousePressed' }
    })));
    socket.on('message', raw => {
      let result;
      try { result = JSON.parse(raw.toString('utf8')); }
      catch (error) { return finish(error); }
      if (result.id === 1) {
        if (result.error) return finish(new Error('Mouse press failed: ' + JSON.stringify(result.error)));
        socket.send(JSON.stringify({
          id: 2, method: 'Input.dispatchMouseEvent', params: { ...pos, type: 'mouseReleased' }
        }));
      }
      if (result.id === 2) {
        if (result.error) return finish(new Error('Mouse release failed: ' + JSON.stringify(result.error)));
        finish();
      }
    });
  });
}

async function clickButton(target, id) {
  const hit = await evaluate(target, `(() => {
    const button = document.getElementById(${JSON.stringify(id)});
    if (!button) return { error: 'Button not present' };
    const r = button.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const upper = document.elementFromPoint(x, y);
    return {
      x, y, disabled: button.disabled, width: r.width, height: r.height,
      visible: getComputedStyle(button).visibility,
      pointerEvents: getComputedStyle(button).pointerEvents,
      hit: upper?.id || upper?.tagName || 'none',
      clickable: upper === button || button.contains(upper)
    };
  })()`);
  assert(hit?.clickable && !hit.disabled && hit.width > 0 && hit.height > 0 &&
    hit.visible === 'visible' && hit.pointerEvents !== 'none',
  `Button ${id} is blocked or disabled: ${JSON.stringify(hit)}`);
  await physicalClick(target, hit.x, hit.y);
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

// Real Windows application test: Create, Disconnect, Join, and edit a cell
// with a second WebSocket peer connected to the same room.
async function verifyRoomControls(pf) {
  const roomPort = 41000 + Math.floor(Math.random() * 7000);
  const serverAddress = `ws://127.0.0.1:${roomPort}`;
  const privateFile = path.join(dist, `phase6-test-rooms-${roomPort}.json`);
  const server = spawn(process.execPath, [path.join(root, 'collaboration/server.js')], {
    cwd: root,
    env: {
      ...process.env, FLEXCEL_PORT: String(roomPort), FLEXCEL_HOST: '127.0.0.1',
      FLEXCEL_ROOMS_FILE: privateFile
    },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLogs = '';
  server.stderr?.on('data', d => { serverLogs += d.toString(); });
  server.stdout?.on('data', d => { serverLogs += d.toString(); });
  let partner = null;
  try {
    await until('local collaboration test server', async () => {
      const response = await fetch(`http://127.0.0.1:${roomPort}/health`, {
        signal: AbortSignal.timeout(1200)
      });
      return response.ok && (await response.json()).service === 'flexcel-collaboration';
    }, 15000);

    await clickButton(pf, 'pf-collab-toggle');
    assert.equal(await evaluate(pf, '!document.getElementById("pf-collab-panel").hidden'), true,
      'Collaborate did not open with a real mouse click');
    console.log('Click PASS: Collaborate panel opens on Windows.');

    await evaluate(pf, `document.getElementById('pf-collab-url').value = ${JSON.stringify(serverAddress)}; true`);
    await clickButton(pf, 'pf-create-room');
    const createdInvite = await until('Create room via actual mouse click', async () => {
      const state = await evaluate(pf, `(() => ({
        status: document.getElementById('pf-collab-status').textContent,
        detail: document.getElementById('pf-collab-detail').textContent,
        invite: document.getElementById('pf-collab-invite').value
      }))()`);
      if (state?.detail.startsWith('Server:') || state?.detail.startsWith('Could not')) {
        throw new Error('Create room rejected: ' + JSON.stringify(state));
      }
      return state?.status.startsWith('Connected') && state.invite.startsWith(`FLEXCEL1|${new URL(serverAddress).toString()}|`)
        ? state.invite : null;
    }, 15000);
    assert(createdInvite, 'Create room did not return an invitation');
    console.log('Create room PASS: Windows app connected to the server.');

    await clickButton(pf, 'pf-disconnect-room');
    assert.equal(await evaluate(pf, `document.getElementById('pf-collab-status').textContent`), 'Not connected',
      'Disconnect button did not reset connection status');
    console.log('Disconnect PASS: Windows controls re-enabled.');
    // Let the server remove the old peer before the same room is rejoined.
    await pause(800);

    await evaluate(pf, `(() => {
      document.getElementById('pf-collab-join').value = ${JSON.stringify(createdInvite)};
      window.confirm = () => true;
      return true;
    })()`);
    await clickButton(pf, 'pf-join-room');
    await until('Join room via actual mouse click', async () => {
      const status = await evaluate(pf, `document.getElementById('pf-collab-status').textContent`);
      return status?.startsWith('Connected');
    }, 15000);
    console.log('Join room PASS: Windows app rejoined the same room.');

    const [prefix, serverUrl, roomId, secret] = createdInvite.split('|');
    assert.equal(prefix, 'FLEXCEL1');
    partner = new WebSocket(serverUrl, { handshakeTimeout: 5000 });
    const peer = partner;
    const receivedCells = [];
    peer.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString('utf8'));
        if (message.type === 'cell') receivedCells.push(message);
      } catch { /* Ignore malformed test messages */ }
    });
    const welcome = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Partner join timed out')), 10000);
      peer.once('error', error => { clearTimeout(timer); reject(error); });
      peer.once('open', () => peer.send(JSON.stringify({ type: 'join', room: roomId, secret })));
      peer.on('message', function onWelcome(raw) {
        let msg;
        try { msg = JSON.parse(raw.toString('utf8')); }
        catch { return; }
        if (msg.type === 'welcome' || msg.type === 'error') {
          peer.off('message', onWelcome);
          clearTimeout(timer);
          msg.type === 'welcome' ? resolve(msg) : reject(new Error('Partner rejected: ' + msg.message));
        }
      });
    });
    assert.equal(welcome.participants, 2, 'Second peer did not join the same room');

    peer.send(JSON.stringify({ type: 'cell', sheet: 0, cells: [[1, 0, 'PARTNER-TO-WINDOWS']] }));
    await until('partner cell edit in Windows grid', async () =>
      (await evaluate(pf, `window.handsontable_flows[0].getDataAtCell(1, 0)`)) === 'PARTNER-TO-WINDOWS', 12000);

    await evaluate(pf, `window.handsontable_flows[0].setDataAtCell(1, 1, 'WINDOWS-TO-PARTNER', 'edit'); true`);
    await until('Windows cell edit received by partner', async () =>
      receivedCells.some(m => m.cells?.some(c => c[0] === 1 && c[1] === 1 && c[2] === 'WINDOWS-TO-PARTNER')),
      12000);
    console.log('LIVE COLLAB PASS: real Windows clicks, create/join and bidirectional cell sync.');
  } catch (error) {
    console.error('Collaboration test server output:\n' + serverLogs);
    throw error;
  } finally {
    if (partner) partner.close();
    if (server.pid) {
      try {
        const killer = spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        await new Promise(resolve => { killer.once('exit', resolve); killer.once('error', resolve); });
      } catch { /* Best effort cleanup */ }
    }
    try { fs.rmSync(privateFile, { force: true }); } catch { /* Best effort cleanup */ }
    try { fs.rmSync(privateFile + '.tmp', { force: true }); } catch { /* Best effort cleanup */ }
  }
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
    const pf = (await targets()).find(page => page.type === 'page' && page.url?.includes('pf-flow.html'));
    assert(pf, 'PF editor page disappeared');
    await verifyRoomControls(pf);
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
