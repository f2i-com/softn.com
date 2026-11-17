<script setup>
import { inject } from 'vue';
const counter = inject('counter');
</script>

<template>
  <p id="count">Count: {{ counter.count }}</p>
</template>
