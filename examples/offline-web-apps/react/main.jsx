import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [dose, setDose] = useState(() => {
    const saved = Number(localStorage.getItem('dose'));
    return Number.isInteger(saved) && saved >= 5 && saved <= 60 ? saved : 20;
  });
  function changeDose(next) {
    setDose(next);
    localStorage.setItem('dose', String(next));
  }
  return (
    <main className="recipe">
      <header>
        <p>Pour-over calculator</p>
        <h1>Ratio Bar</h1>
      </header>
      <section aria-label="Coffee recipe">
        <div className="dose">
          <h2>Coffee dose</h2>
          <div className="stepper">
            <button type="button" aria-label="One gram less" disabled={dose <= 5} onClick={() => changeDose(dose - 1)}>−</button>
            <output aria-label="Ground coffee">{dose} g</output>
            <button id="more" type="button" aria-label="One gram more" disabled={dose >= 60} onClick={() => changeDose(dose + 1)}>+</button>
          </div>
        </div>
        <div className="water">
          <h2>Water to pour</h2>
          <output id="water" aria-live="polite">{dose * 16} g</output>
          <p>16 g of water per gram of coffee</p>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
