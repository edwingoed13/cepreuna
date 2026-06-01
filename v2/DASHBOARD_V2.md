# Dashboard v2 — Panel /stats CEPREUNA (Nuxt 4 + Nuxt UI v4)

> Documento de diseño y plan de construcción. La implementación se hará **desde cero** en esta carpeta `v2/`.
> El backend y el panel actual (`/stats/*.html`) **no se tocan**: la v2 solo es un frontend nuevo que consume la misma API.

---

## 1. Objetivo

Rehacer el **panel de estadísticas admin** (`/stats`) con el aspecto del template oficial de Nuxt
(`dashboard-template.nuxt.dev`): sidebar colapsable, command palette, modo claro/oscuro, tarjetas,
tablas y gráficos modernos — manteniendo **la misma funcionalidad** (paridad 1:1) de las 8 vistas actuales.

- **Qué:** solo el panel `/stats` (admin). No el portal del alumno.
- **Cómo:** app **Nuxt 4 real** con **Nuxt UI v4** (desde 2025 es 100% gratis y open source, MIT; un solo paquete `@nuxt/ui` que ya incluye los componentes `UDashboard*`). No requiere licencia.
- **Alcance:** paridad completa de las 8 páginas.
- **Backend:** se reutiliza tal cual (`/api/stats/*`, `/api/stats-inscripciones/*`).

---

## 2. Stack técnico

| Pieza | Elección |
|---|---|
| Framework | **Nuxt 4** (`nuxt@^4.4`) |
| UI | **Nuxt UI v4** (`@nuxt/ui@^4.7`) — incluye `UDashboardGroup/Sidebar/Panel/Navbar/Toolbar`, `UTable`, `UModal`, `UForm`, `USelectMenu`, `UTooltip`, command palette |
| Gráficos | `@unovis/vue` (barras, líneas, donut) |
| Iconos | **Lucide** (`@iconify-json/lucide`) |
| Utilidades | `@vueuse/nuxt`, `date-fns`, `zod` (validación de formularios) |
| Estilos | Tailwind v4 (integrado en Nuxt UI v4) |
| Node | 20+ (hay 22 en el equipo) |

---

## 3. Arquitectura de carpetas (`v2/`)

```
v2/
├─ nuxt.config.ts        # módulos, devProxy /api → localhost:3000, runtimeConfig.apiBase
├─ app.config.ts         # tema: color primary #003366, radius, etc.
├─ package.json
├─ tsconfig.json
├─ app/
│  ├─ app.vue
│  ├─ assets/css/main.css        # @import "tailwindcss"; @import "@nuxt/ui";
│  ├─ layouts/
│  │  ├─ default.vue             # shell con UDashboardSidebar + UDashboardPanel
│  │  └─ auth.vue                # layout minimal para /login
│  ├─ middleware/
│  │  └─ auth.global.ts          # guard único: sesión/exp/rol (sin el bug de redirects)
│  ├─ composables/
│  │  ├─ useAuth.ts              # sesión localStorage, user/token/role, esAdmin, logout, exp
│  │  └─ useApi.ts               # $fetch con Bearer; 401→logout, 403→toast "sin permisos"
│  ├─ utils/
│  │  ├─ roles.ts                # ADMIN_ROLES (igual al backend)
│  │  ├─ format.ts              # moneda S/, fechas, números es-PE
│  │  └─ estados.ts             # colores pagada/parcial/sin y calificación
│  ├─ components/
│  │  ├─ GruposFilter.vue        # selector "grupos asignados" (chips)
│  │  ├─ KpiCard.vue             # tarjeta KPI reutilizable
│  │  └─ EstadoCelda.vue         # celda de cuota/calificación con color + glifo
│  └─ pages/
│     ├─ login.vue
│     ├─ index.vue              # Resumen
│     ├─ reportes.vue
│     ├─ alumnos.vue
│     ├─ alumnos-calificacion.vue
│     └─ reportes-aux/
│        ├─ index.vue
│        ├─ horas-docentes.vue
│        └─ cobertura-grupos.vue
└─ public/                       # logo, favicon
```

---

## 4. Sistema visual (el "aspecto")

