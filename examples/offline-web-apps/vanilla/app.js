const gear = [
  ['water', 'Water bottle'],
  ['snack', 'Trail snacks'],
  ['map', 'Map and compass'],
  ['shell', 'Rain shell'],
  ['aid', 'First aid kit'],
];

const packed = new Set((localStorage.getItem('packed') || '').split(',').filter(Boolean));
const summary = document.getElementById('summary');
const list = document.getElementById('gear');

function updateSummary() {
  const count = gear.filter(([id]) => packed.has(id)).length;
  summary.textContent = count + ' of ' + gear.length + ' packed';
}

for (const [id, name] of gear) {
  const item = document.createElement('li');
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'pack-' + id;
  checkbox.checked = packed.has(id);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) packed.add(id);
    else packed.delete(id);
    localStorage.setItem('packed', [...packed].join(','));
    updateSummary();
  });
  const text = document.createElement('span');
  text.textContent = name;
  label.append(checkbox, text);
  item.appendChild(label);
  list.appendChild(item);
}

updateSummary();
