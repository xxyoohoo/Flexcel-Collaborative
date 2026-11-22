
(function () {
  function showPF() {
    const grids = window.handsontable_flows;

    if (!Array.isArray(grids) || grids.length !== 2) {
      console.error('PF grids did not initialize');
      return;
    }

    ['df', 'flow-navbar', 'flows', 'sd'].forEach(id => {
      const element = document.getElementById(id);
      if (element) element.style.visibility = 'visible';
    });

    document.querySelectorAll('.loader').forEach(el => el.remove());

    grids.forEach(grid => grid.render());
    console.log('PF spreadsheet displayed');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showPF, { once: true });
  } else {
    showPF();
  }
})();
