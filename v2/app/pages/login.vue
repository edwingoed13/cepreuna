<script setup lang="ts">
import { z } from 'zod'
import type { FormSubmitEvent } from '#ui/types'
import { esAdmin } from '~/utils/roles'

definePageMeta({ layout: 'auth' })

const { save } = useAuth()
const config = useRuntimeConfig()
const toast = useToast()
const apiBase = config.public.apiBase || ''

const schema = z.object({
  email: z.string().email('Correo inválido'),
  password: z.string().min(1, 'Ingresa tu contraseña')
})
type Schema = z.output<typeof schema>

const state = reactive<Schema>({ email: '', password: '' })
const loading = ref(false)

async function onSubmit(event: FormSubmitEvent<Schema>) {
  loading.value = true
  try {
    // $fetch directo (no useApi) para que el 401 de credenciales muestre el
    // mensaje del backend en vez de disparar el auto-logout.
    const res = await $fetch<{ success: boolean; token: string; user: any }>(apiBase + '/api/stats/login', {
      method: 'POST',
      body: { email: event.data.email, password: event.data.password }
    })
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
  <UCard class="w-full max-w-sm">
    <div class="flex flex-col items-center text-center mb-6">
      <div class="w-14 h-14 rounded-xl bg-cepreuna-700 text-white flex items-center justify-center mb-3">
        <UIcon name="i-lucide-graduation-cap" class="size-7" />
      </div>
      <h1 class="text-lg font-bold text-cepreuna-700 dark:text-white">CEPREUNA</h1>
      <p class="text-sm text-muted">Panel de Estadísticas</p>
    </div>

    <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
      <UFormField label="Correo" name="email">
        <UInput v-model="state.email" type="email" placeholder="correo@cepreuna.edu.pe" icon="i-lucide-mail" class="w-full" autofocus />
      </UFormField>

      <UFormField label="Contraseña" name="password">
        <UInput v-model="state.password" type="password" placeholder="••••••••" icon="i-lucide-lock" class="w-full" />
      </UFormField>

      <UButton type="submit" block :loading="loading" label="Ingresar" />
    </UForm>
  </UCard>
</template>
