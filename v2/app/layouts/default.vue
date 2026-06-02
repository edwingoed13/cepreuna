<script setup lang="ts">
import type { NavigationMenuItem } from '#ui/types'

const { user, role, isAdmin, logout } = useAuth()
const colorMode = useColorMode()
const route = useRoute()

// Items del sidebar, filtrados por rol.
const navItems = computed<NavigationMenuItem[][]>(() => {
  const todos: (NavigationMenuItem & { adminOnly?: boolean })[] = [
    { label: 'Resumen', icon: 'i-lucide-layout-dashboard', to: '/', adminOnly: true },
    { label: 'Reportes', icon: 'i-lucide-file-text', to: '/reportes', adminOnly: true },
    { label: 'Alumnos', icon: 'i-lucide-users', to: '/alumnos' },
    { label: 'Calificación', icon: 'i-lucide-clipboard-check', to: '/alumnos-calificacion' },
    { label: 'Reportes auxiliares', icon: 'i-lucide-user-cog', to: '/reportes-aux', adminOnly: true }
  ]
  const visibles = todos.filter(i => !i.adminOnly || isAdmin.value)
  return [visibles]
})

const themeIcon = computed(() => colorMode.value === 'dark' ? 'i-lucide-moon' : 'i-lucide-sun')
function toggleTheme() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}

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
          <div class="w-9 h-9 rounded-lg bg-cepreuna-700 text-white flex items-center justify-center shrink-0">
            <UIcon name="i-lucide-graduation-cap" class="size-5" />
          </div>
          <div v-if="!collapsed" class="min-w-0">
            <p class="font-bold text-cepreuna-700 dark:text-white leading-none">CEPREUNA</p>
            <p class="text-[10px] text-muted uppercase tracking-widest mt-1">Estadísticas</p>
          </div>
        </div>
      </template>

      <UNavigationMenu :items="navItems" orientation="vertical" :collapsed="false" />

      <template #footer="{ collapsed }">
        <div class="flex items-center gap-3 w-full">
          <UAvatar :text="iniciales" size="sm" />
          <div v-if="!collapsed" class="flex-1 min-w-0">
            <p class="text-sm font-semibold truncate">{{ user?.name || 'Usuario' }}</p>
            <p class="text-[10px] text-muted truncate">{{ role || '—' }}</p>
          </div>
          <UButton
            v-if="!collapsed"
            icon="i-lucide-log-out"
            color="neutral"
            variant="ghost"
            size="sm"
            aria-label="Cerrar sesión"
            @click="logout()"
          />
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
            <UButton :icon="themeIcon" color="neutral" variant="ghost" aria-label="Cambiar tema" @click="toggleTheme" />
            <UButton icon="i-lucide-log-out" color="neutral" variant="ghost" aria-label="Salir" @click="logout()" />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <slot />
      </template>
    </UDashboardPanel>
  </UDashboardGroup>
</template>
