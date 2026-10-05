# Encargo: desplegar el panel de estadísticas en el servidor institucional

> Sustituye a `api-interna/ENCARGO.md`, que planteaba publicar una API de dos
> rutas. Esa vía se probó y funciona, pero no escala: hacen falta 65 endpoints,
> no 2. Ver §6.

## 1. Qué se pide

Desplegar el proyecto **`edwingoed13/cepreuna`** (Node + Express) en un servidor
de la red institucional, y que `cepreuna.info` lo use en lugar del despliegue
actual de Vercel para las rutas del panel.

No hay que programar nada: el código está escrito, probado y en producción. Lo
único que cambia es **dónde corre el proceso**.

## 2. Por qué

El panel `/stats` lee la base operativa. Esa base dejó de ser
`cepreuna_production` (el servidor que la alojaba se dio de baja) y ahora es
**`cepreuna_multiciclo` en `10.1.30.44`**, dentro de la red interna.

Vercel está en internet y no tiene ruta hacia esa red, así que **65 de los 91
endpoints del panel responden error**. Son todos los paneles: habilitados,
reportes de auxiliares, matrículas, calificaciones, pagos.

Corriendo el Express dentro de la red, `pool` alcanza MySQL directamente y los 65
funcionan sin tocar una línea.

```
                        cepreuna.info
                              │
          ┌───────────────────┴───────────────────┐
          │  Astro (Vercel)                       │
          │  web pública, /admin, chatbot         │
          │                                       │
          │  rewrites ───────────────────────────►│  Express (servidor interno)
          │   /stats/*  /api/stats*  /dashboard   │  /stats, APIs
          │   /docentes /curso /materiales …      │        │ red local
          └───────────────────────────────────────┘        ▼
                                                     MySQL 10.1.30.44
```

## 3. Requisitos

- **Node.js 18 o superior**
- Acceso de red a `10.1.30.44:3306`
- nginx (ya está, es el que publica `sistemas.cepreuna.edu.pe`)
- Un subdominio, p. ej. `panel.cepreuna.edu.pe`

## 4. Pasos

### 4.1 Código

```bash
git clone https://github.com/edwingoed13/cepreuna.git
cd cepreuna
npm install --omit=dev
```

### 4.2 Variables (`.env` en la raíz del proyecto)

```env
PORT=3000

# Base operativa: la multiciclo, en la red interna
DB_HOST=10.1.30.44
DB_PORT=3306
DB_USER=cepre_viewer
DB_PASSWORD="…"            # entre comillas: contiene '#' y sin ellas dotenv la corta
DB_NAME=cepreuna_multiciclo

JWT_SECRET=…               # el mismo que hay hoy en Vercel, para no invalidar sesiones
SUPABASE_URL=…             # padrón de acceso de docentes
SUPABASE_SERVICE_KEY=…
APISPERU_TOKEN=…           # consulta de RUC (forms-admin)
APPS_SCRIPT_URL=…          # backend del forms-admin
```

Los valores actuales están en **Vercel → proyecto `cepreuna` → Settings →
Environment Variables**. Hay que copiarlos tal cual, salvo los `DB_*`, que pasan
a apuntar a la base interna.

> **No** definir `API_INTERNA_URL`: esa variable existe para el modo puente, que
> ya no se usa. Si está presente, el servidor intentará salir a internet en vez
> de consultar la base que tiene al lado.

### 4.3 Permisos de base de datos

`cepre_viewer` tiene hoy `SELECT` para el rango de la VPN (`10.1.60.%`). Desde el
servidor la conexión será directa por la red interna, con otra IP de origen:

```bash
ip route get 10.1.30.44        # el campo "src" es la IP de salida
```

```sql
SELECT user, host FROM mysql.user WHERE user = 'cepre_viewer';
CREATE USER 'cepre_viewer'@'<IP-del-servidor>' IDENTIFIED BY '<contraseña>';
GRANT SELECT ON cepreuna_multiciclo.* TO 'cepre_viewer'@'<IP-del-servidor>';
FLUSH PRIVILEGES;
```

Comprobar antes de seguir:

```bash
mysql -h 10.1.30.44 -u cepre_viewer -p cepreuna_multiciclo \
  -e "SELECT codigo FROM periodos WHERE es_actual=1;"     # esperado: 2026-II
```

> **Solo lectura.** El panel no escribe en la base operativa; lo único que graba
> son las calificaciones de auxiliares, y eso va a Supabase.

