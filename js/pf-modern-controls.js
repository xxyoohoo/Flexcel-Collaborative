(function () {
  'use strict';
  const grids = window.handsontable_flows;
  if (!Array.isArray(grids) || grids.length !== 2) {
    console.error('PF controls: Two Handsontable grids were not found');
    return;
  }

  const defaults = { fw: 'Framework', def: 'Definitions', im: 'Impact' };
  for (let n = 1; n <= 10; n++) defaults['c' + n] = 'Contention ' + n;
  let shortcuts = { ...defaults };
  try {
    const fromStorage = JSON.parse(localStorage.getItem('pf-autocomplete') || '{}');
    if (fromStorage && typeof fromStorage === 'object' && !Array.isArray(fromStorage)) {
      for (const [key, value] of Object.entries(fromStorage)) {
        if (/^[A-Za-z0-9_-]{1,32}$/.test(key) && typeof value === 'string' && value.length <= 400) {
          shortcuts[key] = value;
        }
      }
    }
  } catch (error) { console.warn('Autocomplete settings unavailable:', error); }

  const toolbar = document.createElement('div');
  toolbar.id = 'pf-modern-toolbar';
  toolbar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;color:white;font:13px sans-serif;';
  toolbar.innerHTML = '<button type="button" id="pf-save-button" class="btn btn-primary btn-sm">Save flow</button>' +
    '<button type="button" id="pf-open-button" class="btn btn-secondary btn-sm">Open flow</button>' +
    '<span id="pf-file-status" role="status" style="opacity:.85">PF editor · local only</span>';
  const navbar = document.getElementById('flow-navbar');
  if (navbar) navbar.insertBefore(toolbar, navbar.firstChild);
  const status = document.getElementById('pf-file-status');
  function setStatus(message) { if (status) status.textContent = message; }

  function activeTab() {
    return document.getElementById('1NC').classList.contains('active') ? 1 : 0;
  }
  function snapshot() {
    return {
      flow_type: 'PF Flow',
      'flow-data': grids.map(grid => grid.getData()),
      firstSpeaker: window.firstSpeaker === 'Con' ? 'Con' : 'Pro',
      boldElements: Array.isArray(window.bold_RC) ? window.bold_RC : [[], []]
    };
  }
  function showError(action, error) {
    console.error('PF ' + action + ' failed:', error);
    setStatus(action + ' failed');
    alert(action + ' failed: ' + error.message);
  }

  async function saveFlow() {
    try {
      if (!window.pfFiles) throw new Error('File bridge unavailable');
      // Commit an in-progress cell before reading the flow.
      for (const grid of grids) {
        const editor = grid.getActiveEditor && grid.getActiveEditor();
        if (editor && editor.isOpened && editor.isOpened()) editor.finishEditing();
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      const result = await window.pfFiles.save(snapshot());
      if (result && !result.canceled) setStatus('Saved: ' + result.name);
      else setStatus('Save canceled');
    } catch (error) { showError('Save', error); }
  }
  function updateTabLabels() {
    const conFirst = window.firstSpeaker === 'Con';
    document.getElementById('1AC').textContent = conFirst ? 'NEG' : 'AFF';
    document.getElementById('1NC').textContent = conFirst ? 'AFF' : 'NEG';
  }
  function normalizeHeader(row) {
    if (!Array.isArray(row)) return row;
    return row.map(value => typeof value === 'string'
      ? value.replace(/\bPro (?=(Constructive|Rebuttal|Summary|Final Focus)\b)/g, 'AFF ')
             .replace(/\bCon (?=(Constructive|Rebuttal|Summary|Final Focus)\b)/g, 'NEG ')
             .replace(/\bNeg (?=(Constructive|Rebuttal|Summary|Final Focus)\b)/g, 'NEG ')
      : value);
  }
  function restoreBold() {
    const cells = window.bold_RC;
    if (!Array.isArray(cells)) return;
    for (let i = 0; i < 2; i++) {
      const grid = grids[i];
      for (const cell of (cells[i] || [])) {
        if (Array.isArray(cell) && cell.length === 2 &&
            cell[0] >= 0 && cell[0] < grid.countRows() &&
            cell[1] >= 0 && cell[1] < grid.countCols()) {
          grid.setCellMeta(cell[0], cell[1], 'className', 'pf-bold-cell');
        }
      }
      grid.render();
    }
  }
  async function openFlow() {
    if (window.pfCollaborationActive && window.pfCollaborationActive()) {
      alert('Disconnect from the shared room before opening a local flow.');
      return;
    }
    if (!confirm('Open a saved flow? Any unsaved changes in the two grids will be replaced.')) return;
    try {
      if (!window.pfFiles) throw new Error('File bridge unavailable');
      const result = await window.pfFiles.open();
      if (!result || result.canceled) { setStatus('Open canceled'); return; }
      const flow = result.flow;
      window.firstSpeaker = flow.firstSpeaker;
      window.data = flow;
      window.bold_RC = Array.isArray(flow.boldElements) ? flow.boldElements : [[], []];
      for (let i = 0; i < 2; i++) {
        const oldCells = grids[i].getCellsMeta ? grids[i].getCellsMeta() : [];
        for (const cell of oldCells) {
          if (cell && cell.className === 'pf-bold-cell') {
            grids[i].setCellMeta(cell.row, cell.col, 'className', '');
          }
        }
        const rows = flow['flow-data'][i];
        const freshRows = rows.map(row => row.slice());
        freshRows[0] = normalizeHeader(freshRows[0]);
        grids[i].loadData(freshRows);
        grids[i].render();
      }
      updateTabLabels();
      restoreBold();
      window.dispatchEvent(new Event('resize'));
      setStatus('Opened: ' + result.name);
    } catch (error) { showError('Open', error); }
  }

  for (let i = 0; i < 2; i++) {
    const grid = grids[i];
    grid.addHook('afterChange', (changes, source) => {
      if (!changes || source === 'loadData' || source === 'pf-autocomplete') return;
      for (const [row, col, oldValue, nextValue] of changes) {
        if (typeof nextValue !== 'string' || typeof col !== 'number') continue;
        const revised = nextValue.split(/(\s+)/).map(word =>
          Object.prototype.hasOwnProperty.call(shortcuts, word) ? shortcuts[word] : word
        ).join('');
        if (revised !== nextValue) grid.setDataAtCell(row, col, revised, 'pf-autocomplete');
      }
      setStatus('Unsaved changes');
    });
  }

  function switchTab(delta) {
    const to = (activeTab() + delta + 2) % 2;
    const tab = document.getElementById(to === 0 ? '1AC' : '1NC');
    if (tab) tab.click();
    const grid = grids[to];
    grid.selectCell(1, 0);
  }
  function insertRow() {
    if (window.pfCollaborationActive && window.pfCollaborationActive()) {
      alert('Row insertion is disabled while sharing in this prototype. Disconnect first.');
      return;
    }
    const grid = grids[activeTab()];
    const selected = grid.getSelected();
    const row = Array.isArray(selected) ? Math.max(1, selected[0]) : 1;
    const col = Array.isArray(selected) ? Math.max(0, selected[1]) : 0;
    grid.alter('insert_row', row, 1);
    grid.selectCell(row, col);
    setStatus('Unsaved changes');
  }
  function toggleBold() {
    if (window.pfCollaborationActive && window.pfCollaborationActive()) {
      alert('Bold formatting is not synchronized yet. Disconnect first.');
      return;
    }
    const i = activeTab();
    const grid = grids[i];
    const selected = grid.getSelected();
    if (!Array.isArray(selected)) return;
    const row = selected[0], col = selected[1];
    if (row < 0 || col < 0) return;
    if (!Array.isArray(window.bold_RC)) window.bold_RC = [[], []];
    if (!Array.isArray(window.bold_RC[i])) window.bold_RC[i] = [];
    const positions = window.bold_RC[i];
    const found = positions.findIndex(rc => rc[0] === row && rc[1] === col);
    if (found >= 0) positions.splice(found, 1);
    else positions.push([row, col]);
    grid.setCellMeta(row, col, 'className', found >= 0 ? '' : 'pf-bold-cell');
    grid.render();
    setStatus('Unsaved changes');
  }
  function addShortcut() {
    const key = prompt('Autocomplete shortcut (example: c11):');
    if (key === null) return;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(key)) { alert('Use letters/numbers only (max 32).'); return; }
    const value = prompt('Expand ' + key + ' into:');
    if (value === null || !value.trim() || value.length > 400) return;
    shortcuts[key] = value;
    try { localStorage.setItem('pf-autocomplete', JSON.stringify(shortcuts)); }
    catch (error) { console.warn('Could not persist shortcuts:', error); }
    setStatus('Autocomplete shortcut added: ' + key);
  }
  const css = document.createElement('style');
  css.textContent = '.pf-bold-cell { font-weight: bold !important; }';
  document.head.appendChild(css);
  document.getElementById('pf-save-button').addEventListener('click', saveFlow);
  document.getElementById('pf-open-button').addEventListener('click', openFlow);

  document.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const inDoc = Boolean(event.target.closest && event.target.closest('.doc-container'));
    // Keep editing shortcuts inside speech documents intact, except Save/Open.
    if (inDoc && !['s', 'd'].includes(key)) return;
    let action = null;
    if (key === 's') action = saveFlow;
    if (key === 'd') action = openFlow;
    if (key === 'o') action = () => switchTab(-1);
    if (key === 'p') action = () => switchTab(1);
    if (key === 'm') action = insertRow;
    if (key === 'b') action = toggleBold;
    if (key === 't') action = addShortcut;
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      action();
    }
  }, true);
  console.log('Modern PF controls ready: Save, Open, navigation, row insertion, bold, autocomplete.');
})();
