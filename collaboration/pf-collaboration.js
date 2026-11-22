/* Flexcel Collaborative Phase 3. Requires Phase 2 PF modern controls. */
(function () {
  'use strict';
  const grids = window.handsontable_flows;
  const toolbar = document.getElementById('pf-modern-toolbar');
  if (!Array.isArray(grids) || grids.length !== 2 || !toolbar) {
    console.error('Collaboration cannot initialize: PF editor controls are missing.');
    return;
  }
  const roomStatus = document.createElement('span');
  roomStatus.id = 'pf-collab-status';
  roomStatus.style.cssText = 'font-size:12px;color:#cbd5e1;margin-left:4px;';
  roomStatus.textContent = 'Not connected';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'pf-collab-toggle';
  toggle.className = 'btn btn-info btn-sm';
  toggle.textContent = 'Collaborate';
  toolbar.style.flexWrap = 'wrap';
  toolbar.style.position = 'relative';
  toolbar.style.zIndex = '10';
  toolbar.style.pointerEvents = 'auto';
  toolbar.appendChild(toggle);
  toolbar.appendChild(roomStatus);

  const panel = document.createElement('div');
  panel.id = 'pf-collab-panel';
  panel.hidden = true;
  panel.style.cssText = 'position:relative;z-index:10;pointer-events:auto;background:#20252f;color:#eef2ff;border:1px solid #4b5563;border-radius:8px;padding:10px;margin:6px 0 10px;font:13px Arial,sans-serif;';
  panel.innerHTML = `
    <div style="font-weight:bold;margin-bottom:8px;">Share this Public Forum flow</div>
    <label style="display:block;margin:5px 0;">Server WebSocket address
      <input id="pf-collab-url" type="text" value="ws://127.0.0.1:8787" spellcheck="false" style="display:block;width:100%;padding:5px;background:#111827;color:white;border:1px solid #64748b;border-radius:4px;">
    </label>
    <small style="display:block;color:#cbd5e1;margin:4px 0 8px;">Windows partners: paste the full invitation below and click Join room. Creating a room requires a running collaboration server; 127.0.0.1 is this computer, not your partner's.</small>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0;">
      <button id="pf-create-room" type="button" class="btn btn-primary btn-sm">Create room</button>
      <button id="pf-disconnect-room" type="button" class="btn btn-secondary btn-sm" disabled>Disconnect</button>
    </div>
    <label style="display:block;margin:5px 0;">Invitation received from partner
      <input id="pf-collab-join" type="text" spellcheck="false" placeholder="Paste your partner's invite here" style="display:block;width:100%;padding:5px;background:#111827;color:white;border:1px solid #64748b;border-radius:4px;">
    </label>
    <button id="pf-join-room" type="button" class="btn btn-primary btn-sm">Join room</button>
    <div id="pf-collab-invite-box" hidden style="margin-top:8px;">
      <label style="display:block;">Your invitation (share privately with your partner)
        <input id="pf-collab-invite" type="text" readonly style="display:block;width:100%;padding:5px;background:#111827;color:white;border:1px solid #64748b;border-radius:4px;">
      </label>
      <button id="pf-collab-copy" type="button" class="btn btn-secondary btn-sm" style="margin-top:5px;">Copy invite</button>
    </div>
    <div id="pf-collab-detail" role="status" style="margin-top:8px;color:#cbd5e1;">Changes sync when you commit a cell (e.g., Enter). Save a JSON backup regularly.</div>
    <small style="display:block;margin-top:8px;color:#aeb9cc;">Prototype: cell text only. Row/column changes, bold formatting, and speech documents are not shared. Room edits are saved by the server. On disconnect, reconnecting replaces local unsynced edits.</small>
  `;
  const navbar = document.getElementById('flow-navbar');
  navbar.insertBefore(panel, toolbar.nextSibling);
  const get = id => document.getElementById(id);
  const createBtn = get('pf-create-room');
  const joinBtn = get('pf-join-room');
  const disconnectBtn = get('pf-disconnect-room');
  const inviteBox = get('pf-collab-invite-box');
  const inviteInput = get('pf-collab-invite');
  const detail = get('pf-collab-detail');
  const urlInput = get('pf-collab-url');

  let socket = null;
  let connected = false;
  let connecting = false;
  let activeRoom = '';
  let appliedRevision = -1;
  let connectTimer = null;
  const CONNECT_TIMEOUT_MS = 18000;

  function clearConnectTimer() {
    if (connectTimer !== null) clearTimeout(connectTimer);
    connectTimer = null;
  }

  function note(message) { detail.textContent = message; }
  function setState(message) { roomStatus.textContent = message; }
  function uiState() {
    createBtn.disabled = connected || connecting;
    joinBtn.disabled = connected || connecting;
    disconnectBtn.disabled = !connected && !connecting;
    disconnectBtn.textContent = connecting ? 'Cancel connection' : 'Disconnect';
    urlInput.disabled = connected || connecting;
    setState(connected ? 'Connected · ' + activeRoom : connecting ? 'Connecting…' : 'Not connected');
  }
  function randHex(length) {
    const bytes = new Uint8Array(length);
    if (!window.crypto || !window.crypto.getRandomValues) throw new Error('Secure random generator unavailable');
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  function serverAddress(raw) {
    let url;
    try { url = new URL(raw.trim()); }
    catch { throw new Error('Enter a valid ws:// or wss:// server address'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Use a ws:// or wss:// address without credentials or query parameters');
    }
    return url.toString();
  }
  function getSnapshot() {
    for (const grid of grids) {
      const editor = grid.getActiveEditor && grid.getActiveEditor();
      if (editor && editor.isOpened && editor.isOpened()) editor.finishEditing();
    }
    return {
      flow_type: 'PF Flow',
      'flow-data': grids.map(grid => grid.getData()),
      firstSpeaker: window.firstSpeaker === 'Con' ? 'Con' : 'Pro',
      boldElements: Array.isArray(window.bold_RC) ? window.bold_RC : [[], []]
    };
  }
  function normalizedHeader(row) {
    return row.map(value => typeof value === 'string'
      ? value.replace(/\bPro (?=(Constructive|Rebuttal|Summary|Final Focus)\b)/g, 'AFF ')
             .replace(/\bCon (?=(Constructive|Rebuttal|Summary|Final Focus)\b)/g, 'NEG ')
             .replace(/\bNeg (?=(Constructive|Rebuttal|Summary|Final Focus)\b)/g, 'NEG ')
      : value);
  }
  function loadRoomFlow(flow) {
    if (!flow || flow.flow_type !== 'PF Flow' || !Array.isArray(flow['flow-data']) || flow['flow-data'].length !== 2) {
      throw new Error('Server sent an invalid PF flow');
    }
    window.firstSpeaker = flow.firstSpeaker === 'Con' ? 'Con' : 'Pro';
    window.data = flow;
    window.bold_RC = Array.isArray(flow.boldElements) ? flow.boldElements : [[], []];
    for (let i = 0; i < grids.length; i++) {
      const grid = grids[i];
      const prior = grid.getCellsMeta ? grid.getCellsMeta() : [];
      for (const cell of prior) {
        if (cell && cell.className === 'pf-bold-cell' && cell.row >= 0 && cell.col >= 0) {
          grid.setCellMeta(cell.row, cell.col, 'className', '');
        }
      }
      const rows = flow['flow-data'][i].map(row => row.slice());
      rows[0] = normalizedHeader(rows[0]);
      grid.loadData(rows);
      for (const rc of window.bold_RC[i] || []) {
        if (Array.isArray(rc) && rc.length === 2 && rc[0] >= 0 && rc[1] >= 0 &&
            rc[0] < grid.countRows() && rc[1] < grid.countCols()) {
          grid.setCellMeta(rc[0], rc[1], 'className', 'pf-bold-cell');
        }
      }
      grid.render();
    }
    get('1AC').textContent = window.firstSpeaker === 'Con' ? 'NEG' : 'AFF';
    get('1NC').textContent = window.firstSpeaker === 'Con' ? 'AFF' : 'NEG';
    window.dispatchEvent(new Event('resize'));
  }
  function terminate() {
    clearConnectTimer();
    const prior = socket;
    socket = null;
    connected = false;
    connecting = false;
    activeRoom = '';
    appliedRevision = -1;
    if (prior && prior.readyState < WebSocket.CLOSING) prior.close(1000, 'Disconnected');
    uiState();
  }
  function start(mode, server, room, secret, flow) {
    if (connected || connecting) throw new Error('Disconnect the current room first');
    const endpoint = serverAddress(server);
    connecting = true;
    uiState();
    note('Connecting to collaboration server…');
    let candidate;
    try { candidate = new WebSocket(endpoint); }
    catch (error) { terminate(); throw error; }
    socket = candidate;
    // A stalled handshake must not leave Create/Join disabled forever.
    connectTimer = setTimeout(() => {
      if (socket !== candidate || connected) return;
      terminate();
      note('Connection timed out. Try a fresh invitation using the current wss:// Cloudflare tunnel. You can also click Cancel connection.');
    }, CONNECT_TIMEOUT_MS);
    let connectedOnce = false;
    candidate.addEventListener('open', () => {
      candidate.send(JSON.stringify({ type: mode, room, secret, ...(mode === 'create' ? { flow } : {}) }));
    });
    candidate.addEventListener('message', event => {
      if (socket !== candidate) return;
      let msg;
      try { msg = JSON.parse(event.data); }
      catch { note('Server sent an invalid response'); return; }
      if (msg.type === 'error') {
        note('Server: ' + (typeof msg.message === 'string' ? msg.message : 'Error'));
        terminate();
        return;
      }
      if (msg.type === 'welcome') {
        try {
          if (mode === 'join') loadRoomFlow(msg.flow);
          clearConnectTimer();
          connectedOnce = true;
          connected = true;
          connecting = false;
          activeRoom = room;
          appliedRevision = msg.rev;
          inviteInput.value = 'FLEXCEL1|' + endpoint + '|' + room + '|' + secret;
          inviteBox.hidden = false;
          uiState();
          note('Room joined! ' + msg.participants + '/2 participants. Cell edits now sync live.');
        } catch (error) {
          note('Failed to open shared round: ' + error.message);
          terminate();
        }
      } else if (msg.type === 'presence' && connected) {
        note('Connected · ' + msg.participants + '/2 participants. Cells sync on commit.');
      } else if (msg.type === 'cell' && connected && Number.isSafeInteger(msg.rev) && msg.rev > appliedRevision) {
        appliedRevision = msg.rev;
        const grid = grids[msg.sheet];
        if (!grid || !Array.isArray(msg.cells)) return;
        for (const item of msg.cells) {
          if (!Array.isArray(item) || item.length !== 3) continue;
          const [row, col, value] = item;
          if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 ||
              row >= grid.countRows() || col >= grid.countCols()) continue;
          if (grid.getDataAtCell(row, col) !== value) {
            grid.setDataAtCell(row, col, value, 'pf-remote');
          }
        }
      }
    });
    candidate.addEventListener('error', () => {
      if (socket === candidate) {
        note('Connection error. Check the server or Cloudflare tunnel. On Windows, paste the full FLEXCEL1 invitation from your partner.');
      }
    });
    candidate.addEventListener('close', event => {
      if (socket !== candidate) return;
      const closeCode = event.code;
      terminate();
      note(connectedOnce
        ? 'Disconnected (WebSocket ' + closeCode + '). Local edits will NOT sync until you rejoin the room.'
        : 'Could not join the server (WebSocket ' + closeCode + '). Check the tunnel address and make sure your Mac server is running.');
    });
  }
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    window.dispatchEvent(new Event('resize'));
  });
  createBtn.addEventListener('click', () => {
    try {
      start('create', urlInput.value, randHex(8), randHex(24), getSnapshot());
    } catch (error) { note(error.message); }
  });
  joinBtn.addEventListener('click', () => {
    try {
      const parts = get('pf-collab-join').value.trim().split('|');
      if (parts.length !== 4 || parts[0] !== 'FLEXCEL1' ||
          !/^[a-f0-9]{12,24}$/.test(parts[2]) || !/^[a-f0-9]{40,64}$/.test(parts[3])) {
        throw new Error('Paste a complete FLEXCEL1 invitation');
      }
      if (!confirm('Joining a room replaces BOTH local AFF/NEG grids. Save a JSON backup first. Continue?')) return;
      start('join', parts[1], parts[2], parts[3]);
    } catch (error) { note(error.message); }
  });
  disconnectBtn.addEventListener('click', () => {
    terminate();
    note('Disconnected. You can still edit and save the local PF flow.');
  });
  get('pf-collab-copy').addEventListener('click', async () => {
    const invite = inviteInput.value;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(invite);
      note('Invite copied. Send it privately to your partner.');
    } catch {
      inviteInput.focus(); inviteInput.select();
      note('Invite selected. Press ' + (/Mac/i.test(navigator.platform) ? 'Command+C' : 'Ctrl+C') + ' to copy it.');
    }
  });
  for (let sheet = 0; sheet < 2; sheet++) {
    const grid = grids[sheet];
    grid.addHook('afterChange', (changes, source) => {
      if (!connected || !socket || socket.readyState !== WebSocket.OPEN ||
          !changes || source === 'loadData' || source === 'pf-remote') return;
      const updates = [];
      for (const change of changes) {
        const [row, col] = change;
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 ||
            row >= grid.countRows() || col >= grid.countCols()) continue;
        const value = grid.getDataAtCell(row, col);
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
          updates.push([row, col, value]);
        }
      }
      if (updates.length > 0) {
        try { socket.send(JSON.stringify({ type: 'cell', sheet, cells: updates })); }
        catch (error) { note('Could not transmit cell edit: ' + error.message); }
      }
    });
    for (const hook of ['beforeCreateRow', 'beforeRemoveRow', 'beforeCreateCol', 'beforeRemoveCol']) {
      grid.addHook(hook, () => {
        if (connected) {
          note('Row/column changes are disabled while sharing in this prototype. Disconnect first.');
          return false;
        }
      });
    }
  }
  window.pfCollaborationActive = () => connected || connecting;
  window.addEventListener('beforeunload', () => {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  });
  uiState();
  console.log('Flexcel collaborative rooms ready: Create room or paste partner invitation.');
})();
