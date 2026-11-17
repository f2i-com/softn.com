<!--
  The app the container's framework tests build with Vite and run as its dist/ folder
  (test/frameworks.test.ts, e2e/tests/web-container-frameworks.spec.ts). Written as an app
  is, for a browser, with nothing in it for SoftN: the same page as its React twin
  (../../react/src/main.jsx), and what only Vue has (a transition, v-show, nextTick).
--><script setup>
import { computed, defineAsyncComponent, nextTick, onErrorCaptured, onMounted, onUnmounted, provide, reactive, ref, watch, watchEffect } from 'vue';
import Count from './Count.vue';
import Bomb from './Bomb.vue';

const Lazy = defineAsyncComponent(() => import('./Lazy.vue'));

const state = reactive({ count: 0 });
provide('counter', state);
const note = ref('');
const agree = ref(false);
const size = ref('m');
const kind = ref('a');
const notes = ref('');
const draft = ref('');
const items = ref([{ id: 1, text: 'first' }, { id: 2, text: 'second' }]);
const open = ref(false);
const showLazy = ref(false);
const armed = ref(false);
const caught = ref('');
const hovered = ref(false);
const at = ref(null);
const sprite = ref('loading');
const blobUrl = ref('');
const focused = ref(false);
const data = ref('loading');
const measured = ref('no');
const width = ref(window.innerWidth > 0 ? 'wide' : 'none');
const path = ref(location.pathname);
const shown = ref(true);
const ticked = ref('no');
const box = ref(null);
const scroller = ref(null);
const field = ref(null);
let nextId = 3;

const upper = computed(() => note.value.toUpperCase());
watchEffect(() => { document.title = 'Count ' + state.count; });
watch(note, async () => { await nextTick(); ticked.value = 'yes'; });
onErrorCaptured((error) => { caught.value = error.message; return false; });

const onPop = () => { path.value = location.pathname; };
onMounted(() => {
  if (box.value && typeof box.value.getBoundingClientRect === 'function') measured.value = 'yes';
  fetch('/data.json').then((r) => r.json()).then((json) => { data.value = json.greeting; }, (e) => { data.value = 'failed: ' + e.message; });
  window.addEventListener('popstate', onPop);
  // As a list of messages keeps itself at its end.
  scroller.value.scrollTop = scroller.value.scrollHeight;
  const image = new Image();
  image.onload = () => { sprite.value = image.naturalWidth + 'x' + image.naturalHeight; };
  image.onerror = () => { sprite.value = 'failed'; };
  image.src = '/dot.png';
  fetch('/dot.png').then((r) => r.blob()).then((blob) => { blobUrl.value = URL.createObjectURL(blob); });
});
onUnmounted(() => window.removeEventListener('popstate', onPop));

function add() {
  if (!draft.value) return;
  items.value.push({ id: nextId++, text: draft.value });
  draft.value = '';
}
function go() {
  history.pushState({}, '', '/about');
  path.value = location.pathname;
}
function show(to) {
  history.pushState({}, '', to);
  window.scrollTo(0, 0);
  path.value = location.pathname;
}
function dark() {
  document.documentElement.classList.toggle('dark');
}
function toLine() {
  document.getElementById('line-3').scrollIntoView();
}
</script>

