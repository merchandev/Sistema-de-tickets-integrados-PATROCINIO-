# Entorno Docker verificado

El entorno local ejecuta los tres proyectos en contenedores Linux independientes y una instancia adicional de Mailpit para recibir los correos de prueba por SMTP. La base SQLite pertenece exclusivamente al sistema central; ambas webs utilizan su API y Socket.IO por la red interna de Compose.

## Accesos

| Servicio | URL |
| --- | --- |
| Dashboard protegido | http://localhost:4000/admin/ |
| Página web 1 | http://localhost:3001 |
| Página web 2 | http://localhost:3002 |
| Buzón SMTP de pruebas | http://localhost:8025 |

Usuario del dashboard: `admin`. La contraseña aleatoria está en `.env.docker`, variable `ADMIN_PASSWORD`. El navegador pide las credenciales al abrir el dashboard. No incluyas la contraseña en la URL. El archivo está excluido de Git y de las imágenes Docker.

## Arranque y mantenimiento

Desde la carpeta raíz:

```powershell
npm ci
npm run setup
docker compose up -d --build --wait
docker compose ps
docker compose logs --tail 100 sistema-central
```

`npm run setup` crea las credenciales solamente si todavía no existe `.env.docker`. Para detener los servicios conservando los datos:

```powershell
docker compose down
```

Los volúmenes `central-data`, `central-storage` y `mail-data` conservan base de datos, capturas/PDFs y mensajes. `docker compose down -v` elimina esos datos: no utilizarlo para detener el entorno normal. Los datos anteriores de las carpetas `sistema-central/data` y `sistema-central/storage` no se importan ni modifican.

## Pruebas reproducibles

```powershell
npm run test:integration
node verificar-cron.cjs
```

La prueba integral dura al menos tres minutos porque espera el vencimiento real de una reserva. Utiliza entradas libres, crea dos compras de prueba aprobadas, registra sus ingresos en ambas etapas y deja otra solicitud pendiente para revisión manual. Cada ejecución agrega datos de prueba. También envía las cuatro campañas a las compras aprobadas existentes: ejecutarla solamente en este entorno de simulación con Mailpit, nunca contra compradores reales.

Los resultados se guardan en `output/verificacion/resultados.json` y los PDFs en esa misma carpeta. Para comprobar nuevamente los QR desde los PDFs renderizados y la persistencia después de recrear contenedores, usar `verificar-regresiones.cjs` una vez generados los PNG correspondientes. Este último script requiere los PNG producidos durante la revisión visual.

## Qué se comprobó

- 250 entradas; precio base de USD 5; reserva de 180 segundos.
- 100 solicitudes concurrentes desde las dos webs por una entrada: una aceptada y 99 conflictos.
- WebSocket real a través de ambos servidores web; actualizaciones sincronizadas.
- Reserva exclusiva, rechazo de pagos sin reserva y liberación después de 180 segundos reales.
- Formularios, aprobación/rechazo, generación PDF y QR, autenticidad y rechazo de doble ingreso por cada etapa.
- SMTP contra Mailpit, correos con PDF adjunto y las cuatro campañas manuales.
- Selección automática de campañas en siete escenarios de fecha/hora de Caracas, incluido el inicio a las 16:00.
- Persistencia de órdenes, PDFs y tokens al recrear contenedores.
- Dashboard, capturas y PDFs protegidos; sesiones ajenas y datos de órdenes fuera de los eventos públicos.

## Tasa BCV y correo

Desde el 29 de octubre de 2026 la consulta utiliza exclusivamente `https://www.bcv.org.ve/`. Se incorporó el certificado intermedio Sectigo que el BCV omite al servir su cadena, manteniendo validación TLS completa. No hay consulta secundaria a DolarAPI. Se conserva la precisión publicada (hasta ocho decimales) y se redondea únicamente el total en bolívares a dos decimales con aritmética decimal.

La pantalla muestra origen oficial, fecha valor, fecha de consulta y estado. Si la consulta falla, se conserva únicamente la última tasa oficial confirmada y se identifica como caché; no se actualiza falsamente su fecha de consulta. Sin una tasa oficial confirmada dentro de las últimas 24 horas, se bloquean reservas nuevas en modo automático. En modo manual se identifica expresamente esa configuración. Al reservar se reutiliza la consulta oficial por un máximo de cinco minutos; el refresco de fondo corre cada quince minutos y el botón BCV del administrador fuerza una nueva consulta.

Se verificó directamente una tasa de `888,89090000` Bs./USD con fecha valor `2026-10-29`: una entrada de USD 5 equivale a Bs. `4444,45`. Las compras anteriores conservan sus importes históricos. Para repetir pruebas específicas: `npm run test:bcv`. Las solicitudes de prueba se rechazan al terminar para liberar sus entradas; no se crean ventas aprobadas adicionales.

El dashboard incluye resúmenes separados de ventas y pagos pendientes por página, montos recaudados y un filtro de origen. Cada web adjunta su identidad desde el servidor con una clave compartida de Docker; el cliente no puede cambiar la etiqueta de origen enviando otro `source_web`. La orden conserva el origen de su reserva. `npm run setup` genera `.web-proxy-key` si no existe; el archivo se monta como secreto en los tres servicios, está excluido de Git y debe conservarse al transferir el entorno. Solicitudes directas de reserva o pago al puerto central se rechazan cuando este secreto está configurado.

El precio y la tasa se fijan al reservar y se conservan durante esa reserva, incluida una recarga de página. Cambiar la configuración afecta a las reservas nuevas.

Mailpit recibe los mensajes localmente y no los entrega a Gmail u otros destinatarios de Internet. Para entrega externa hay que configurar un proveedor SMTP real en el dashboard y probarlo con un correo propio. SMTP es envío de correo: este sistema no implementa un buzón de entrada IMAP/POP3. Las notificaciones automáticas se evalúan cada minuto con zona `America/Caracas` mientras el servicio esté encendido.

## Paso al VPS

Este Compose es una simulación local, con datos y cuentas de prueba. Antes de habilitar ventas se deben cargar los datos bancarios reales, fecha y condiciones definitivas, credenciales SMTP y URL pública del administrador (`PUBLIC_BASE_URL`, usada en los QR). Utilizar HTTPS delante de los tres servicios, necesario también para cámara en dominios públicos. Mailpit se conserva solamente para desarrollo.

Mantener **una sola instancia del sistema central** con SQLite en disco persistente. Las webs sí son procesos independientes. No replicar el contenedor central con bases separadas. Para acceso con dominios/IPs diferentes, cada web ya reenvía `/api/public` y `/socket.io` al central; el navegador utiliza el mismo origen de su web y no necesita conocer el nombre interno de Docker.

La autenticación HTTP Basic debe viajar bajo HTTPS en el VPS. Configurar el proxy inverso para `Upgrade`/`Connection` de WebSocket y subidas de 10 MB; limitar la exposición directa de los puertos y establecer copias de seguridad consistentes de SQLite y `central-storage`. No montar el mismo SQLite en varias máquinas.

Si se usa PM2 en vez de Docker, agregar `ADMIN_USER` y `ADMIN_PASSWORD` al entorno del sistema central: el servidor se niega a iniciar sin contraseña administrativa.
