<script setup lang="ts">
import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'
import { esAdmin } from '~/utils/roles'

definePageMeta({ layout: false })

const { save, isValid, user } = useAuth()
const config = useRuntimeConfig()
const toast = useToast()
const apiBase = config.public.apiBase || ''

// Si ya hay sesión válida, no mostrar el login.
onMounted(() => {
  if (isValid()) navigateTo(esAdmin(user.value?.role) ? '/' : '/alumnos')
  isDarkMode.value = colorMode.value === 'dark'
})

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')
const loginScreen = ref<HTMLElement | null>(null)
// Estado SOLO de cliente para gatear el cursor-glow (efecto runtime).
const isDarkMode = ref(false)

const rememberedEmail = useCookie<string | null>('cepreuna_remembered_email', {
  maxAge: 60 * 60 * 24 * 30,
  sameSite: 'lax'
})
const hasRememberedEmail = computed(() => Boolean(rememberedEmail.value))

function toggleColorMode() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}

let glowFrame: number | null = null
let lastGlowEvent: PointerEvent | null = null

function clearCursorGlow() {
  const root = loginScreen.value
  if (!root) return
  root.style.setProperty('--cursor-opacity', '0')
  root.querySelectorAll<HTMLElement>('.cursor-glow-target').forEach((target) => {
    target.style.setProperty('--glow-opacity', '0')
  })
}

function updateCursorGlow(event: PointerEvent) {
  const root = loginScreen.value
  if (!root || !document.documentElement.classList.contains('dark')) {
    clearCursorGlow()
    return
  }
  lastGlowEvent = event
  if (glowFrame !== null) return
  glowFrame = requestAnimationFrame(() => {
    glowFrame = null
    if (!lastGlowEvent || !loginScreen.value) return
    const activeEvent = lastGlowEvent
    const rootRect = loginScreen.value.getBoundingClientRect()
    loginScreen.value.style.setProperty('--cursor-x', `${activeEvent.clientX - rootRect.left}px`)
    loginScreen.value.style.setProperty('--cursor-y', `${activeEvent.clientY - rootRect.top}px`)
    loginScreen.value.style.setProperty('--cursor-opacity', '1')
    loginScreen.value.querySelectorAll<HTMLElement>('.cursor-glow-target').forEach((target) => {
      const rect = target.getBoundingClientRect()
      const distanceX = Math.max(rect.left - activeEvent.clientX, 0, activeEvent.clientX - rect.right)
      const distanceY = Math.max(rect.top - activeEvent.clientY, 0, activeEvent.clientY - rect.bottom)
      const distance = Math.hypot(distanceX, distanceY)
      const opacity = Math.max(0, 1 - distance / 320)
      const glowX = Math.min(Math.max(activeEvent.clientX - rect.left, 0), rect.width)
      const glowY = Math.min(Math.max(activeEvent.clientY - rect.top, 0), rect.height)
      target.style.setProperty('--glow-x', `${glowX}px`)
      target.style.setProperty('--glow-y', `${glowY}px`)
      target.style.setProperty('--glow-opacity', opacity.toFixed(3))
    })
  })
}

watch(isDarkMode, (enabled) => { if (!enabled) clearCursorGlow() })
watch(() => colorMode.value, (value) => { isDarkMode.value = value === 'dark' })
onBeforeUnmount(() => { if (glowFrame !== null) cancelAnimationFrame(glowFrame) })

const LoginSchema = z.object({
  email: z.string().email('Correo inválido'),
  password: z.string().min(1, 'Ingresa tu contraseña'),
  remember: z.boolean().optional()
})

const fields = computed(() => [
  {
    name: 'email',
    type: 'email' as const,
    label: 'Correo electrónico',
    placeholder: 'usuario@cepreuna.edu.pe',
    defaultValue: rememberedEmail.value || '',
    required: true,
    size: 'lg' as const,
    ui: {
      base: '!bg-white !text-slate-950 placeholder:!text-slate-400 !ring-slate-300 focus:!ring-sky-500 dark:!bg-slate-950/80 dark:!text-white dark:placeholder:!text-slate-500 dark:!ring-slate-700'
    }
  },
  {
    name: 'password',
    label: 'Contraseña',
    type: 'password' as const,
    placeholder: 'Ingrese su contraseña',
    required: true,
    size: 'lg' as const,
    ui: {
      base: '!bg-white !text-slate-950 placeholder:!text-slate-400 !ring-slate-300 focus:!ring-sky-500 dark:!bg-slate-950/80 dark:!text-white dark:placeholder:!text-slate-500 dark:!ring-slate-700'
    }
  },
  {
    name: 'remember',
    label: 'Recordarme',
    type: 'checkbox' as const,
    defaultValue: hasRememberedEmail.value
  }
])

