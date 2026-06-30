<script setup lang="ts">
import type { NavigationMenuItem } from '#ui/types'

const { user, role, isAdmin, logout } = useAuth()
const route = useRoute()

// Items del sidebar, filtrados por rol.
const navItems = computed<NavigationMenuItem[][]>(() => {
  const todos: (NavigationMenuItem & { adminOnly?: boolean })[] = [
    { label: 'Resumen', icon: 'i-lucide-layout-dashboard', to: '/', adminOnly: true },
    { label: 'Reportes', icon: 'i-lucide-file-text', to: '/reportes', adminOnly: true },
    { label: 'Habilitados', icon: 'i-lucide-user-check', to: '/habilitados' },
    { label: 'Alumnos', icon: 'i-lucide-users', to: '/alumnos' },
    { label: 'Calificación', icon: 'i-lucide-clipboard-check', to: '/alumnos-calificacion' },
    { label: 'Docentes', icon: 'i-lucide-award', to: '/docentes', adminOnly: true },
    { label: 'Reportes auxiliares', icon: 'i-lucide-user-cog', to: '/reportes-aux', adminOnly: true }
  ]
  const visibles = todos.filter(i => !i.adminOnly || isAdmin.value)
  return [visibles]
})

const titulo = computed(() => {
  const map: Record<string, string> = {
    '/': 'Resumen',
    '/reportes': 'Reportes por sede',
    '/alumnos': 'Alumnos · Pagos',
    '/alumnos-calificacion': 'Alumnos · Calificación',
    '/reportes-aux': 'Reportes auxiliares',
    '/reportes-aux/horas-docentes': 'Horas pago por docentes',
    '/reportes-aux/cobertura-grupos': 'Cobertura de asistencia'
  }
  return map[route.path] ?? 'Estadísticas'
})

const iniciales = computed(() => (user.value?.name || 'A').charAt(0).toUpperCase())
</script>

<template>
  <UDashboardGroup>
    <UDashboardSidebar collapsible :ui="{ footer: 'border-t border-default' }">
      <template #header="{ collapsed }">
        <div class="flex items-center gap-3">
          <span class="grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-white p-1 shadow-sm ring-1 ring-slate-200 dark:ring-white/15">
            <BrandLogo class="size-full object-contain" />
          </span>
          <div v-if="!collapsed" class="min-w-0">
            <p class="font-black text-cepreuna-700 dark:text-white leading-none">CEPREUNA</p>
            <p class="text-[10px] text-muted uppercase tracking-widest mt-1">Estadísticas</p>
          </div>
        </div>
      </template>

      <UNavigationMenu :items="navItems" orientation="vertical" :collapsed="false" />

      <template #footer="{ collapsed }">
        <div class="flex items-center gap-3 w-full">
          <UAvatar :text="iniciales" size="sm" :ui="{ root: 'bg-cepreuna-700 text-white' }" />
          <div v-if="!collapsed" class="flex-1 min-w-0">
            <p class="text-sm font-semibold truncate">{{ user?.name || 'Usuario' }}</p>
            <p class="text-[10px] text-muted truncate">{{ role || '—' }}</p>
          </div>
        </div>
      </template>
    </UDashboardSidebar>

    <UDashboardPanel>
      <template #header>
        <UDashboardNavbar :title="titulo">
          <template #leading>
            <UDashboardSidebarCollapse />
          </template>
          <template #right>
            <ThemeSwitch />
            <UButton icon="i-lucide-log-out" color="neutral" variant="ghost" aria-label="Salir" @click="logout()" />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <div class="dash-surface min-h-full">
          <slot />
        </div>
      </template>
    </UDashboardPanel>
  </UDashboardGroup>
</template>
