<script setup lang="ts">
// Switch de tema claro/oscuro animado, portado del login para coherencia visual.
const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')
function toggle() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}
</script>

<template>
  <button
    type="button"
    class="ts-switch inline-flex shrink-0 items-center overflow-hidden"
    :class="isDark ? 'is-dark' : 'is-light'"
    aria-label="Cambiar tema claro u oscuro"
    @click="toggle"
  >
    <span class="ts-track">
      <UIcon name="i-lucide-sun" class="ts-track-icon ts-track-sun" />
      <UIcon name="i-lucide-moon" class="ts-track-icon ts-track-moon" />
      <span class="ts-thumb">
        <UIcon name="i-lucide-sun" class="ts-thumb-icon ts-thumb-sun size-3.5" />
        <UIcon name="i-lucide-moon" class="ts-thumb-icon ts-thumb-moon size-3.5" />
      </span>
    </span>
  </button>
</template>

<style scoped>
.ts-switch {
  border-radius: 9999px;
  background: transparent;
  padding: 0;
  transition: transform 300ms ease;
}
.ts-switch:hover { transform: translateY(-1px); }

.ts-track {
  position: relative;
  display: inline-flex;
  width: 3.75rem;
  height: 1.85rem;
  align-items: center;
  border-radius: 9999px;
  background: linear-gradient(180deg, rgb(2 132 199), rgb(2 116 178));
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.2),
    inset 0 0 0 1px rgb(2 132 199 / 0.4);
  transition: background 500ms ease, box-shadow 500ms ease;
}

.ts-track-icon {
  position: absolute;
  top: 50%;
  width: 0.9rem;
  height: 0.9rem;
  color: rgb(186 230 253 / 0.72);
  transform: translateY(-50%);
  transition: color 500ms ease, opacity 500ms ease;
}
.ts-track-sun { left: 0.47rem; opacity: 0; }
.ts-track-moon { right: 0.47rem; }

.ts-thumb {
  display: grid;
  width: 1.36rem;
  height: 1.36rem;
  margin-inline-start: 0.25rem;
  place-items: center;
  border-radius: 9999px;
  background: rgb(255 255 255);
  color: var(--ui-primary);
  box-shadow:
    0 6px 14px rgb(15 23 42 / 0.16),
    inset 0 0 0 1px rgb(255 255 255 / 0.8);
  transform: translateX(0);
  transition:
    transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1),
    background-color 500ms ease,
    color 500ms ease;
}
.ts-thumb-icon {
  grid-area: 1 / 1;
  transition: opacity 360ms ease, transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.ts-thumb-moon { opacity: 0; transform: rotate(-90deg) scale(0.35); }

.ts-switch.is-dark .ts-thumb-sun { opacity: 0; transform: rotate(90deg) scale(0.35); }
.ts-switch.is-dark .ts-thumb-moon { opacity: 1; transform: rotate(0deg) scale(1); }
.ts-switch.is-dark .ts-track {
  background: rgb(14 165 233 / 0.22);
  box-shadow: inset 0 0 0 1px rgb(56 189 248 / 0.34);
}
.ts-switch.is-dark .ts-thumb {
  background: rgb(56 189 248);
  color: rgb(2 6 23);
  transform: translateX(1.68rem);
}
.ts-switch.is-dark .ts-track-sun { opacity: 1; }
.ts-switch.is-dark .ts-track-moon { opacity: 0; }
.ts-switch.is-dark .ts-track-icon { color: rgb(186 230 253); }
</style>
