// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },

  modules: ['@nuxt/ui', '@vueuse/nuxt'],

  css: ['~/assets/css/main.css'],

  // SPA: el panel admin no necesita SSR y simplifica el manejo de localStorage/sesión.
  ssr: false,

  runtimeConfig: {
    public: {
      // En dev se usa el devProxy (/api → :3000). En prod se setea NUXT_PUBLIC_API_BASE
      // al origen del backend (p. ej. https://cepreuna.info).
      apiBase: ''
    }
  },

  // Proxy de desarrollo: /api → Express local en :3000 (evita CORS en dev).
  nitro: {
    devProxy: {
      '/api': {
        target: 'http://localhost:3000/api',
        changeOrigin: true
      }
    }
  },

  app: {
    head: {
      title: 'CEPREUNA · Estadísticas',
      htmlAttrs: { lang: 'es' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' }
      ]
    }
  }
})
