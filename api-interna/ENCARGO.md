# Encargo: publicar la API interna de reportes

## Contexto

`cepreuna.info` corre en **Vercel (internet)**. Los datos del **ciclo vigente
(2026-II)** están en la base **multiciclo** `cepreuna_multiciclo`, en `10.1.30.44`,
que vive en la **red interna** y solo se alcanza por VPN.

Resultado: el sitio no puede mostrar los datos del ciclo actual. Hoy los paneles
siguen mostrando el ciclo Marzo–Julio porque leen la base antigua
(`138.68.226.228`), que es la única accesible desde internet.

**No queremos exponer MySQL a internet.** La solución acordada es publicar una
**API de solo lectura** dentro de la red institucional, que el sitio consume por HTTPS.

```
cepreuna.info (Vercel)  ──HTTPS──►  api-reportes.cepreuna.edu.pe
                                            │ nginx (proxy inverso)
                                            ▼
                                    API Node (127.0.0.1:3001)
                                            │ red interna
                                            ▼
                                  MySQL 10.1.30.44  (NUNCA expuesto)
```

## Qué se pide

Desplegar y publicar el servicio que ya está desarrollado y probado. **No hay que
programar nada**: el código está listo y validado de extremo a extremo.

### Archivos: se despliega SOLO la carpeta `api-interna/`

Es **autónoma**: tiene su propio `package.json`, su propio `.env` y la consulta
incluida en `lib/`. No depende del repositorio principal.

```
api-interna/
├── server.js            ← el servicio
├── package.json         ← solo express, mysql2 y dotenv
├── lib/reporte-ciclo.js ← la consulta
├── .env.example         ← plantilla de configuración
├── README.md            ← guía detallada
└── ENCARGO.md           ← este documento
```

Copia esa carpeta al servidor (del repo `edwingoed13/cepreuna`, o te la enviamos
empaquetada). **Nada más del repositorio hace falta.**

### Pasos