- **Color primario:** `#003366` (azul CEPREUNA) → `primary` de Nuxt UI. Acentos: verde/ámbar/rojo para estados.
- **Tipografía:** Inter.
- **Modo oscuro:** nativo de Nuxt UI (toggle en la barra superior).
- **Estados (celdas de pago / calificación):** color **+ glifo** (accesible para daltonismo):
  - 🟢 Pagada / Completa — verde `#16a34a` + ✓
  - 🟡 Parcial — ámbar `#d97706` + ◐
  - 🔴 Sin pagar / Sin calificar — rojo `#dc2626` + ✗
- **Iconos (Material Symbols → Lucide):** dashboard→`layout-dashboard`, group→`users`, grading→`clipboard-check`, description→`file-text`, supervisor_account→`user-cog`.
- **Extras del template:** sidebar colapsable, **command palette** (Ctrl/Cmd+K) para saltar entre páginas, breadcrumbs, toasts.

### Shell general (todas las páginas internas)

```
┌──────────────┬──────────────────────────────────────────────────────────┐
│  CEPREUNA    │  Resumen ▸                          🔍  ◐ tema   ⟳   👤▾   │
│  Estadísticas│ ─────────────────────────────────────────────────────────│
│              │                                                            │
│ ▣ Resumen    │   (contenido de la página)                                │
│ ▤ Reportes   │                                                            │
│ ▤ Alumnos    │                                                            │
│ ✔ Calificac. │                                                            │
│ ▥ Rep. aux.  │                                                            │
│              │                                                            │
│ ───────────  │                                                            │
│ 👤 Admin User│                                                            │
│    rol · ⎋   │                                                            │
└──────────────┴──────────────────────────────────────────────────────────┘
   sidebar colapsable        topbar: buscador, tema, refrescar, perfil
```

En móvil: el sidebar se oculta y aparece una barra inferior + botón hamburguesa (igual que el template).

---

## 5. Navegación y acceso por rol

`ADMIN_ROLES = ['Administrador', 'Super Admin', 'Oficina de Administración']`

| Ítem | Ruta | Icono | ¿Solo admin? |
|---|---|---|---|
| Resumen | `/` | layout-dashboard | Sí |
| Reportes | `/reportes` | file-text | Sí |
| Alumnos | `/alumnos` | users | No (todos) |
| Alumnos-Calificación | `/alumnos-calificacion` | clipboard-check | No (todos) |
| Reportes auxiliares | `/reportes-aux` (+ 2 subpáginas) | user-cog | Sí |

- **Login admin** → `/` (Resumen). **No-admin** (auxiliar/coordinador) → `/alumnos`.
- Auxiliar/Coordinador solo ven **Alumnos** y **Calificación**, y filtrados a **sus grupos** (lo resuelve el backend por el token).
- Token vencido o sin sesión → `/login`.

---

## 6. Las 8 páginas (paridad + boceto)

### 6.1 Login (`/login`)
Tarjeta centrada, logo, email + contraseña, botón "Ingresar". Llama `POST /api/stats/login`, guarda
`{user, token}` en `localStorage('stats_session')` y redirige según rol.

```
            ┌───────────────────────────────┐
            │            (logo)             │
            │     Panel de Estadísticas     │
            │  Correo  [______________]     │
            │  Clave   [______________]     │
            │        [    Ingresar    ]     │
            └───────────────────────────────┘
```

### 6.2 Resumen (`/`) — admin
4 KPIs arriba + gráficos. Fuentes: `/api/stats-inscripciones/totales`, `por-area`, `por-sede`,
`por-dia`, `pagos-por-dia`. Auto-refresco.

```
┌ Total inscritos ┐ ┌ Pagos ┐ ┌ Inscritos hoy ┐ ┌ Ciclo ┐
│   1,250         │ │  480  │ │     45        │ │ Mar–Jul│
└─────────────────┘ └───────┘ └───────────────┘ └───────┘
┌─ Distribución por Área ───────┐ ┌─ Top Sedes ───────────┐
│ Área 1 ███████████ 350        │ │ Lima        600       │
│ Área 2 ████████ 280           │ │ Arequipa    320       │
│ Área 3 █████ 180              │ │ ...                   │
└──────────────────────────────┘ └───────────────────────┘
┌─ Tendencia de inscripciones (línea por día) ─────────────┐
└──────────────────────────────────────────────────────────┘
```

