<!-- Loaded when asked for, with a stylesheet of its own: Vite fetches both, and waits for the stylesheet before it runs this. -->
<template>
  <p id="lazy" class="lazy">Lazy loaded</p>
</template>

<style>
.lazy { letter-spacing: 3px; }
</style>