**1. Desplegar en el servidor que ya publica `sistemas.cepreuna.edu.pe`**
(Ubuntu con nginx 1.18 y Let's Encrypt ya configurados) o en cualquier host de la
red con salida publicable.

```bash
cd api-interna
npm install --omit=dev      # 3 dependencias directas
```

Requiere **Node.js 18+**.

**2. Archivo `.env` — dentro de `api-interna/`**

```bash
cp .env.example .env        # y completar los dos valores que faltan
```

```env
API_PORT=3001
API_INTERNA_TOKEN=<generar en el servidor: openssl rand -hex 32>

DB2_HOST=10.1.30.44
DB2_PORT=3306
DB2_USER=cepre_viewer
DB2_PASSWORD="<la contraseña de cepre_viewer>"
DB2_NAME=cepreuna_multiciclo
```

> ⚠️ La contraseña **debe ir entre comillas**: contiene un `#` y sin comillas
> dotenv la corta en ese carácter (ya nos pasó, y provoca `Access denied`).

El servicio lee **este** `.env` por ruta absoluta, así que da igual el `cwd` con el
que se arranque y **nunca hereda** el `.env` del proyecto principal.

**3. Mantenerlo activo**

```bash
pm2 start server.js --name api-reportes --cwd /ruta/a/api-interna
pm2 save && pm2 startup
```

En el arranque debe aparecer en el log:

```
API interna escuchando en http://127.0.0.1:3001
Base multiciclo: 10.1.30.44/cepreuna_multiciclo
Conexión a la base verificada.
```

Si la última línea dice `AVISO: no se pudo conectar…`, falta el grant (ver más abajo).

**4. Publicar en nginx** (mismo patrón que el sistema principal)

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

```bash
certbot --nginx -d api-reportes.cepreuna.edu.pe
```

> **Cuidado: se toca el nginx que sirve `sistemas.cepreuna.edu.pe`.** Poner el bloque
> en un archivo aparte bajo `sites-available/` (enlazado en `sites-enabled/`), ejecutar
> `nginx -t` antes de cada recarga y hacerlo **fuera del horario de inscripciones**.
> Tener a mano el `rollback`: deshabilitar el enlace y recargar.

**5. DNS:** crear `api-reportes.cepreuna.edu.pe` → IP pública del servidor
(`161.132.24.62` si es el mismo del sistema principal). **Hacerlo ANTES de certbot**,
que necesita que el nombre resuelva para validar.

**6. Cargar el token en Vercel** directamente desde el servidor donde se generó, sin
hacerlo circular por chat ni correo:

```
API_INTERNA_URL=https://api-reportes.cepreuna.edu.pe
API_INTERNA_TOKEN=<el token del paso 2>
```

(Proyecto `cepreuna` → Settings → Environment Variables → redesplegar.)

## Verificación

```bash
# Sin token — debe responder ok (es el healthcheck)
curl https://api-reportes.cepreuna.edu.pe/salud
# Esperado: {"estado":"ok","base":"accesible"}

# Sin token en el endpoint de datos — debe rechazar
curl -o /dev/null -w "%{http_code}\n" https://api-reportes.cepreuna.edu.pe/ciclo-actual/reporte-sedes
# Esperado: 401

# Con token — debe devolver el reporte
curl https://api-reportes.cepreuna.edu.pe/ciclo-actual/reporte-sedes \
     -H "Authorization: Bearer <token>"
# Esperado: JSON con "periodo":{"codigo":"2026-II"...} y ~1190 inscritos
```

## Notas de seguridad

- El servicio escucha **solo en `127.0.0.1`**; desde fuera solo se entra por nginx.
- **Token obligatorio** en el endpoint de datos (comparación en tiempo constante).
  El proceso **no arranca** sin token, para que no quede abierto por descuido.
- La cuenta `cepre_viewer` tiene **únicamente `SELECT`**: aunque alguien superara el
  token, no podría escribir nada.
- Solo se publican **totales agregados** por sede, turno y área. **No expone datos
  personales de estudiantes.**
- Opcional recomendado: restringir en nginx por origen, o exigir una cabecera extra.

## Qué expone (nada más que esto)

| Ruta | Token | Devuelve |
|---|---|---|
| `GET /salud` | no | Estado del servicio y de la conexión a la base |
| `GET /ciclo-actual/reporte-sedes` | sí | Inscritos y vacantes del ciclo vigente por sede/turno/área |

El ciclo **no está fijado en el código**: se resuelve con `periodos.es_actual = 1`,
así que al abrirse el 2027-I lo tomará automáticamente, sin tocar nada.

## Sobre el acceso a la base — resolver ANTES de desplegar

`cepre_viewer` funciona hoy con el grant `cepre_viewer@'10.1.60.%'`, que es el rango
por el que salen los clientes **VPN**. Desde el servidor institucional la conexión
será **directa por la red interna**, con otra IP de origen, así que **casi seguro
hará falta un grant adicional**. Si no se añade antes, el servicio arrancará pero
quedará en `degradado` permanente.

**1. Averiguar la IP de origen** — desde el propio servidor:

```bash
ip route get 10.1.30.44        # muestra la IP de salida en el campo "src"
```

**2. Verificar los grants existentes** — en `10.1.30.44`:

```sql
SELECT user, host FROM mysql.user WHERE user = 'cepre_viewer';
```

**3. Añadir el grant** para esa IP (o su rango), solo `SELECT`:

```sql
CREATE USER 'cepre_viewer'@'<IP-del-servidor>' IDENTIFIED BY '<misma contraseña>';
GRANT SELECT ON cepreuna_multiciclo.* TO 'cepre_viewer'@'<IP-del-servidor>';
FLUSH PRIVILEGES;
```

**4. Comprobar antes de montar nada más:**

```bash
mysql -h 10.1.30.44 -u cepre_viewer -p cepreuna_multiciclo -e "SELECT codigo FROM periodos WHERE es_actual=1;"
# Esperado: 2026-II
```

## Si el servicio se cae

El sitio **no se rompe**: responde 503 y la página muestra "Ciclo vigente no
disponible". Al volver el servicio se restablece solo, sin intervención.
