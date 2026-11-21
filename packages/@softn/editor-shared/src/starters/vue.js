import { createApp, h, ref } from './vendor/vue.js';

const ReadingCounter = {
  setup() {
    const pages = ref(Number(localStorage.getItem('pages')) || 0);

    function save(next) {
      pages.value = next;
      localStorage.setItem('pages', String(next));
    }

    return () => [
      h('section', { class: 'counter', 'aria-labelledby': 'metric' }, [
        h('h2', { id: 'metric' }, 'Pages read'),
        h('output', { id: 'value', 'aria-live': 'polite' }, String(pages.value)),
      ]),
      h('div', { class: 'actions' }, [
        h('button', { id: 'increment', type: 'button', onClick: () => save(pages.value + 1) }, 'Log a page'),
        h('button', { id: 'reset', type: 'button', disabled: pages.value === 0, onClick: () => save(0) }, 'Reset'),
      ]),
    ];
  },
};

createApp(ReadingCounter).mount('#app');
