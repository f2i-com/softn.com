<script setup>
import { ref } from 'vue';

const palettes = [
  { name: 'Tide pool', colors: ['#164E63', '#227C83', '#8AC7AD', '#F5E9C5'] },
  { name: 'Canyon', colors: ['#5B3548', '#A65954', '#DC985D', '#FADEA3'] },
  { name: 'Orchard', colors: ['#353D26', '#657841', '#B2AC57', '#F2C2A3'] },
];
const selected = ref(palettes.find((palette) => palette.name === localStorage.getItem('palette')) || palettes[0]);
function choose(palette) {
  selected.value = palette;
  localStorage.setItem('palette', palette.name);
}
</script>

<template>
  <main>
    <h1>Swatchbook</h1>
    <div class="choices" role="group" aria-label="Color palette">
      <button v-for="palette in palettes" :key="palette.name" type="button"
        :aria-pressed="selected.name === palette.name" @click="choose(palette)">{{ palette.name }}</button>
    </div>
    <section>
      <h2 id="palette" aria-live="polite">{{ selected.name }}</h2>
      <ul aria-label="Palette colors">
        <li v-for="color in selected.colors" :key="color">
          <div class="swatch" :style="{ backgroundColor: color }"></div>
          <code>{{ color }}</code>
        </li>
      </ul>
    </section>
  </main>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #efeef6; color: #262540; font-family: "Inter", system-ui, sans-serif; }
main { max-width: 48rem; margin: clamp(1rem, 6vw, 5rem) auto; padding: clamp(1rem, 5vw, 3rem); }
h1 { margin: 0; font: 500 clamp(3rem, 10vw, 6.2rem)/1 "Instrument Serif", Georgia, serif; letter-spacing: -.06em; }
.choices { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1.6rem 0 2rem; }
button { cursor: pointer; padding: .7rem 1rem; min-height: 2.75rem; border: 1px solid #a8a4bb; border-radius: 2rem; background: transparent; color: #39354f; font: 600 .9rem/1.2 "Inter", system-ui, sans-serif; }
button[aria-pressed="true"] { background: #30294f; color: #fff; border-color: #30294f; }
button:focus-visible { outline: 3px solid #585198; outline-offset: 2px; }
section { background: #fffdf9; border: 1px solid #d5d1de; padding: clamp(1rem, 4vw, 2rem); box-shadow: .35rem .35rem 0 #d9d4e6; }
h2 { margin: 0 0 1.15rem; font: 500 1.75rem/1.1 "Instrument Serif", Georgia, serif; }
ul { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .4rem; }
.swatch { height: clamp(7rem, 24vw, 13rem); }
code { display: block; padding-top: .6rem; font: .82rem/1.3 "IBM Plex Mono", monospace; }
@media (max-width: 30rem) { ul { grid-template-columns: repeat(2, 1fr); row-gap: 1rem; } }
</style>
