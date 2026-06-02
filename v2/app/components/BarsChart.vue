<script setup lang="ts">
import { fmtNumero } from '~/utils/format'

const props = defineProps<{
  items: { label: string; value: number; sub?: string }[]
  colors?: string[]
}>()

const palette = ['#003366', '#0381d9', '#0da954', '#f97316', '#7c3aed', '#db2777']
const maxVal = computed(() => Math.max(1, ...props.items.map(i => i.value)))
function color(i: number) {
  return (props.colors || palette)[i % (props.colors || palette).length]
}
</script>

<template>
  <div class="space-y-2.5">
    <div v-for="(it, i) in items" :key="i" class="space-y-1">
      <div class="flex items-center justify-between text-xs">
        <span class="font-medium truncate">{{ it.label }}</span>
        <span class="font-mono font-bold tabular-nums">{{ fmtNumero(it.value) }}<span v-if="it.sub" class="text-muted font-normal ml-1">{{ it.sub }}</span></span>
      </div>
      <div class="h-2 rounded-full bg-elevated overflow-hidden">
        <div
          class="h-full rounded-full transition-all duration-500"
          :style="{ width: (100 * it.value / maxVal) + '%', backgroundColor: color(i) }"
        />
      </div>
    </div>
    <p v-if="!items.length" class="text-sm text-muted py-4 text-center">Sin datos.</p>
  </div>
</template>