### 6.3 Alumnos · Reporte de Pagos (`/alumnos`)
Tabla con celdas de cuota coloreadas. Fuente: `/api/stats/reporte-pagos`. Export Excel
(`/reporte-pagos/excel`). Búsqueda por DNI, filtros por cuota, panel de grupos, orden y paginación.

```
KPIs:  Total alumnos · Cuotas pagadas · parciales · sin pagar
Filtros: [DNI___]  Cuota1▾ Cuota2▾ Cuota3▾ Cuota4▾   [Aplicar][Limpiar][⤓ Excel]
Grupos asignados: [G1·A1·M ✓] [G2·A2·T] [G3·A3·N] ...
┌ N° │ DNI │ Apellidos y Nombres │ Sede │ Área │ Turno │ Grupo │ Tipo │ 1ra │ 2da │ 3ra │ 4ta ┐
│  1 │…478 │ PEREZ GARCIA JUAN   │ Lima │ A1   │ Mañana│ G1    │ Priv.│✓500 │◐250 │✗  0 │✗  0 │
│  2 │……   │ …                   │ …    │ …    │ …     │ …     │ …    │✓500 │✓500 │✓500 │◐100 │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                    ‹ Anterior   Página 1 de 9   Siguiente ›     [25/50/100/250]
```

### 6.4 Alumnos · Calificación Docente (`/alumnos-calificacion`)
Igual estructura, columna **Calificación "X de Y"** con color y **tooltip** de cursos faltantes
(en parciales). Fuente: `/api/stats/calificaciones`.

```
KPIs:  Total · Completa · Parcial · Sin calificar
Filtros: [DNI___]  Estado▾   [Aplicar][Limpiar]
┌ N° │ DNI │ Apellidos y Nombres │ Sede │ Área │ Turno │ Grupo │ Calificación ┐
│  1 │…    │ ABADO SANCA RUBEN   │ Puno │ A3   │ Tarde │ B-203 │  🟢 12 de 12 │
│  2 │…    │ ACCHA CARRASCO Y.    │ Puno │ A4   │ Tarde │ S-203 │  🟡 12 de 13 │ ← tooltip: "Le falta: Física"
│  3 │…    │ …                   │ …    │ …    │ …     │ …     │  🔴 0 de 14  │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.5 Reportes por Sede (`/reportes`) — admin
Pestañas por sede; dentro, desglose turno→área con inscritos/capacidad/vacantes y barra de ocupación.
Fuente: `/api/stats-inscripciones/reporte-sedes`.

```
[ Lima 600 ][ Arequipa 320 ][ Cusco 210 ] ...
┌ Turno Mañana ────────────────┐ ┌ Turno Tarde ─────────────────┐
│ Área 1  100/120  ███████░ 83%│ │ Área 1  90/120  ██████░░ 75% │
│ Área 2  120/120  ████████100%│ │ Área 2  60/120  ████░░░░ 50% │
└──────────────────────────────┘ └──────────────────────────────┘
```

### 6.6 Reportes auxiliares (`/reportes-aux`) — admin
Landing con 2 tarjetas hacia las subpáginas.

```
┌─ 💳 Horas pago por docentes ─┐  ┌─ ▦ Cobertura de asistencia ─┐
│ Horas a pagar por coord/aux/ │  │ Matriz SI/NO por grupo y día │
│ sede/turno/área/grupo.       │  │ con % de cumplimiento.       │
│ [Rango fechas][multi-select] │  │ [Matriz][% cumplimiento]     │
└──────────────────────────────┘  └──────────────────────────────┘
```

### 6.7 Horas pago por docentes (`/reportes-aux/horas-docentes`) — admin
Filtros server-side (rango de fechas, tipo de carga, multi-selects de sede/turno/área/grupo/
coordinador/auxiliar), KPIs, tabla con totales y export Excel.
Fuentes: `/api/stats/reportes-aux/horas-docentes` + catálogos + `rango-fechas`.

```
Filtros: Desde[__] Hasta[__] Tipo▾  Sede▾ Turno▾ Área▾ Grupo▾ Coord▾ Aux▾  [Generar][Excel]
KPIs: Horas pago · Horas dictadas · Filas · Rango
┌ Coordinador │ Auxiliar │ Sede │ Turno │ Área │ Grupo │ Asist. │ H.dictadas │ H.pago ┐
│ M. López    │ C. Ruiz  │ Lima │ Mañana│ A1   │ G1    │   12   │    52.0    │  48.5  │
│ ...                                                                                  │
│ TOTAL                                                          1,450.0     1,250.5  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 6.8 Cobertura de asistencia (`/reportes-aux/cobertura-grupos`) — admin
Matriz grupo × día (SI/NO/—), toggle semanal/por-fecha, multi-selects con búsqueda, % cumplimiento,
export. Fuente: `/api/stats/reportes-aux/cobertura-grupos`.