### 4.4 Servicio

```bash
pm2 start server.js --name panel-stats
pm2 save && pm2 startup
```

Comprobar: `curl localhost:3000/health` → `{"status":"OK"}`

### 4.5 nginx

Bloque aparte en `sites-available/`, enlazado en `sites-enabled/`:

```nginx
server {
    server_name panel.cepreuna.edu.pe;

    client_max_body_size 20M;          # descargas de Excel y subida de archivos

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;        # algunos reportes tardan
    }
}
```

```bash
nginx -t && systemctl reload nginx
certbot --nginx -d panel.cepreuna.edu.pe
```

> Se toca el nginx que sirve `sistemas.cepreuna.edu.pe`. Hacerlo **fuera del
> horario de inscripciones**, con `nginx -t` antes de cada recarga y el rollback
> a mano (deshabilitar el enlace y recargar).

Crear el registro DNS **antes** de certbot, que lo necesita para validar.

### 4.6 Redirigir el tráfico

En el repo del sitio (`edwingoed13/cepre-v2-web`), `vercel.json` → `rewrites`:
cambiar el destino de `https://cepreuna.vercel.app` a
`https://panel.cepreuna.edu.pe` en las rutas del panel:

```
/stats/*  /api/stats*  /api/stats-inscripciones/*  /api/matriculas/*
/dashboard  /docentes  /curso  /videos  /materiales  /certificado  /simulacro
/formulario-admins/*  /informe-*
```

Las rutas propias del Astro (`/`, `/ciclos`, `/admin`, `/api/auth`, `/api/chat`,
`/_astro`) **no** se tocan.

## 5. Comprobación

```bash
curl https://panel.cepreuna.edu.pe/health
# {"status":"OK","jwtSecretConfigured":true}

curl -o /dev/null -w "%{http_code}\n" https://panel.cepreuna.edu.pe/api/stats/reporte-pagos
# 401  (correcto: exige sesión)
```

Y en el navegador, entrando en `cepreuna.info/stats/login` con una cuenta del
sistema: el panel debe cargar y los reportes mostrar el ciclo **2026-II**.

## 6. Por qué cambió el enfoque

El encargo anterior proponía publicar una API con dos rutas (`api-interna/`). Se
desarrolló, se probó de extremo a extremo y **funciona**: con ella quedaron
operativos el login, el reporte por sedes y la vista de alumnos.

Pero al conectarlas se vio el tamaño real del problema: **65 endpoints** dependen
de la base. Pasarlos uno a uno por el puente significaría reescribir el servidor
entero dentro de `api-interna`, con la lógica duplicada en dos sitios.

Mover el proceso resuelve los 65 a la vez, elimina el salto por internet en cada
consulta y deja una sola pieza que mantener. `api-interna/` queda en el
repositorio como referencia, pero no hace falta desplegarla.

## 7. Qué se arregló por el camino

Trabajando contra la base nueva aparecieron defectos reales, ya corregidos y
desplegados. Se listan porque explican diferencias con los números antiguos:

- **Matrículas duplicadas.** 7 516 registros para 6 697 alumnos; 819 salían dos
  veces en el reporte. Se une contra la más reciente.
- **Cuotas multiplicadas.** `tarifa_estudiantes` guarda los diez ciclos y las
  uniones no filtraban por periodo: 841 323 filas en vez de 6 671.
- **Periodo fijo.** El código apuntaba a `periodos_id = 1` y a un rango de fechas
  escrito a mano. Ahora todo sale de `periodos.es_actual = 1`, así que el ciclo
  siguiente funcionará sin tocar nada.
- **Estado de pago.** En este ciclo las cuotas no están en `tarifa_estudiantes`
  (solo 210 alumnos): se deducen de `inscripcion_pagos` por concepto, y la tarifa
  se resuelve como en el sistema de inscripciones, por
  `colegios.tipo_colegios_id`.
- **Conexiones caídas.** Se reintenta una vez ante cortes de transporte, que
  provocaban errores intermitentes.

## 8. Pendiente, ajeno a este despliegue

- **44 alumnos con S/ 1 605 por cobrar**: al cambiar de modalidad de virtual a
  presencial no se recalcula la matrícula. Lo revisa el equipo del sistema de
  inscripciones; el detalle está en `cambios-modalidad-sin-recalcular-2026ii.csv`.
- **819 matrículas duplicadas** en `matriculas` del periodo 10. El reporte ya no
  se ve afectado, pero conviene depurarlas.
