
(function () {
  function resizePF() {
    const grids = window.handsontable_flows;
    const panel = document.getElementById('df');
    const flows = document.getElementById('flows');

    if (!Array.isArray(grids) || grids.length !== 2 ||
        !panel || !flows) return;

    const width = Math.max(450, panel.clientWidth - 32);
    const height = Math.max(
      300,
      window.innerHeight - flows.getBoundingClientRect().top - 20
    );

    grids.forEach(grid => {
      const firstRow = grid.getDataAtRow(0) || [];
      let columns = 0;

      for (const cell of firstRow) {
        if (typeof cell === 'string' && cell.trim()) {
          columns++;
        } else {
          break;
        }
      }

      columns = Math.max(6, columns);

      grid.updateSettings({
        width: width,
        height: height,
        colWidths: Math.max(115, Math.floor(width / columns))
      });

      grid.render();
    });
  }

  function scheduleResize() {
    requestAnimationFrame(resizePF);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleResize);
  } else {
    scheduleResize();
  }

  window.addEventListener('resize', scheduleResize);

  document.querySelectorAll('#flow-tabs a').forEach(tab => {
    tab.addEventListener('click', () => {
      setTimeout(scheduleResize, 50);
    });
  });
})();