```
Filtros: Desde[__] Hasta[__] Estado▾ Días▾  Sede▾ Turno▾ Área▾ Grupo▾ Aux▾   [Semanal|Por fecha]
KPIs: Grupos · Cumplimiento prom. · Con faltas · Sin auxiliar
┌ Grupo │ Área │ Turno │ Sede │ Auxiliar │ Lun │ Mar │ Mié │ Jue │ Vie │ SI/Tot │  %  ┐
│ G1    │ A1   │ Mañana│ Lima │ C. Ruiz  │ SI  │ SI  │ NO  │ SI  │ SI  │  4/5   │ 80% │
│ G2    │ A2   │ Tarde │ Lima │ —        │ NO  │ NO  │ NO  │ SI  │ SI  │  2/5   │ 40% │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Componentes propios a portar
- **Selector "grupos asignados"** → `GruposFilter.vue` (chips toggle, búsqueda).
- **Tooltip de cursos faltantes** → `UTooltip` nativo de Nuxt UI (resuelve de raíz el problema del `title` nativo en Windows).
- **Multi-select con búsqueda** (el `msInit` casero de cobertura) → `USelectMenu` multiple (nativo).
- **Celda de estado** → `EstadoCelda.vue` (color + glifo + tooltip).

---

## 8. Sesión y seguridad (igual que hoy)
- Sesión en `localStorage('stats_session') = { user:{id,name,email,role}, token }`.
- Cada petición lleva `Authorization: Bearer <jwt>`; **401** → cerrar sesión y volver a `/login`; **403** → toast "sin permisos" (sin cerrar sesión).
- `middleware/auth.global.ts`: un único guard que valida sesión + expiración (base64url) + rol. Elimina la duplicación y el bug de redirects de la v1.
- La autorización real sigue en el backend (`requireStatsAuth` / `requireAdmin` / grupos por rol).

---

## 9. Despliegue (se decide después)
- **Dev:** `npm run dev` en puerto propio (p. ej. 3030) con **devProxy** `/api` → `http://localhost:3000` (sin CORS).
- **Prod (recomendado):** proyecto Vercel separado en subdominio (p. ej. `panel.cepreuna.info`) apuntando la API a `https://cepreuna.info` (agregar ese origen a `CORS_ORIGINS`).
- Alternativa: servir bajo subpath `/v2` del mismo proyecto (más enredado en `vercel.json`). **A confirmar antes de desplegar.**

---

## 10. Orden de construcción (mañana)
1. **Scaffold** Nuxt 4 + Nuxt UI v4 en `v2/`, tema, devProxy, layout + sidebar, login + `useAuth` + middleware. → *Hito: login y shell navegable según rol.*
2. **Datos:** Alumnos y Alumnos-Calificación (tablas, filtros, colores, tooltip, export).
3. **Resumen** (KPIs + gráficos) y **Reportes** (tabs por sede).
4. **Reportes auxiliares:** landing + horas-docentes + cobertura (filtros server-side + export).
5. **Pulido:** dark mode, responsive, estados loading/empty/error, paridad visual con el template.

## 11. Cómo se probará
- `cd v2 && npm install && npm run dev` levanta sin errores; `npm run build` y `npx nuxt typecheck` pasan.
- Con el Express local en `:3000`, validar cada página por rol (admin / Oficina / auxiliar / coordinador / token vencido).
- Confirmar paridad de columnas, colores, filtros, orden/paginación, tooltips y export Excel con el panel actual.
- El panel `/stats` original sigue intacto.

---

## 12. Fuera de alcance (por ahora)
- Despliegue a producción (se decide y configura después).
- Cambios en el backend o en el panel `/stats` actual.
- Portal del alumno (`dashboard.html`).
