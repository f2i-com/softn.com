#!/usr/bin/env node
/**
 * Packs three showcase `.softn` v2 containers (~1–2 KB each!) demonstrating:
 * 1. `compiled-kanban.softn`: Unmodified Vite-style `dist/` web app zipped with NO manifest.json
 * 2. `preact-fieldnotes.softn`: Zero-build TypeScript + hosted `preact`/`htm`/`marked` + `softn:db` + `<softn-chart>`
 * 3. `three-orbit.softn`: Split-Realm hosted `import * as THREE from 'three'` (0 KB Three.js in bundle!)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'bundles');
fs.mkdirSync(OUT, { recursive: true });

function writeBundle(filename, entries) {
  const raw = {};
  for (const [k, v] of Object.entries(entries)) {
    raw[k] = typeof v === 'string' ? strToU8(v) : v;
  }
  const zipped = zipSync(raw, { level: 9 });
  const target = path.join(OUT, filename);
  fs.writeFileSync(target, zipped);
  console.log(`[showcase] Built ${filename} (${zipped.byteLength} bytes)`);
}

// 1. Unmodified Compiled `dist/` Web App (NO manifest.json, NO SoftN-specific code!)
writeBundle('compiled-kanban.softn', {
  'dist/index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Kanban Dist (Zero-Config)</title>
  <link rel="stylesheet" href="/assets/app-8f2a.css">
  <script type="module" src="/assets/main-3d9c.js"></script>
</head>
<body>
  <div id="root"></div>
</body>
</html>`,
  'dist/assets/app-8f2a.css': `
    body { font-family: system-ui, sans-serif; padding: 16px; background: #0f172a; color: #f8fafc; margin: 0; }
    .hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    h2 { margin: 0; font-size: 1.05rem; }
    form { display: flex; gap: 8px; margin-bottom: 12px; }
    input[type="text"] { flex: 1; padding: 7px 10px; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #fff; }
    button { padding: 7px 12px; border-radius: 6px; border: none; background: #3b82f6; color: #fff; font-weight: 600; cursor: pointer; }
    ul { list-style: none; padding: 0; margin: 0 0 12px; display: flex; flex-direction: column; gap: 6px; }
    li { padding: 8px 10px; border-radius: 6px; background: #1e293b; border: 1px solid #334155; display: flex; justify-content: space-between; cursor: pointer; }
    li.done { opacity: 0.55; text-decoration: line-through; }
    canvas { width: 100%; height: 44px; border-radius: 6px; background: #1e293b; display: block; }
  `,
  'dist/data/initial.json': JSON.stringify([
    { id: 1, text: 'Zip Vite dist/ directly to .softn', done: true },
    { id: 2, text: 'Run inside Worker ZIPP-Lite sandbox', done: true },
    { id: 3, text: 'Click any item to toggle completion', done: false },
  ]),
  'dist/assets/chart-util-1a4b.js': `export function drawProgress(c,done,total){const g=c.getContext("2d");g.clearRect(0,0,c.width,c.height);g.fillStyle="#1e293b";g.fillRect(0,0,c.width,c.height);const pct=total?done/total:0;g.fillStyle="#22c55e";g.fillRect(8,12,Math.round((c.width-16)*pct),20);g.fillStyle="#f8fafc";g.font="12px sans-serif";g.fillText(done+" / "+total+" completed ("+Math.round(pct*100)+"%)",14,26);}`,
  'dist/assets/main-3d9c.js': `import{drawProgress as p}from"./chart-util-1a4b.js";async function start(){const r=await fetch(new URL("../data/initial.json",import.meta.url));const list=await r.json();const root=document.getElementById("root");root.innerHTML='<div class="hdr"><h2>Kanban Dist</h2><small id="meta"></small></div><form id="f"><input id="inp" type="text" placeholder="Add item..." required><button type="submit">Add</button></form><ul id="items"></ul><canvas id="bar" width="360" height="44"></canvas>';const ul=document.getElementById("items");const bar=document.getElementById("bar");const redraw=()=>{ul.innerHTML="";let done=0;for(const it of list){if(it.done)done++;const li=document.createElement("li");if(it.done)li.className="done";li.textContent=it.text;li.addEventListener("click",()=>{it.done=!it.done;redraw();});ul.appendChild(li);}document.getElementById("meta").textContent=list.length+" total";p(bar,done,list.length);};redraw();document.getElementById("f").addEventListener("submit",(e)=>{e.preventDefault();const inp=document.getElementById("inp");if(!inp.value.trim())return;list.push({id:Date.now(),text:inp.value.trim(),done:false});inp.value="";redraw();});}start();`,
});

// 2. Zero-Build TypeScript + Hosted Preact/HTM + `softn:db` + `<softn-chart>`
writeBundle('preact-fieldnotes.softn', {
  'manifest.json': JSON.stringify({
    name: 'Fieldnotes (TypeScript + Hosted Preact)',
    version: '2.0.0',
    // A bundle with a manifest says which engine runs it; without this it is a SoftN bundle.
    engine: 2,
    main: 'index.html',
    theme: 'dark',
  }),
  'notes.xdb': JSON.stringify({
    collection: 'notes',
    records: [
      { id: 'n1', title: 'Zero React in host runtime', points: 18 },
      { id: 'n2', title: 'TypeScript runs with no bundler', points: 29 },
      { id: 'n3', title: 'Worker-local sync softn:db', points: 42 },
    ],
  }),
  'index.html': `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="softn:ui.css">
  <script type="module" src="./app.ts"></script>
</head>
<body class="stack gap-md" style="padding:16px">
  <div id="mount"></div>
</body>
</html>`,
  'app.ts': `
import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';
import { db } from 'softn:db';

interface Note {
  id: string;
  title: string;
  points: number;
}

const html = htm.bind(h);

function App() {
  const [notes, setNotes] = useState<Note[]>(() => db.query('notes') as Note[]);

  const addSample = () => {
    const pts = Math.floor(15 + Math.random() * 40);
    db.create('notes', { title: 'Note #' + (notes.length + 1), points: pts });
    setNotes(db.query('notes') as Note[]);
  };

  const valuesJson = JSON.stringify(notes.map((n: Note) => n.points));

  return html\`
    <div class="stack gap-sm">
      <div class="row between">
        <strong>Fieldnotes TS + Preact</strong>
        <button class="btn primary" onClick=\${addSample}>+ Add Metric</button>
      </div>
      <softn-chart type="bar" color="#3b82f6" values=\${valuesJson}></softn-chart>
      <softn-datagrid columns="title,points" rows=\${JSON.stringify(notes)}></softn-datagrid>
    </div>
  \`;
}

render(html\`<\${App} />\`, document.getElementById('mount'));
`,
});

// 3. Split-Realm Hosted Three.js (`import * as THREE from 'three'`, 0 KB Three.js in bundle!)
writeBundle('three-orbit.softn', {
  'manifest.json': JSON.stringify({
    name: 'Hosted Three.js Split-Realm',
    version: '2.0.0',
    // A bundle with a manifest says which engine runs it; without this it is a SoftN bundle.
    engine: 2,
    main: 'index.html',
    theme: 'dark',
  }),
  'index.html': `<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; padding: 14px; background: #0f172a; color: #f8fafc; font-family: system-ui, sans-serif; }
    .bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    button { padding: 5px 10px; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #f8fafc; cursor: pointer; }
    canvas { width: 100%; height: 220px; border-radius: 8px; display: block; background: #020617; }
  </style>
  <script type="module" src="./scene.js"></script>
</head>
<body>
  <div class="bar">
    <strong>Split-Realm Three.js (1.1 KB bundle!)</strong>
    <button id="color-btn" type="button">Cycle Color</button>
  </div>
  <canvas id="gl" width="420" height="220"></canvas>
</body>
</html>`,
  'scene.js': `
import * as THREE from 'three';

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(420, 220);
renderer.setClearColor(0x020617, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 420 / 220, 0.1, 100);
camera.position.set(0, 1.15, 3.3);
camera.lookAt(0, 0, 0);

const palette = [0x3b82f6, 0x10b981, 0xf59e0b, 0xec4899];
let colorIdx = 0;

let activeMesh = new THREE.Mesh(
  new THREE.TorusGeometry(0.85, 0.28, 24, 48),
  new THREE.MeshStandardMaterial({ color: palette[0], roughness: 0.3, metalness: 0.25 })
);
scene.add(activeMesh);
scene.add(new THREE.AmbientLight(0xffffff, 0.85));

const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
keyLight.position.set(3, 4, 5);
scene.add(keyLight);

document.getElementById('color-btn').addEventListener('click', () => {
  colorIdx = (colorIdx + 1) % palette.length;
  const rx = activeMesh.rotation.x;
  const ry = activeMesh.rotation.y;
  scene.remove(activeMesh);
  activeMesh = new THREE.Mesh(
    new THREE.TorusGeometry(0.85, 0.28, 24, 48),
    new THREE.MeshStandardMaterial({ color: palette[colorIdx], roughness: 0.3, metalness: 0.25 })
  );
  activeMesh.rotation.set(rx, ry, 0);
  scene.add(activeMesh);
});

function tick(ts) {
  const t = ts * 0.001;
  activeMesh.rotation.set(t * 0.7, t * 1.1, 0);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
`,
});
