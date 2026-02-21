# CEPREUNA - Portal del Estudiante 2026

Portal web mobile-first para estudiantes del CEPREUNA con acceso a materiales, videos, certificados y más.

## 🚀 Características

- **Búsqueda por DNI**: Acceso seguro mediante DNI del estudiante
- **Dashboard personalizado**: Visualización de información del estudiante
- **Sección Curso**: Materiales del curso organizados por área
- **Sección Videos**: Grabaciones de las clases de Google Meet
- **Sección Materiales**: Archivos descargables (PDF, DOCX, PPTX)
- **Sección Certificado**: Generación automática de certificados en PDF
- **Diseño Mobile-First**: Optimizado para dispositivos móviles
- **PWA Ready**: Manifest incluido para instalación como app

## 🛠️ Tecnologías

- **Frontend**: HTML5, CSS3, JavaScript (Vanilla)
- **Estilos**: Tailwind CSS (CDN)
- **PDF Generation**: jsPDF
- **Backend API**: Railway (Railway.app)
- **Deploy**: Vercel

## 📋 Requisitos

No requiere instalación de dependencias. Todo funciona con CDN.

## 🔧 Configuración

### Variables de Entorno en Vercel

No se requieren variables de entorno en el frontend. La API URL está configurada directamente en el código:

```javascript
const API_URL = 'https://backend-cepreuna-2025-production.up.railway.app/api';
```

### API Endpoints Utilizados

- `GET /api/listado-curso?dni={dni}` - Buscar estudiante en listado de curso
- `GET /api/inscripciones?dni={dni}` - Buscar estudiante en inscripciones

## 🚀 Despliegue en Vercel

### Opción 1: Desde GitHub (Recomendado)

1. Sube el proyecto a GitHub
2. Ve a [Vercel](https://vercel.com)
3. Click en "New Project"
4. Importa tu repositorio de GitHub
5. Vercel detectará automáticamente la configuración
6. Click en "Deploy"

### Opción 2: Vercel CLI

```bash
# Instalar Vercel CLI
npm i -g vercel

# Desde la carpeta del proyecto
cd D:\cepreuna

# Login en Vercel
vercel login

# Deploy
vercel --prod
```

## 📱 Progressive Web App (PWA)

El proyecto incluye `manifest.json` para funcionar como PWA. Para que funcione completamente:

1. Agrega iconos en la raíz del proyecto:
   - `icon-192.png` (192x192px)
   - `icon-512.png` (512x512px)

2. Los usuarios podrán instalar la app en sus dispositivos móviles

## 📁 Estructura del Proyecto

```
cepreuna/
├── index.html           # Página de login (búsqueda por DNI)
├── dashboard.html       # Dashboard principal
├── curso.html          # Sección de curso
├── videos.html         # Sección de videos
├── materiales.html     # Sección de materiales
├── certificado.html    # Sección de certificados
├── manifest.json       # PWA manifest
├── vercel.json        # Configuración de Vercel
└── README.md          # Este archivo
```

## 🎨 Personalización

### Modificar colores del tema

El proyecto usa un esquema de colores azul. Para cambiar:

1. Busca `bg-blue-600` y reemplaza por tu color preferido
2. Modifica el gradiente en `body`:
   ```css
   background: linear-gradient(135deg, #TU_COLOR_1 0%, #TU_COLOR_2 100%);
   ```

### Agregar materiales por área

Edita los objetos `materialesPorArea` en cada archivo:

**curso.html**:
```javascript
const materialesPorArea = {
    'Area 1': [
        { nombre: 'archivo.pptx', tipo: 'pptx', url: 'URL_AQUI' }
    ]
};
```

### Agregar videos

Edita `videosPorArea` en `videos.html`:
```javascript
const videosPorArea = {
    'Area 1': [
        {
            titulo: 'Título del video',
            fecha: '2026-XX-XX',
            duracion: 'X horas',
            url: 'URL_GOOGLE_DRIVE'
        }
    ]
};
```

## 🎓 Personalizar Certificado

Para personalizar el certificado PDF, edita la función `generarCertificadoPDF()` en `certificado.html`:

```javascript
function generarCertificadoPDF() {
    // Personaliza colores, fuentes, textos, etc.
}
```

### Agregar imagen de fondo al certificado

1. Convierte tu imagen a Base64
2. Agrega en la función:
   ```javascript
   doc.addImage(imagenBase64, 'PNG', 0, 0, 297, 210);
   ```

## 🔒 Seguridad

- Headers de seguridad configurados en `vercel.json`
- Validación de entrada (solo números en DNI)
- localStorage para manejo de sesión
- Redirección automática si no hay autenticación

## 📞 Soporte

Para soporte técnico, contacta a:
- **Oficina de Comunicaciones y Desarrollo de Software**
- **CEPREUNA 2026**

## 📄 Licencia

Proyecto desarrollado para CEPREUNA - Universidad Nacional del Altiplano

---

**Desarrollado con ❤️ para CEPREUNA 2026**
