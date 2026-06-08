<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  hint?: string
  icon?: string
  color?: 'primary' | 'success' | 'warning' | 'error' | 'neutral'
}>()

// Color del número
const numClasses: Record<string, string> = {
  primary: 'text-cepreuna-700 dark:text-cepreuna-300',
  success: 'text-green-600 dark:text-green-400',
  warning: 'text-amber-500 dark:text-amber-400',
  error: 'text-red-500 dark:text-red-400',
  neutral: 'text-slate-800 dark:text-white'
}
// Chip del ícono (tinte del color)
const chipClasses: Record<string, string> = {
  primary: 'bg-cepreuna-500/10 text-cepreuna-600 dark:text-cepreuna-300',
  success: 'bg-green-500/10 text-green-600 dark:text-green-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  error: 'bg-red-500/10 text-red-600 dark:text-red-400',
  neutral: 'bg-slate-500/10 text-slate-600 dark:text-slate-300'
}
</script>

<template>
  <UCard class="kpi-card card-hover relative overflow-hidden" :ui="{ body: 'p-4 sm:p-4' }">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <p class="text-[10px] font-bold uppercase tracking-widest text-muted mb-1.5">{{ label }}</p>
        <p class="text-2xl font-black leading-none" :class="numClasses[color || 'neutral']">{{ value }}</p>
        <p v-if="hint" class="text-[10px] text-muted mt-1.5">{{ hint }}</p>
      </div>
      <span
        v-if="icon"
        class="grid size-9 shrink-0 place-items-center rounded-lg"
        :class="chipClasses[color || 'neutral']"
      >
        <UIcon :name="icon" class="size-5" />
      </span>
    </div>
  </UCard>
</template>

<style scoped>
/* Hairline superior tipo "acento", coherente con la tarjeta del login. */
.kpi-card::before {
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 2px;
  content: "";
  background: linear-gradient(90deg, transparent, rgb(14 165 233 / 0.55), rgb(59 130 246 / 0.28), transparent);
  opacity: 0;
  transition: opacity 220ms ease;
}
.kpi-card:hover::before {
  opacity: 1;
}
</style>
