<script setup lang="ts">
// Celda con fondo de color + glifo (accesible). Opcional: marca de "cambio de
// modalidad" (punto en la esquina) y tooltip.
const props = defineProps<{
  tipo: 'completo' | 'parcial' | 'sin' | 'nada'
  texto: string
  tooltip?: string
  marca?: boolean // cambio de modalidad
}>()

const clases: Record<string, string> = {
  completo: 'bg-green-500/90 text-green-950',
  parcial: 'bg-yellow-300 text-yellow-950',
  sin: 'bg-red-400 text-red-950',
  nada: 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-300'
}
const glifo: Record<string, string> = {
  completo: '✓', parcial: '◐', sin: '✗', nada: '—'
}
</script>

<template>
  <UTooltip :text="tooltip || ''" :disabled="!tooltip">
    <div
      class="relative w-full h-full px-2 py-1 rounded text-center text-xs font-semibold tabular-nums"
      :class="clases[props.tipo]"
    >
      <span class="mr-1">{{ glifo[props.tipo] }}</span>{{ texto }}
      <span
        v-if="marca"
        class="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-indigo-600 ring-1 ring-white"
        title="Pagó con distinta modalidad"
      />
    </div>
  </UTooltip>
</template>
