# Despliegue global de Shoes App

## Objetivo
Preparar la aplicación para funcionar desde cualquier ubicación, con URL pública y base de datos configurada por variable de entorno.

## Archivos creados
- `Dockerfile`
- `.dockerignore`
- `docker-compose.yml`
- `Procfile`
- `DEPLOYMENT.md`

## Configuración de base de datos
La app ahora usa `DATABASE_URL` si está disponible. Si no, usa el archivo local:

```bash
DATABASE_URL=./database.sqlite
```

Esto permite disponer de:
- `sqlite:./database.sqlite`
- `file:./database.sqlite`
- o la ruta directa `./database.sqlite`

> En un hosting real, reemplaza `DATABASE_URL` con el valor del servicio que uses.

## Scripts útiles
- `npm run build` — compila la web y el servidor
- `npm run start:prod` — inicia el server en producción
- `npm run docker:build` — construye la imagen Docker
- `npm run docker:run` — ejecuta el contenedor localmente

## Despliegue con Docker
1. Construir la imagen:
   ```bash
   npm run docker:build
   ```
2. Ejecutar localmente:
   ```bash
   npm run docker:run
   ```

## Despliegue con Docker Compose
```bash
docker compose up --build
```

## Hosting gratuito recomendado
Puedes desplegar esta app usando cualquiera de estos servicios:

1. **Render** (subdominio gratis)
   - Build command: `npm install && npm run build`
   - Start command: `npm run start:prod`
   - Environment variables:
     - `PORT=5000`
     - `DATABASE_URL=./database.sqlite`
   - Usa el subdominio gratis `https://<tu-servicio>.onrender.com`

2. **Railway**
   - Crea un proyecto Node.js
   - Usa los mismos comandos de build/start
   - Configura `DATABASE_URL` si quieres un archivo SQLite local o una DB externa.

3. **Fly.io**
   - Usa el `Dockerfile` directamente
   - Asigna dominio gratis con `flyctl launch`

## Dominio gratis
- Render y Railway dan subdominios gratis automáticamente.
- Si quieres un dominio personalizado, puedes usar servicios como Cloudflare o Freenom.

## Notas sobre persistencia
- SQLite en un contenedor funciona bien con volumen persistente.
- Si el hosting no ofrece volumen permanente, usa un servicio de base de datos gestionada y configura `DATABASE_URL`.

## Estado actual
- La web ya está compilable.
- El servidor está preparado para producción.
- Se agregó soporte para la URL de base de datos.
- Se creó la infraestructura Docker para desplegar en cualquier servicio compatible con contenedores.
