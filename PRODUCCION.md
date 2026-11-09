# Publicación de los dominios

- Iluminando Caminos: `https://iluminandocaminos.com`
- Hablemos de Marketing: `https://hablemosdemarketingmaturin.com`
- Administrador: `https://iluminandocaminos.com/admin/`

Los dominios se sirven con el Traefik existente. El dashboard, su API, los soportes/PDF y la verificación QR se dirigen al central mediante rutas con prioridad 100; la portada y compra de Iluminando Caminos se dirigen a Web 1 con prioridad 10. Esto permite compartir el primer dominio sin crear un subdominio DNS adicional.

## Estado de las compras

Las páginas se publican con **`SALES_ENABLED=false`**. Los visitantes pueden consultar el evento y las entradas, pero el servidor rechaza nuevas reservas y reportes de pago con `SALES_NOT_OPEN`. Las pantallas muestran el aviso de próxima apertura y el mapa no permite reservar. Es una decisión temporal hasta que se configuren cobros y SMTP reales.

Para abrir ventas más adelante: validar los datos bancarios, el contenido y fecha del evento, configurar y probar SMTP real, cambiar `SALES_ENABLED=true` en `.env.domains` del VPS y recrear el servicio central con la configuración completa. Las credenciales administrativas no se guardan en Git.

## Flujo de compra y verificación

1. Al elegir un número, la entrada queda reservada y se abre un popup con el monto en bolívares y la cuenta de Pago Móvil (Bancamiga 0172 · 0412-2905205 · C.I. 28298508), cada dato con botón para copiar.
2. En el mismo popup el comprador indica nombre, apellido, cédula, teléfono, correo, banco de origen y número de referencia; la captura es opcional. Al enviarlo recibe el correo «Pago en verificación» (hasta 24 horas).
3. Si la reserva expira o algo falla, el bloque «Reporte de pago» de `/comprar` registra el pago sin entrada asignada; al aprobarlo, el administrador elige una entrada libre.
4. En el dashboard, la campana muestra los pagos por verificar con aviso sonoro. El detalle del pedido muestra todos los datos del comprador y del pago para aprobar o rechazar. Al aprobar se envían dos correos: «Pago aceptado» y la entrada en PDF con el código QR; al rechazar, el motivo.
5. En «Control de acceso» el escáner emite un tono distinto para entradas válidas y no válidas (y vibra en teléfonos).

La cuenta de correo se configura en «Correos y avisos»: SMTP para el envío e IMAP opcional para guardar una copia en Enviados (si IMAP no tiene usuario propio usa el de SMTP). «Probar conexión» comprueba ambos y puede enviar un correo de prueba. Las contraseñas guardadas no se devuelven al navegador.

El correo de «Pago en verificación» sale en segundo plano, así que el comprador ve la confirmación sin esperar al servidor de correo. Cada mensaje lleva versión HTML y texto plano, Message-ID y Reply-To del dominio del remitente, y deja una línea `[Mail] TIPO -> ESTADO (@dominio)` en el registro del contenedor (`docker logs socials-entradas-sistema-central-1`). `SIMULATED_OUTBOX` significa que no hay servidor SMTP guardado y el correo no salió.

`scripts/desplegar-compras.sh` publica juntos el sistema central y las dos webs desde `release-compras.tar.gz`, con copia previa de SQLite, almacenamiento y código.

## Acceso al panel

El panel es uno solo para las dos webs: `https://iluminandocaminos.com/admin/`. Sin sesión, cualquier ruta del panel (incluidos los enlaces de los QR) lleva a `/admin/login` y, tras iniciar sesión, vuelve a donde iba. La sesión dura 12 horas, se guarda en SQLite y sobrevive a reinicios; ocho intentos fallidos desde la misma IP bloquean el acceso 15 minutos.

La primera vez se entra con `ADMIN_USER` / `ADMIN_PASSWORD` de `.env.docker`. Desde el menú de la cuenta (avatar arriba a la derecha) se cambian usuario y contraseña: la contraseña se guarda con scrypt, la cuenta guardada reemplaza a la de `.env.docker` y se cierran las demás sesiones. Los scripts de verificación pueden seguir usando credenciales HTTP Basic.

## Configuración del VPS

En `/docker/socials-entradas/.env.domains`:

