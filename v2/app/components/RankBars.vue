<script setup lang="ts">
interface Item { label: string; value: number; sub?: string; to?: string }
const props = withDefaults(defineProps<{
  items: Item[]
  min?: number
  max?: number
  media?: number | null
}>(), { min: 3.5, max: 5, media: null })

// Color por puntaje (escala 1–5), igual que el v1.
function color(v: number) {
  if (v >= 4.5) return '#10b981'
  if (v >= 4.0) return '#84cc16'
  if (v >= 3.5) return '#f59e0b'
  if (v >= 3.0) return '#f97316'
  return '#ef4444'
}
function pct(v: number) {
  const r = (v - props.min) / (props.max - props.min)
  return Math.max(2, Math.min(100, r * 100))
}
const mediaPct = computed(() => props.media == null ? null : pct(props.media))
</script>

<template>
  <div class="relative space-y-1.5">
    <!-- Línea de media institucional -->
    <div
      v-if="mediaPct != null"
      class="pointer-events-none absolute top-0 bottom-0 z-10 border-l-2 border-dashed border-indigo-400/70"
      :style="{ left: `calc(40% + ${mediaPct * 0.6}%)` }"
    >
      <span class="absolute -top-0.5 left-1 text-[9px] font-bold text-indigo-500 whitespace-nowrap">Media {{ media?.toFixed(2) }}</span>
    </div>

    <component
      :is="it.to ? resolveComponent('NuxtLink') : 'div'"
      v-for="(it, i) in items"
      :key="i"
      :to="it.to"
      class="flex items-center gap-2 text-xs rounded px-1 -mx-1"
      :class="it.to ? 'hover:bg-elevated/60 transition-colors cursor-pointer' : ''"
    >
      <span class="w-[40%] truncate shrink-0" :title="it.label">{{ it.label }}</span>
      <div class="flex-1 h-4 rounded bg-elevated overflow-hidden">
        <div class="h-full rounded transition-all duration-500" :style="{ width: pct(it.value) + '%', backgroundColor: color(it.value) }" />
      </div>
      <span class="w-16 text-right font-mono font-bold shrink-0" :style="{ color: color(it.value) }">
        {{ it.value.toFixed(2) }}
        <span v-if="it.sub" class="text-muted font-normal text-[10px] block leading-none">{{ it.sub }}</span>
      </span>
    </component>
    <p v-if="!items.length" class="text-xs text-muted text-center py-3">Sin datos.</p>
  </div>
</template>