const loading = ref(false)
const submitBtn = computed(() => ({
  label: 'Ingresar',
  color: 'primary' as const,
  size: 'lg' as const,
  loading: loading.value,
  class: 'login-submit-text mt-2 font-bold'
}))

type LoginSubmitPayload = FormSubmitEvent<{ email: string, password: string, remember?: boolean }>

async function onSubmit(payload?: LoginSubmitPayload) {
  if (!payload) return
  loading.value = true
  try {
    // $fetch directo (no useApi) para que el 401 de credenciales muestre el
    // mensaje del backend en vez de disparar el auto-logout.
    const res = await $fetch<{ success: boolean, token: string, user: any }>(apiBase + '/api/stats/login', {
      method: 'POST',
      body: { email: payload.data.email, password: payload.data.password }
    })
    rememberedEmail.value = payload.data.remember ? payload.data.email : null
    save({ user: res.user, token: res.token })
    await navigateTo(esAdmin(res.user?.role) ? '/' : '/alumnos')
  } catch (err: any) {
    const msg = err?.data?.error || err?.response?._data?.error || 'No se pudo iniciar sesión. ¿Está corriendo el backend en :3000?'
    toast.add({ title: 'Error', description: msg, color: 'error' })
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div
    ref="loginScreen"
    class="login-screen relative min-h-screen overflow-hidden bg-slate-50 text-slate-950 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-50"
    @pointermove="updateCursorGlow"
    @pointerleave="clearCursorGlow"
  >
    <div class="pointer-events-none absolute inset-0 login-ambient" />
    <div class="pointer-events-none absolute inset-0 login-spotlight" />
    <StarField />
    <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sky-400/50 to-transparent dark:via-sky-300/40" />
    <div class="pointer-events-none absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary-500/30 to-transparent dark:via-sky-300/30" />

    <div class="relative z-10 mx-auto grid min-h-screen w-full max-w-6xl items-center gap-6 px-5 py-10 sm:py-12 lg:grid-cols-[1fr_480px] lg:gap-8">
      <section class="hidden lg:block">
        <div class="mb-8 flex items-center gap-4">
          <span class="cursor-glow-target grid size-14 place-items-center overflow-hidden rounded-lg bg-white p-1 shadow-lg shadow-sky-900/10 ring-1 ring-slate-200 dark:ring-white/15">
            <BrandLogo class="size-full object-contain" />
          </span>
          <div>
            <h1 class="text-3xl font-black">CEPREUNA</h1>
            <p class="text-sm font-medium text-slate-600 dark:text-slate-300">Panel de Estadísticas</p>
          </div>
        </div>

        <div class="max-w-xl">
          <p class="text-sm font-bold uppercase tracking-wide text-sky-700 dark:text-sky-300">Intranet CEPREUNA</p>
          <h2 class="mt-3 max-w-lg text-4xl font-black leading-tight lg:text-5xl">Bienvenido al panel de estadísticas</h2>
          <p class="mt-5 text-lg leading-8 text-slate-600 dark:text-slate-300">
            Acceda con su cuenta institucional para consultar inscripciones, pagos, asistencia y calidad docente.
          </p>
        </div>

        <div class="cursor-glow-target relative mt-8 max-w-md overflow-hidden rounded-lg border border-primary-500/25 bg-primary-500/[0.06] p-4 text-sm text-slate-700 shadow-sm shadow-primary-900/5 backdrop-blur dark:border-primary-400/25 dark:bg-primary-400/[0.08] dark:text-slate-300">
          <div class="flex items-start gap-4">
            <UIcon name="i-lucide-alert-triangle" class="mt-1 size-5 shrink-0 text-primary-600 dark:text-primary-300" />
            <div class="space-y-1">
              <p class="font-semibold text-primary-700 dark:text-primary-300">¿Problemas para ingresar?</p>
              <p class="leading-6">Comuníquese con el área encargada de soporte institucional.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="mx-auto w-full max-w-md lg:-translate-y-2">
        <div class="mb-4 hidden justify-end lg:flex">
          <button
            type="button"
            class="cursor-glow-target login-theme-switch login-theme-switch-desktop inline-flex items-center overflow-hidden"
            :class="isDark ? 'is-dark' : 'is-light'"
            aria-label="Cambiar tema claro u oscuro"
            @click="toggleColorMode"
          >
            <span class="login-theme-track">
              <UIcon name="i-lucide-sun" class="login-theme-track-icon login-theme-track-sun" />
              <UIcon name="i-lucide-moon" class="login-theme-track-icon login-theme-track-moon" />
              <span class="login-theme-thumb">
                <UIcon name="i-lucide-sun" class="login-theme-thumb-icon login-theme-thumb-sun size-3.5" />
                <UIcon name="i-lucide-moon" class="login-theme-thumb-icon login-theme-thumb-moon size-3.5" />
              </span>
            </span>
          </button>
        </div>

        <div class="mb-8 flex items-center justify-between gap-4 lg:hidden">
          <div class="flex min-w-0 items-center gap-3">
            <span class="cursor-glow-target grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-white p-1 shadow-lg shadow-sky-900/10 sm:size-12">
              <BrandLogo class="size-full object-contain" />
            </span>
            <div class="min-w-0">
              <div class="truncate text-lg font-black sm:text-xl">CEPREUNA</div>
              <div class="truncate text-xs text-slate-600 dark:text-slate-300">Panel de Estadísticas</div>
            </div>
          </div>

          <button
            type="button"
            class="cursor-glow-target login-theme-switch inline-flex shrink-0 items-center overflow-hidden"
            :class="isDark ? 'is-dark' : 'is-light'"
            aria-label="Cambiar tema claro u oscuro"
            @click="toggleColorMode"
          >
            <span class="login-theme-track">
              <UIcon name="i-lucide-sun" class="login-theme-track-icon login-theme-track-sun" />
              <UIcon name="i-lucide-moon" class="login-theme-track-icon login-theme-track-moon" />
              <span class="login-theme-thumb">
                <UIcon name="i-lucide-sun" class="login-theme-thumb-icon login-theme-thumb-sun size-3.5" />
                <UIcon name="i-lucide-moon" class="login-theme-thumb-icon login-theme-thumb-moon size-3.5" />
              </span>
            </span>
          </button>
        </div>

        <div class="login-card-glow isolate rounded-xl">
          <UPageCard
            class="cursor-glow-target login-card relative z-10 border border-slate-200/90 bg-white/95 shadow-2xl shadow-sky-900/10 backdrop-blur-xl dark:border-slate-700 dark:bg-slate-900/90 dark:shadow-black/40"
            :ui="{ body: 'p-5 sm:p-8' }"
          >
            <UAuthForm
              :schema="LoginSchema"
              class="login-form"
              title="Iniciar sesión"
              description="Ingrese sus credenciales institucionales."
              icon="i-lucide-user-round"
              :fields="fields"
              :submit="submitBtn"
              :ui="{
                leadingIcon: 'text-sky-600 drop-shadow-[0_0_16px_rgba(14,165,233,0.20)] dark:text-sky-300',
                title: 'text-slate-950 dark:text-white',
                description: 'text-sm text-slate-600 dark:text-slate-400'
              }"
              @submit="onSubmit"
            >
              <template #footer>
                <p class="text-center text-xs leading-5 text-slate-500 dark:text-slate-400">
                  Use únicamente credenciales autorizadas. El acceso queda registrado por seguridad.
                </p>
              </template>
            </UAuthForm>
          </UPageCard>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.login-screen {
  background-color: rgb(248 250 252);
  color: rgb(15 23 42);
}

html.dark .login-screen {
  background-color: rgb(2 6 23);
  color: rgb(248 250 252);
}

.login-screen,
.login-ambient,
.login-card,
.login-card-glow::before,
.login-theme-switch,
.login-theme-track,
.login-theme-thumb {
  transition:
    background-color 700ms ease,
    background 700ms ease,
    border-color 700ms ease,
    color 700ms ease,
    box-shadow 700ms ease,
    opacity 700ms ease,
    transform 700ms ease;
}

.login-ambient {
  background: rgb(248 250 252);
}

.login-spotlight {
  opacity: 0;
  transition: opacity 260ms ease;
}

html.dark .login-screen .login-spotlight {
  background:
    radial-gradient(
      circle 420px at var(--cursor-x, 50%) var(--cursor-y, 50%),
      rgb(56 189 248 / 0.16),
      rgb(14 165 233 / 0.08) 34%,
      transparent 70%
    );
  opacity: var(--cursor-opacity, 0);
}

html.dark .login-screen .login-ambient {
  background:
    linear-gradient(
      180deg,
      rgb(12 29 53 / 0.72),
      rgb(7 14 31 / 0.88) 34%,
      rgb(2 6 23 / 0.98) 76%,
      rgb(2 6 23) 100%
    ),
    linear-gradient(110deg, rgb(14 165 233 / 0.1), transparent 38%),
    linear-gradient(245deg, rgb(59 130 246 / 0.1), transparent 42%);
}

/* Cuadrícula de fondo. En modo CLARO se muestra con líneas medio oscuras
 * (slate) sobre el fondo claro, sin estrellas. En oscuro cambia a líneas
 * blancas tenues (el StarField solo aparece en dark). */
.login-ambient::before {
  position: absolute;
  inset: 0;
  content: "";
  display: block;
  background-image:
    linear-gradient(rgb(51 65 85 / 0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgb(51 65 85 / 0.06) 1px, transparent 1px);
  background-size: 42px 42px;
  mask-image: linear-gradient(to bottom, transparent, black 14%, black 72%, transparent);
}

html.dark .login-screen .login-ambient::before {
  background-image:
    linear-gradient(rgb(255 255 255 / 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgb(255 255 255 / 0.04) 1px, transparent 1px);
}

.login-theme-switch {
  border-radius: 9999px;
  background: transparent;
  color: rgb(51 65 85);
  padding: 0;
  box-shadow: 0 18px 36px rgb(14 165 233 / 0.08);
  backdrop-filter: blur(12px);
}

.login-theme-switch:hover {
  transform: translateY(-1px);
}

.cursor-glow-target {
  --glow-opacity: 0;
  --glow-x: 50%;
  --glow-y: 50%;
  position: relative;
}

html.dark .login-screen .cursor-glow-target::after {
  position: absolute;
  inset: 0;
  z-index: 20;
  content: "";
  pointer-events: none;
  border-radius: inherit;
  background: radial-gradient(
    circle 170px at var(--glow-x) var(--glow-y),
    rgb(125 211 252 / 0.98),
    rgb(56 189 248 / 0.62) 26%,
    rgb(14 165 233 / 0.18) 46%,
    transparent 72%
  );
  opacity: var(--glow-opacity);
  padding: 1px;
  mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  mask-composite: exclude;
  transition: opacity 160ms ease;
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
}

html.dark .login-screen .login-card.cursor-glow-target::after {
  background: radial-gradient(
    circle 230px at var(--glow-x) var(--glow-y),
    rgb(125 211 252),
    rgb(56 189 248 / 0.72) 28%,
    rgb(14 165 233 / 0.22) 50%,
    transparent 76%
  );
  padding: 1.5px;
}

.login-theme-track {
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
}

.login-theme-switch-desktop .login-theme-track {
  width: 4.25rem;
  height: 2.1rem;
}

.login-theme-track-icon {
  position: absolute;
  top: 50%;
  width: 0.9rem;
  height: 0.9rem;
  color: rgb(186 230 253 / 0.72);
  transform: translateY(-50%);
  transition:
    color 700ms ease,
    opacity 700ms ease;
}

.login-theme-switch-desktop .login-theme-track-icon {
  width: 1rem;
  height: 1rem;
}

.login-theme-track-sun {
  left: 0.47rem;
}

.login-theme-track-moon {
  right: 0.47rem;
}

.login-theme-thumb {
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
    transform 700ms cubic-bezier(0.34, 1.56, 0.64, 1),
    background-color 700ms ease,
    color 700ms ease,
    box-shadow 700ms ease;
}

.login-theme-switch-desktop .login-theme-thumb {
  width: 1.58rem;
  height: 1.58rem;
}

.login-theme-thumb-icon {
  grid-area: 1 / 1;
  transition:
    opacity 420ms ease,
    transform 700ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.login-theme-thumb-moon {
  opacity: 0;
  transform: rotate(-90deg) scale(0.35);
}

.login-theme-switch.is-dark .login-theme-thumb-sun {
  opacity: 0;
  transform: rotate(90deg) scale(0.35);
}

.login-theme-switch.is-dark .login-theme-thumb-moon {
  opacity: 1;
  transform: rotate(0deg) scale(1);
}

.login-theme-switch.is-dark {
  background: transparent;
  color: rgb(226 232 240);
  box-shadow: 0 18px 36px rgb(0 0 0 / 0.18);
}

.login-theme-switch.is-dark:hover {
  background: transparent;
}

.login-theme-switch.is-dark .login-theme-track {
  background: rgb(14 165 233 / 0.22);
  box-shadow: inset 0 0 0 1px rgb(56 189 248 / 0.34);
}

.login-theme-switch.is-dark .login-theme-thumb {
  background: rgb(56 189 248);
  color: rgb(2 6 23);
  transform: translateX(1.68rem);
}

.login-theme-switch-desktop.is-dark .login-theme-thumb {
  transform: translateX(1.88rem);
}

.login-theme-track-sun {
  opacity: 0;
}

.login-theme-switch.is-dark .login-theme-track-sun {
  opacity: 1;
}

.login-theme-switch.is-dark .login-theme-track-moon {
  opacity: 0;
}

.login-theme-switch.is-dark .login-theme-track-icon {
  color: rgb(186 230 253);
}

html.dark .login-screen :deep(.inscripciones-radial-glow) {
  top: 0;
  height: 100%;
  background:
    linear-gradient(
      180deg,
      rgb(21 48 87 / 0.74) 0%,
      rgb(15 35 66 / 0.56) 16%,
      rgb(7 14 31 / 0.28) 44%,
      transparent 82%
    ),
    radial-gradient(
      ellipse 88% 38% at 50% 0%,
      rgb(59 130 246 / 0.26) 0%,
      rgb(37 99 235 / 0.14) 42%,
      transparent 76%
    );
}

.login-card {
  overflow: hidden;
}

.login-card::before {
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 3px;
  content: "";
  background: linear-gradient(
    90deg,
    transparent,
    rgb(14 165 233 / 0.82),
    rgb(59 130 246 / 0.42),
    transparent
  );
}

.login-card-glow {
  position: relative;
}

.login-card-glow::before {
  position: absolute;
  inset: -2px;
  z-index: -1;
  content: "";
  pointer-events: none;
  border-radius: inherit;
  background: linear-gradient(
    135deg,
    rgb(14 165 233 / 0.34),
    rgb(59 130 246 / 0.1),
    rgb(255 255 255 / 0.55)
  );
  filter: blur(20px);
  opacity: 0.58;
}

html.dark .login-screen .login-card-glow::before {
  background: linear-gradient(
    135deg,
    rgb(125 211 252 / 0.42),
    rgb(14 165 233 / 0.16),
    rgb(255 255 255 / 0.06)
  );
  opacity: 0.48;
}

.login-form :deep([data-slot="label"]) {
  color: rgb(30 41 59);
}

html.dark .login-screen .login-form :deep([data-slot="label"]) {
  color: rgb(226 232 240);
}

.login-form :deep([data-slot="label"]::after) {
  color: rgb(220 38 38);
}

.login-form :deep(input[data-slot="base"]) {
  background-color: rgb(255 255 255 / 0.96) !important;
  color: rgb(15 23 42) !important;
  box-shadow: inset 0 0 0 1px rgb(203 213 225) !important;
}

html.dark .login-screen .login-form :deep(input[data-slot="base"]) {
  background-color: rgb(2 6 23 / 0.78) !important;
  color: rgb(248 250 252) !important;
  box-shadow: inset 0 0 0 1px rgb(51 65 85) !important;
}

.login-form :deep(input[data-slot="base"]::placeholder) {
  color: rgb(100 116 139) !important;
}

html.dark .login-screen .login-form :deep(input[data-slot="base"]::placeholder) {
  color: rgb(148 163 184) !important;
}

.login-form :deep(input[data-slot="base"]:focus) {
  box-shadow:
    inset 0 0 0 1px rgb(14 165 233),
    0 0 0 3px rgb(14 165 233 / 0.14) !important;
}

.login-form :deep([data-slot="checkbox"]) {
  color: rgb(51 65 85);
}

html.dark .login-screen .login-form :deep([data-slot="checkbox"]) {
  color: rgb(226 232 240);
}

.login-form :deep(.login-submit-text) {
  color: rgb(255 255 255) !important;
}

.login-form :deep(.login-submit-text *) {
  color: inherit !important;
}

html.dark .login-screen .login-form :deep(.login-submit-text),
html.dark .login-screen .login-form :deep(.login-submit-text *) {
  color: rgb(2 6 23) !important;
}
</style>
