import { React, createRoot } from './vendor/react.js';

const h = React.createElement;

function PracticeCounter() {
  const [rounds, setRounds] = React.useState(() => Number(localStorage.getItem('rounds')) || 0);

  function save(next) {
    setRounds(next);
    localStorage.setItem('rounds', String(next));
  }

  return h(React.Fragment, null,
    h('section', { className: 'counter', 'aria-labelledby': 'metric' },
      h('h2', { id: 'metric' }, 'Rounds completed'),
      h('output', { id: 'value', 'aria-live': 'polite' }, rounds),
    ),
    h('div', { className: 'actions' },
      h('button', { id: 'increment', type: 'button', onClick: () => save(rounds + 1) }, 'Finish a round'),
      h('button', { id: 'reset', type: 'button', disabled: rounds === 0, onClick: () => save(0) }, 'Reset'),
    ),
  );
}

createRoot(document.getElementById('app')).render(h(PracticeCounter));
