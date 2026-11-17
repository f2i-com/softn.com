<script setup>
const props = defineProps({ armed: Boolean });
function text() {
  if (props.armed) throw new Error('boom');
  return 'calm';
}
</script>

<template>
  <span id="calm">{{ text() }}</span>
</template>