<template>
  <div ref="box" :class="['app', { agreed: agree }]" :data-kind="kind" aria-label="demo">
    <Count />
    <img id="mark" src="./mark.svg" alt="" width="8" height="8">
    <img id="logo" src="/vite.svg" alt="" width="16" height="16">
    <button id="inc" type="button" @click="state.count++">Add</button>
    <button id="dark" type="button" @click="dark">Dark</button>
    <input id="note" v-model="note">
    <p id="echo">{{ upper }}</p>
    <input id="agree" v-model="agree" type="checkbox">
    <span id="agreed">{{ agree ? 'yes' : 'no' }}</span>
    <select id="size" v-model="size">
      <option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option>
    </select>
    <span id="chosen">{{ size }}</span>
    <input id="kind-a" v-model="kind" type="radio" name="kind" value="a">
    <input id="kind-b" v-model="kind" type="radio" name="kind" value="b">
    <span id="kind">{{ kind }}</span>
    <textarea id="notes" v-model="notes" />
    <span id="length">{{ notes.length }}</span>
    <form id="form" @submit.prevent="add">
      <input id="new" v-model="draft">
      <button id="push" type="submit">Push</button>
    </form>
    <button id="reverse" type="button" @click="items.reverse()">Reverse</button>
    <ul id="list">
      <li v-for="item in items" :key="item.id" class="row">
        <span class="text">{{ item.text }}</span>
        <button class="remove" type="button" @click="items.splice(items.indexOf(item), 1)">x</button>
      </li>
    </ul>
    <button id="open" type="button" @click="open = true">Open</button>
    <Teleport to="body">
      <div v-if="open" id="modal" role="dialog"><button id="close" type="button" @click="open = false">Close</button></div>
    </Teleport>
    <button id="lazy-load" type="button" @click="showLazy = true">Load</button>
    <Lazy v-if="showLazy" />
    <button id="boom" type="button" @click="armed = true">Boom</button>
    <p v-if="caught" id="caught">Caught: {{ caught }}</p>
    <Bomb v-else :armed="armed" />
    <div id="html" v-html="'<b>bold</b> text'" />
    <svg id="icon" width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red" /></svg>
    <div id="hover" @mouseenter="hovered = true" @mouseleave="hovered = false">hover</div>
    <span id="hovered">{{ hovered ? 'yes' : 'no' }}</span>
    <!-- A thing put where the pointer was, as a menu or a tooltip is: fixed, at the click's own coordinates. -->
    <div id="pad" style="height: 60px; background: rgb(238, 238, 238)" @click="at = { x: $event.clientX, y: $event.clientY }">pad</div>
    <div v-if="at" id="marker" :style="{ position: 'fixed', left: at.x + 'px', top: at.y + 'px', width: '6px', height: '6px', background: 'rgb(255, 0, 0)' }" />
    <span id="at">{{ at ? Math.round(at.x) + ',' + Math.round(at.y) : 'none' }}</span>
    <input id="focus-me" ref="field" @focus="focused = true" @blur="focused = false">
    <button id="focus-by-ref" type="button" @click="field.focus()">Focus it</button>
    <span id="focused">{{ focused ? 'yes' : 'no' }}</span>
    <span id="data">{{ data }}</span>
    <span id="measured">{{ measured }}</span>
    <span id="width">{{ width }}</span>
    <button id="go" type="button" @click="go">Go</button>
    <!-- As a router's links are: an address to show, and a click the script keeps for itself. -->
    <a id="home-link" href="/" @click.prevent="show('/')">Home</a>
    <a id="team-link" href="/team" @click.prevent="show('/team')">Team</a>
    <span id="path">{{ path }}</span>
    <button id="to-end" type="button" @click="scroller.scrollTop = scroller.scrollHeight">To the end</button>
    <!-- A picture loaded before it is anywhere on the page, and one drawn from bytes the script holds. -->
    <span id="sprite">{{ sprite }}</span>
    <img v-if="blobUrl" id="from-blob" :src="blobUrl" alt="" width="12" height="12">
    <button id="to-line" type="button" @click="toLine">To line 3</button>
    <span id="ticked">{{ ticked }}</span>
    <button id="toggle" type="button" @click="shown = !shown">Toggle</button>
    <Transition name="fade"><p v-if="shown" id="fade">fading</p></Transition>
    <p v-show="agree" id="shown-when-agreed">agreed</p>
    <div id="scroller" ref="scroller" style="height: 120px; overflow: auto">
      <p id="line-0" class="static">Static line 0</p>
      <p id="line-1" class="static">Static line 1</p>
      <p id="line-2" class="static">Static line 2</p>
      <p id="line-3" class="static">Static line 3</p>
      <p id="line-4" class="static">Static line 4</p>
      <p id="line-5" class="static">Static line 5</p>
      <p id="line-6" class="static">Static line 6</p>
      <p id="line-7" class="static">Static line 7</p>
      <p id="line-8" class="static">Static line 8</p>
      <p id="line-9" class="static">Static line 9</p>
      <p id="line-10" class="static">Static line 10</p>
      <p id="line-11" class="static">Static line 11</p>
      <p id="line-12" class="static">Static line 12</p>
      <p id="line-13" class="static">Static line 13</p>
      <p id="line-14" class="static">Static line 14</p>
      <p id="line-15" class="static">Static line 15</p>
      <p id="line-16" class="static">Static line 16</p>
      <p id="line-17" class="static">Static line 17</p>
      <p id="line-18" class="static">Static line 18</p>
      <p id="line-19" class="static">Static line 19</p>
      <p id="line-20" class="static">Static line 20</p>
      <p id="line-21" class="static">Static line 21</p>
      <p id="line-22" class="static">Static line 22</p>
      <p id="line-23" class="static">Static line 23</p>
      <p id="line-24" class="static">Static line 24</p>
    </div>
  </div>
</template>

<style>
.fade-enter-active, .fade-leave-active { transition: opacity 0.05s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
