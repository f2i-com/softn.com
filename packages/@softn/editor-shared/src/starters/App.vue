<script setup>
import { ref } from 'vue';

const pages = ref(Number(localStorage.getItem('pages')) || 0);

function save(next) {
  pages.value = next;
  localStorage.setItem('pages', String(next));
}
</script>

<template>
  <section class="counter" aria-labelledby="metric">
    <h2 id="metric">Pages read</h2>
    <output id="value" class="reading-count" aria-live="polite">{{ pages }}</output>
  </section>
  <div class="actions">
    <button id="increment" type="button" @click="save(pages + 1)">Log a page</button>
    <button id="reset" type="button" :disabled="pages === 0" @click="save(0)">Reset</button>
  </div>
</template>

<style scoped>
.reading-count { letter-spacing: -.04em; }
</style>
