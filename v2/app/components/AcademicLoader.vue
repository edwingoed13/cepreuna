<script setup lang="ts">
// Loader temático académico: anillo girando con un birrete al centro.
withDefaults(defineProps<{
  title?: string
  subtitle?: string
  icon?: string
}>(), {
  title: 'Cargando…',
  subtitle: '',
  icon: 'i-lucide-graduation-cap'
})
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-4 py-14">
    <div class="ac-loader">
      <span class="ac-ring" />
      <span class="ac-ring ac-ring-2" />
      <span class="ac-cap">
        <UIcon :name="icon" class="size-7 text-sky-600 dark:text-sky-400" />
      </span>
    </div>
    <div class="text-center">
      <p class="text-sm font-semibold text-default">{{ title }}<span class="ac-dots" /></p>
      <p v-if="subtitle" class="text-xs text-muted mt-1">{{ subtitle }}</p>
    </div>
  </div>
</template>

<style scoped>
.ac-loader {
  position: relative;
  display: grid;
  place-items: center;
  width: 4.5rem;
  height: 4.5rem;
}

.ac-ring {
  position: absolute;
  inset: 0;
  border-radius: 9999px;
  background: conic-gradient(from 0deg, transparent 0% 18%, rgb(2 132 199 / 0.9) 88%, transparent 100%);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
  animation: ac-spin 0.95s linear infinite;
}

/* Segundo anillo, más lento y en sentido inverso, para dar profundidad. */
.ac-ring-2 {
  inset: 0.5rem;
  background: conic-gradient(from 180deg, transparent 0% 40%, rgb(56 189 248 / 0.55) 92%, transparent 100%);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
  animation: ac-spin 1.5s linear infinite reverse;
}

.ac-cap {
  display: grid;
  place-items: center;
  animation: ac-bob 1.8s ease-in-out infinite;
}

@keyframes ac-spin {
  to { transform: rotate(1turn); }
}

@keyframes ac-bob {
  0%, 100% { transform: translateY(0) rotate(-3deg); }
  50% { transform: translateY(-3px) rotate(3deg); }
}

/* Puntos suspensivos animados tras el título. */
.ac-dots::after {
  content: '';
  animation: ac-dots 1.4s steps(1, end) infinite;
}
@keyframes ac-dots {
  0% { content: ''; }
  25% { content: '.'; }
  50% { content: '..'; }
  75%, 100% { content: '...'; }
}

@media (prefers-reduced-motion: reduce) {
  .ac-ring, .ac-cap, .ac-dots::after { animation: none; }
}
</style>
