<script setup lang="ts">
const cards = [
  {
    title: 'Horas pago por docentes',
    description: 'Cálculo de horas a pagar desglosado por coordinador, auxiliar, sede, turno, área y grupo, con totales y exportación.',
    icon: 'i-lucide-banknote',
    to: '/reportes-aux/horas-docentes',
    tint: 'text-sky-600 dark:text-sky-400 bg-sky-500/10',
    meta: 'Filtros en cascada · Totales · Excel'
  },
  {
    title: 'Cobertura de asistencia',
    description: 'Matriz de asistencia por grupo y día con porcentaje de cumplimiento. Identifica grupos sin auxiliar o con faltas.',
    icon: 'i-lucide-grid-3x3',
    to: '/reportes-aux/cobertura-grupos',
    tint: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
    meta: 'Vista semanal / por fecha · Excel'
  },
  {
    title: 'Tardanzas y faltas docentes',
    description: 'Resumen por docente de tardanzas/faltas con descuento por modalidad, y detalle por fecha (sede, grupo, coordinador, auxiliar).',
    icon: 'i-lucide-alarm-clock',
    to: '/reportes-aux/tardanzas',
    tint: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
    meta: 'Detalle en modal · Excel'
  }
]
</script>

<template>
  <div class="p-4 lg:p-6">
    <div class="mb-6">
      <h2 class="text-xl font-bold tracking-tight">Reportes auxiliares</h2>
      <p class="text-sm text-muted mt-0.5">Pago de horas docentes y control de asistencia por grupo.</p>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-w-5xl">
      <NuxtLink
        v-for="c in cards"
        :key="c.to"
        :to="c.to"
        class="group rounded-xl border border-default bg-default p-5 transition-colors duration-150 hover:border-sky-500/40 hover:bg-elevated/40"
      >
        <div class="flex items-center gap-3">
          <span class="grid size-10 shrink-0 place-items-center rounded-lg" :class="c.tint">
            <UIcon :name="c.icon" class="size-5" />
          </span>
          <h3 class="flex-1 font-semibold leading-tight">{{ c.title }}</h3>
          <UIcon name="i-lucide-chevron-right" class="size-4 text-dimmed transition-transform group-hover:translate-x-0.5 group-hover:text-sky-600 dark:group-hover:text-sky-400" />
        </div>

        <p class="text-sm text-muted leading-relaxed mt-3">{{ c.description }}</p>

        <p class="text-[11px] text-dimmed mt-4 pt-3 border-t border-default">{{ c.meta }}</p>
      </NuxtLink>
    </div>
  </div>
</template>
