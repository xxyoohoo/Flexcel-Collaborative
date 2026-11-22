'use strict';

const flowButtons = {
  'Plan-Flow-1AC': 'plan-flow.html',
  'Traditional-Flow-1AC': 'traditional-flow.html',
  pf: 'pf-flow.html',
  policy: 'policy-flow-dynamic.html'
};

Object.entries(flowButtons).forEach(([buttonId, page]) => {
  const button = document.getElementById(buttonId);
  if (!button) return;

  button.addEventListener('click', (event) => {
    event.preventDefault();
    window.flexcel.openFlow(page).catch((error) => {
      console.error('Unable to open flow:', error);
      alert('Unable to open the requested flow. Check the developer console.');
    });
  });
});
