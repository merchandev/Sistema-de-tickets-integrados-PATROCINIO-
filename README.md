# Sistema de tickets integrados · Patrocinio

Un único repositorio para tres aplicaciones independientes que comparten inventario de entradas y verificación de pagos.

| Carpeta | Función | Puerto del contenedor |
| --- | --- | --- |
| `sistema-central/` | API, SQLite, reservas, BCV, dashboard, PDF/QR y notificaciones | 4000 |
| `pagina-web-1/` | Iluminando Caminos: portada y compra | 3001 |
| `pagina-web-2/` | Hablemos de Marketing: portada y compra | 3002 |

Las dos páginas consultan exclusivamente el sistema central. Cada reserva se protege con una transacción SQLite y dura 180 segundos. La orden conserva el origen de la web y la cotización de su reserva; aprobar el pago genera la entrada PDF y el token QR. Los ingresos a conferencias y concierto se registran por separado.

## Desarrollo local

Requisitos: Node.js 24 para los scripts locales y Docker con Compose compatible con `!override` (2.24.4 o posterior).

```bash
npm ci
npm run setup
docker compose up -d --build --wait
```

Abrir `http://localhost:3001`, `http://localhost:3002` y `http://localhost:4000/admin/`. Las credenciales administrativas locales se generan en `.env.docker`. Mailpit recibe los correos de simulación en `http://localhost:8025`; no entrega mensajes a Internet.

Las dependencias de cada aplicación se instalan dentro de su imagen desde el `package-lock.json` correspondiente. No es necesario subir `node_modules` al repositorio.

## VPS y dominios

El despliegue se administra como **un único proyecto Compose**, `socials-entradas`, con cuatro servicios: sistema central, dos webs y buzón de pruebas.

```bash
docker compose -f compose.yaml -f compose.hostinger.yaml up -d --build --wait
```

En el VPS debe usarse siempre el overlay `compose.hostinger.yaml`: vincula los puertos únicamente a loopback. El Compose base es para desarrollo local. La clave de origen `.web-proxy-key` debe poder leerla el usuario Node (UID 1000) de los contenedores; el procedimiento se documenta en la guía del VPS.

Para publicar por dominio, copiar `.env.domains.example` como `.env.domains`, completar los tres nombres reales, comprobar DNS y utilizar `compose.domains.yaml` con el Traefik existente. Ese overlay está preparado para el resolver `letsencrypt`; no instala ni sustituye el proxy del servidor. El dominio administrativo configura la URL de verificación de los QR.

No ejecutar comandos globales de limpieza Docker ni modificar redes, volúmenes o proxies de proyectos ajenos. Antes de habilitar ventas, configurar datos bancarios, fecha, condiciones y SMTP real. El estado de la revisión del VPS se explica en [AUDITORIA_VPS.md](AUDITORIA_VPS.md).

## Datos persistentes y credenciales

SQLite y los archivos de pago/PDF se almacenan en volúmenes propios del proyecto. No usar `docker compose down -v` sobre datos que deban conservarse. Mantener una sola instancia del sistema central con esta arquitectura SQLite.

El repositorio no incluye credenciales, claves privadas, bases de datos, capturas, PDFs de compradores, correos ni copias de seguridad. El archivo PEM incluido en `sistema-central/src/certs/` es un **certificado público intermedio de Sectigo**, necesario para validar la cadena HTTPS incompleta que entrega BCV; no contiene una clave privada.

## Comprobaciones

```bash
node --test tests/bcv-money.test.cjs
node verificar-cron.cjs
```

Con el entorno local de prueba iniciado:

```bash
npm run test:bcv
npm run test:integration
```

Las pruebas integrales crean órdenes, aprueban entradas, registran ingresos y envían notificaciones. Ejecutarlas solo contra el entorno de simulación, nunca contra ventas reales. `scripts/auditar-vps.py` genera un inventario Docker de solo lectura sin imprimir variables de entorno. `scripts/verificar-vps.py` comprueba una reserva y la libera al finalizar.

## Documentación

- [Entorno local](DOCKER_LOCAL.md)
- [Despliegue en Hostinger](VPS_HOSTINGER.md)
- [Revisión de aislamiento del VPS](AUDITORIA_VPS.md)
- [Alternativa de despliegue con PM2](DEPLOY_HOSTINGER_VPS.md)
