import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

function PracticeCounter() {
  const [rounds, setRounds] = useState(() => Number(localStorage.getItem('rounds')) || 0);

  function save(next) {
    setRounds(next);
    localStorage.setItem('rounds', String(next));
  }

  return (
    <>
      <section className="counter" aria-labelledby="metric">
        <h2 id="metric">Rounds completed</h2>
        <output id="value" aria-live="polite">{rounds}</output>
      </section>
      <div className="actions">
        <button id="increment" type="button" onClick={() => save(rounds + 1)}>Finish a round</button>
        <button id="reset" type="button" disabled={rounds === 0} onClick={() => save(0)}>Reset</button>
      </div>
    </>
  );
}

createRoot(document.getElementById('app')).render(<PracticeCounter />);
