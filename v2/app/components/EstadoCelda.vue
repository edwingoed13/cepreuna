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
  completo: 'bg-green-100 text-green-800 ring-green-300 dark:bg-green-500/15 dark:text-green-300 dark:ring-green-500/30',
  parcial: 'bg-amber-100 text-amber-800 ring-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  sin: 'bg-red-100 text-red-800 ring-red-300 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
  nada: 'bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-700/40 dark:text-slate-400 dark:ring-slate-600'
}
const glifo: Record<string, string> = {
  completo: 'i-lucide-check', parcial: 'i-lucide-circle-dashed', sin: 'i-lucide-x', nada: 'i-lucide-minus'
}
</script>

<template>
  <UTooltip :text="tooltip || ''" :disabled="!tooltip">
    <div
      class="relative inline-flex items-center justify-center gap-1 w-full min-w-[64px] px-2 py-1 rounded-md text-xs font-semibold tabular-nums ring-1 ring-inset"
      :class="clases[props.tipo]"
    >
      <UIcon :name="glifo[props.tipo]" class="size-3 shrink-0" />
      <span class="truncate">{{ texto }}</span>
      <span
        v-if="marca"
        class="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-indigo-500 ring-2 ring-white dark:ring-slate-900"
        title="Pagó con distinta modalidad"
      />
    </div>
  </UTooltip>
</template>
