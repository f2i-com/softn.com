const root = document.getElementById('app');
root.innerHTML = `
  <section class="counter" aria-labelledby="metric">
    <h2 id="metric">Sections walked</h2>
    <output id="value" aria-live="polite">0</output>
  </section>
  <div class="actions">
    <button id="increment" type="button">Log a section</button>
    <button id="reset" type="button">Reset</button>
  </div>
`;

const value = document.getElementById('value');
const reset = document.getElementById('reset');
let count = Number(localStorage.getItem('sections')) || 0;

function render() {
  value.textContent = String(count);
  reset.disabled = count === 0;
}

function save(next) {
  count = next;
  localStorage.setItem('sections', String(count));
  render();
}

document.getElementById('increment').addEventListener('click', () => save(count + 1));
reset.addEventListener('click', () => save(0));
render();
