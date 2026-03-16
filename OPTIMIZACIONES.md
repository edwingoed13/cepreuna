# 🚀 Optimizaciones de Fast Origin Transfer - Vercel

## 📊 Problema Original
- **Consumo:** 9.8GB de Fast Origin Transfer
- **Causa:** APIs sin caché ejecutándose en cada request desde Serverless → CDN

---

## ✅ Soluciones Implementadas

### 1. **Cache-Control Headers en vercel.json**

Agregados headers de caché optimizados para cada tipo de ruta:

| Ruta | Cache Duration | Stale-While-Revalidate | Reducción Estimada |
|------|---------------|------------------------|-------------------|
| `/api/stats-inscripciones/*` | 3 minutos | 5 minutos | 40-50% |
| `/api/matriculas/totales` | 5 minutos | 10 minutos | 20-25% |
| `/api/matriculas/completo` | 10 minutos | 30 minutos | 10-15% |
| `/api/listado-curso/inscritos` | 5 minutos | 10 minutos | 10-15% |
| HTML estáticos (dashboard, etc) | 30 minutos | 1 hora | 5-8% |

**Headers de seguridad agregados:**
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`

---

### 2. **Cache Layer en Memoria (server.js)**

Implementado sistema de caché en memoria con TTL:

```javascript
// Cache con limpieza automática cada 5 minutos
const cache = new Map();
cacheMiddleware(ttlSeconds)
```

**Endpoints cacheados:**

#### Stats Inscripciones (TTL: 3-5 min)
- `/api/stats-inscripciones/totales` → 180s
- `/api/stats-inscripciones/por-sede` → 300s
- `/api/stats-inscripciones/por-area` → 300s
- `/api/stats-inscripciones/por-turno` → 300s
- `/api/stats-inscripciones/por-dia` → 300s
- `/api/stats-inscripciones/pagos-por-dia` → 300s
- `/api/stats-inscripciones/reporte-sedes` → 300s

#### Matrículas (TTL: 5-10 min)
- `/api/matriculas/totales` → 300s
- `/api/matriculas/por-area` → 300s
- `/api/matriculas/por-sede` → 300s
- `/api/matriculas/completo` → 600s (query más pesada)

#### Curso 2026 (TTL: 5 min)
- `/api/listado-curso/inscritos` → 300s
- `/api/curso2026/total-inscritos` → 300s
- `/api/curso2026/inscritos-por-area` → 300s

**Headers de debug agregados:**
- `X-Cache: HIT/MISS` - Indica si la respuesta vino del caché
- `X-Cache-TTL: <seconds>` - Tiempo restante antes de expiración

---

### 3. **Compresión Gzip/Brotli**

Implementado `compression` middleware:

```javascript
app.use(compression({
  level: 6,          // Balance velocidad/ratio
  threshold: 1024,   // Solo comprimir > 1KB
}));
```

**Beneficios:**
- Responses JSON reducidos en 70-85%
- Menor ancho de banda consumido
- Tiempos de respuesta más rápidos

---

## 📉 Reducción Estimada de Tráfico

| Optimización | Reducción Estimada |
|--------------|-------------------|
| Cache-Control headers (Vercel CDN) | 60% |
| Cache en memoria (Serverless) | 25% |
| Compresión Gzip | 10% |
| **TOTAL ESTIMADO** | **~80-85%** |

**Consumo proyectado:** 9.8GB → **1.5-2GB** (reducción de 7.8GB)

---

## 🔍 Monitoreo

### Verificar Cache Hits en Producción

1. **Ver headers de respuesta en navegador:**
```bash
curl -I https://cepreuna.info/api/stats-inscripciones/totales
```

Buscar:
- `Cache-Control: public, max-age=180, s-maxage=180...`
- `X-Cache: HIT` (después del primer request)
- `X-Vercel-Cache: HIT` (después de stale-while-revalidate)

2. **Ver logs de caché en Vercel:**
- Dashboard → Analytics → Edge Network
- Buscar "Cache Hit Rate" (debería subir a 70-90%)

3. **Ver Fast Origin Transfer en Vercel:**
- Dashboard → Usage
- Monitorear reducción de "Fast Origin Transfer" día a día

---

## ⚙️ Configuración de Auto-Refresh en Frontend

**IMPORTANTE:** El auto-refresh de `/stats/index.html` está configurado a **5 minutos**:

```javascript
// stats/index.html línea 261
setInterval(cargarEstadisticas, 5 * 60 * 1000); // 5 min
```

**Recomendación:** Aumentar a 10 minutos para maximizar cache hits:
```javascript
setInterval(cargarEstadisticas, 10 * 60 * 1000); // 10 min
```

---

## 🚨 Consideraciones

### ¿Cuándo invalidar el caché?

El caché se invalida automáticamente después del TTL, pero si necesitas invalidación manual:

**Opción 1: Reiniciar serverless function**
```bash
vercel env pull
# Modificar cualquier variable de entorno
vercel deploy
```

**Opción 2: Agregar endpoint de invalidación**
```javascript
app.post('/api/cache/clear', (req, res) => {
  cache.clear();
  res.json({ cleared: true });
});
```

### Datos en tiempo real vs Performance

Los TTL actuales están balanceados para:
- **Stats críticas:** 3 minutos (datos casi en tiempo real)
- **Reportes pesados:** 10 minutos (mejor performance)
- **Auth/Login:** Sin caché (seguridad)

Si necesitas datos más frescos, reduce el TTL (aumentará consumo).
Si necesitas mejor performance, aumenta el TTL (datos menos frescos).

---

## 📦 Dependencias Agregadas

```json
{
  "compression": "^1.7.4"
}
```

Instalar en producción:
```bash
npm install
```

---

## 🎯 Próximos Pasos (Opcional)

### Fase 2: Vercel KV para Cache Persistente
- Usar Vercel KV en lugar de Map() en memoria
- Cache compartido entre todas las invocaciones serverless
- **Reducción adicional estimada:** 5-10%

### Fase 3: Database Query Optimization
- Materializar vistas complejas en MySQL
- Agregar índices a queries lentas
- **Reducción adicional estimada:** 5%

### Fase 4: CDN para Assets Estáticos
- Mover imágenes/PDFs a Vercel Blob Storage
- **Reducción adicional estimada:** 2-3%

---

**Fecha de implementación:** 2026-03-15
**Implementado por:** Claude Code Agent