```dotenv
DOMAIN_WEB1=iluminandocaminos.com
DOMAIN_WEB2=hablemosdemarketingmaturin.com
DOMAIN_ADMIN=iluminandocaminos.com
SALES_ENABLED=false
```

```bash
docker compose --env-file .env.domains -f compose.yaml -f compose.hostinger.yaml -f compose.domains.yaml up -d --build --wait
```

Usar siempre los tres archivos al administrar el despliegue público. Mantienen puertos de diagnóstico en loopback y rutas HTTPS solamente para este proyecto. No ejecutar el Compose base solo en el VPS.

## Recursos y registros

| Servicio | CPU máxima | RAM máxima | Procesos |
| --- | --- | --- | --- |
| Sistema central | 1 CPU | 512 MiB | 192 |
| Web 1 | 0,25 CPU | 128 MiB | 128 |
| Web 2 | 0,25 CPU | 128 MiB | 128 |
| Mailpit privado | 0,25 CPU | 128 MiB | 64 |

Los logs de cada servicio rotan a 10 MB con tres archivos como máximo. Los demás proyectos y la configuración global de Traefik permanecen fuera del alcance de este despliegue.

`scripts/desplegar-vps-produccion.sh` guarda antes una copia consistente de SQLite, los archivos de almacenamiento, la configuración y el código del proyecto bajo `backups/` con acceso restringido. No elimina volúmenes ni reinicia otros proyectos.

## Verificación del despliegue · 2 de noviembre de 2026

Se comprobaron respuestas HTTPS 200 para ambas portadas, redirecciones HTTP a HTTPS, WebSocket seguro desde los dos dominios, las 250 entradas compartidas y acceso autenticado al dashboard. Sin credenciales, administrador, API administrativa y archivos de entradas devuelven 401. Las rutas de reserva y reporte de pago devuelven 503 con `SALES_NOT_OPEN` mientras las ventas están cerradas.

Los cuatro contenedores están saludables y aplican los límites de la tabla. La comparación con el estado anterior al despliegue confirmó que los otros 21 contenedores conservaron identificadores, fechas de arranque y puertos.

## Revisión visual de las dos webs

Se integró y revisó la nueva composición editorial de ambas páginas: vino y crema para Iluminando Caminos y hero morado con acentos lima y rosa para Marketing. Se retiraron la apertura con porcentaje ficticio, el movimiento de botones con el cursor y el reproductor simulado. El espacio del video indica que el material está pendiente y permite incorporar `/media/promo.mp4` cuando esté disponible.

Se verificaron portadas y compra a 320, 768 y 1440 píxeles sin desbordamientos en el contenido, menú móvil, búsqueda por número, filtro por rango y las 250 entradas. Las ventas permanecen cerradas. El script `scripts/desplegar-webs.sh` publica únicamente los dos frontends y conserva una copia de sus archivos previos; comprueba que los demás contenedores conserven arranque y puertos.

## Dashboard administrativo

El dashboard utiliza navegación lateral en escritorio y navegación horizontal persistente en móvil. Identifica Iluminando Caminos por su nombre, dominio y color vino, y Hablemos de Marketing por su nombre, dominio y color morado. Cada proyecto muestra entradas aprobadas, pagos pendientes y recaudación; los botones de cada resumen filtran sus operaciones. El listado permite combinar página, estado y búsqueda por nombre, correo, número de entrada o referencia. En móvil, cada operación se presenta como una tarjeta con etiquetas. El origen también aparece en el detalle de la entrada y el resultado del verificador QR.

Los estilos de utilidades se compilan localmente, sin Tailwind en CDN. Después de modificar clases en el HTML o JS del dashboard, ejecutar `npm ci` y `npm run build:admin` desde la raíz y versionar `sistema-central/public/admin/utilities.css` junto con los cambios.

La validación de interfaz cubre las cinco secciones a 320, 768 y 1440 píxeles, filtros combinados con operaciones de prueba de ambas webs, búsqueda, apertura/cierre del detalle y verificación de un QR de prueba. No se registra ningún ingreso ni se aprueban pagos durante estas comprobaciones.

`scripts/desplegar-dashboard.sh` respalda los archivos del dashboard y una copia consistente de SQLite, y recrea únicamente el servicio central. Comprueba que los otros contenedores conserven sus identificadores, arranque y puertos. La publicación conserva `SALES_ENABLED=false` y los volúmenes existentes.
