# API interna de reportes — CEPREUNA

Servicio de **solo lectura** que se despliega **dentro de la red institucional** y
publica los reportes que necesita `cepreuna.info`.

## Por qué existe

El ciclo vigente vive en la base **multiciclo** (`10.1.30.44`), que está en la red
interna. El sitio corre en Vercel (internet) y **no tiene ruta hacia esa red**, así
que no puede consultarla ni con credenciales.

Esta API resuelve el problema sin exponer la base: se publica **solo un endpoint de
lectura**, protegido con token, y MySQL sigue accesible únicamente desde la red interna.

```
cepreuna.info (Vercel)  ──HTTPS──►  api-reportes.cepreuna.edu.pe
                                            │ nginx (proxy)
                                            ▼
                                    esta API (127.0.0.1:3001)
                                            │ red interna
                                            ▼
                                     MySQL 10.1.30.44  (nunca expuesto)
```

## Qué expone

| Ruta | Token | Descripción |
|---|---|---|
| `GET /salud` | no | Estado del servicio y de la conexión a la base (para monitoreo) |
| `GET /ciclo-actual/reporte-sedes` | **sí** | Inscritos y vacantes del ciclo vigente por sede, turno y área |

El ciclo **no está fijado en el código**: se resuelve con `periodos.es_actual = 1`,
de modo que al abrirse el siguiente ciclo el reporte lo toma sin cambios.

## Requisitos

- Node.js 18 o superior (usa `fetch` nativo)
- Acceso de red a `10.1.30.44:3306`
- Una cuenta MySQL de **solo lectura** (`cepre_viewer`, que ya tiene únicamente `SELECT`)

## Despliegue

### 1. Copiar el código

Se necesitan estas tres piezas del repositorio:

```
api-interna/server.js      ← este servicio
lib/reporte-ciclo.js       ← consulta compartida con el servidor principal
package.json               ← dependencias (express, mysql2, dotenv)
```

```bash
npm install --omit=dev
```

### 2. Variables de entorno (`.env`)

```env
API_PORT=3001
API_INTERNA_TOKEN=<token largo y aleatorio: openssl rand -hex 32>

DB2_HOST=10.1.30.44
DB2_PORT=3306
DB2_USER=cepre_viewer
DB2_PASSWORD="<contraseña>"     # entre comillas: si lleva '#' se corta sin ellas
DB2_NAME=cepreuna_multiciclo
```

> El servicio **no arranca** si falta `API_INTERNA_TOKEN`, para no quedar abierto por descuido.

### 3. Mantenerlo activo

```bash
pm2 start api-interna/server.js --name api-reportes
pm2 save && pm2 startup
```

(o una unidad `systemd` equivalente).

### 4. Publicarlo en nginx

Mismo patrón que el del sistema principal:

```nginx
server {
    server_name api-reportes.cepreuna.edu.pe;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Después:

```bash
certbot --nginx -d api-reportes.cepreuna.edu.pe
```

Y en el DNS, apuntar `api-reportes` a la IP pública del servidor (`161.132.24.62`).

### 5. Conectar el sitio

En Vercel → proyecto `cepreuna` → *Settings → Environment Variables*:

```
API_INTERNA_URL=https://api-reportes.cepreuna.edu.pe
API_INTERNA_TOKEN=<el mismo token del paso 2>
```

Y redesplegar. El servidor principal detecta `API_INTERNA_URL` y pasa a pedir los
datos por HTTPS en lugar de intentar MySQL directo.

## Seguridad

- Escucha **solo en `127.0.0.1`**: desde fuera únicamente se entra por nginx.
- **Token obligatorio** en el endpoint de datos, comparado en tiempo constante.
- La cuenta de base de datos es de **solo lectura**: aunque alguien superara el token,
  no podría escribir nada.
- Solo se publica el reporte agregado (totales por sede/turno/área). **No expone datos
  personales de estudiantes.**
- Recomendable además restringir en nginx el acceso al origen del sitio, o exigir una
  cabecera adicional.

## Comprobación

```bash
curl https://api-reportes.cepreuna.edu.pe/salud
# {"estado":"ok","base":"accesible"}

curl https://api-reportes.cepreuna.edu.pe/ciclo-actual/reporte-sedes \
     -H "Authorization: Bearer <token>"
```

## Si el servicio se cae

El sitio **no se rompe**: el reporte responde 503 y la página muestra
"Ciclo vigente no disponible". Al volver el servicio, se restablece solo.
