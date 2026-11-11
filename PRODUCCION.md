# Publicación de los dominios

- Iluminando Caminos: `https://iluminandocaminos.com`
- Hablemos de Marketing: `https://hablemosdemarketingmaturin.com`
- Administrador: `https://hablemosdemarketingmaturin.com/admin/`

Los dominios se sirven con el Traefik existente. En `hablemosdemarketingmaturin.com`, el dashboard, su API, los soportes/PDF y la verificación QR se dirigen al central mediante rutas con prioridad 100; el resto del dominio (portada, compra y blog) sigue en Web 2 con prioridad 10. Así se comparte el dominio sin crear un subdominio DNS adicional.

Hasta el 9 de noviembre de 2026 el dashboard estaba en `iluminandocaminos.com/admin/`. `DOMAIN_ADMIN_LEGACY` redirige las rutas `/admin`, `/api/admin`, `/storage` y `/verify` de ese dominio al nuevo, de modo que los QR de las entradas ya emitidas siguen funcionando. La portada y la compra de Iluminando Caminos no cambian.

## Estado de las compras

Las páginas se publican con **`SALES_ENABLED=false`**. Los visitantes pueden consultar el evento y las entradas, pero el servidor rechaza nuevas reservas y reportes de pago con `SALES_NOT_OPEN`. Las pantallas muestran el aviso de próxima apertura y el mapa no permite reservar. Es una decisión temporal hasta que se configuren cobros y SMTP reales.

Para abrir ventas más adelante: validar los datos bancarios, el contenido y fecha del evento, configurar y probar SMTP real, cambiar `SALES_ENABLED=true` en `.env.domains` del VPS y recrear el servicio central con la configuración completa. Las credenciales administrativas no se guardan en Git.

## Flujo de compra y verificación

1. Al elegir un número, la entrada queda reservada y se abre un popup con el monto en bolívares y la cuenta de Pago Móvil (Bancamiga 0172 · 0412-2905205 · C.I. 28298508), cada dato con botón para copiar.
2. En el mismo popup el comprador indica nombre, apellido, cédula, teléfono, correo, banco de origen y número de referencia; la captura es opcional. Al enviarlo recibe el correo «Estamos verificando tu pago» (hasta 24 horas).
3. Si la reserva expira o algo falla, el bloque «Reporte de pago» de `/comprar` registra el pago sin entrada asignada; al aprobarlo, el administrador elige una entrada libre.
4. En el dashboard, la campana muestra los pagos por verificar con aviso sonoro. El detalle del pedido muestra todos los datos del comprador y del pago para aprobar o rechazar. Al aprobar se envía un solo correo, «Muchas gracias por su apoyo, tu entrada está disponible», que confirma el pago y adjunta la entrada en PDF con el código QR; al rechazar, «Pago rechazado» con el motivo.
5. En «Control de acceso» el escáner emite un tono distinto para entradas válidas y no válidas (y vibra en teléfonos).

Los correos salen como «Sistema de envío Espressivo Venezuela <soporte@merchan.cloud>» (campo «Remitente»; la dirección debe ser la del buzón SMTP). La cuenta de correo se configura en «Correos y avisos»: SMTP para el envío e IMAP opcional para guardar una copia en Enviados (si IMAP no tiene usuario propio usa el de SMTP). «Probar conexión» comprueba ambos y puede enviar un correo de prueba. Las contraseñas guardadas no se devuelven al navegador.

El correo «Estamos verificando tu pago» sale en segundo plano, así que el comprador ve la confirmación sin esperar al servidor de correo. Cada mensaje lleva versión HTML y texto plano, Message-ID y Reply-To del dominio del remitente, y deja una línea `[Mail] TIPO -> ESTADO (@dominio)` en el registro del contenedor (`docker logs socials-entradas-sistema-central-1`). `SIMULATED_OUTBOX` significa que no hay servidor SMTP guardado y el correo no salió.

`npm run test:e2e` comprueba todo el circuito contra un servidor SMTP local real y una base de datos nueva: login, compra, reporte, aprobación con PDF, rechazo, fallo y reenvío de correos, QR e ingreso, y el remitente, asunto y contenido de los ocho correos. Junto con `npm run test:payments` y `npm run test:auth`, conviene ejecutarlo antes de cada despliegue.

`scripts/desplegar-compras.sh` publica juntos el sistema central y las dos webs desde `release-compras.tar.gz`, con copia previa de SQLite, almacenamiento y código.

## Acceso al panel

El panel es uno solo para las dos webs: `https://hablemosdemarketingmaturin.com/admin/`. Sin sesión, cualquier ruta del panel (incluidos los enlaces de los QR) lleva a `/admin/login` y, tras iniciar sesión, vuelve a donde iba. La sesión dura 12 horas, se guarda en SQLite y sobrevive a reinicios; ocho intentos fallidos desde la misma IP bloquean el acceso 15 minutos.

### Usuarios

El panel tiene un **superadministrador**, que no se puede eliminar ni perder su rol, y los **administradores** que se quieran.

- **Administradores:** gestionan pagos, control de acceso, blog y patrocinio, y cambian su propia contraseña («Cambiar contraseña» en el menú del avatar, pidiendo la actual). Ven «Evento y contenido» y «Correos y avisos» en solo lectura y la lista de usuarios sin acciones.
- **Superadministrador:** además crea, cambia la contraseña o elimina administradores, edita la configuración sensible (datos del evento, precio, Pago Móvil, cronograma, condiciones y cuenta de correo), prueba el correo y envía los avisos masivos.

El servidor aplica estas reglas (responde 403), no solo el panel. La cuenta de los scripts (`ADMIN_USER` por HTTP Basic) conserva el acceso completo. Las contraseñas se guardan con scrypt y cambiarlas cierra las demás sesiones de ese usuario.

Desde la consola del VPS (las contraseñas se escriben en un aviso oculto o llegan por la entrada estándar, nunca como argumento):

```bash
docker exec -it socials-entradas-sistema-central-1 node --no-warnings src/usuarios.js crear <correo> superadmin
docker exec -it socials-entradas-sistema-central-1 node --no-warnings src/usuarios.js contrasena <correo>
docker exec socials-entradas-sistema-central-1 node --no-warnings src/usuarios.js lista
docker exec socials-entradas-sistema-central-1 node --no-warnings src/usuarios.js eliminar <correo>
```

`contrasena` sirve también para recuperar el acceso del superadministrador si olvida su contraseña.

Mientras no exista ningún usuario se entra con la cuenta inicial: `ADMIN_USER` / `ADMIN_PASSWORD` de `.env.docker`, o la que se haya guardado desde el menú de la cuenta. Al crear el primer usuario, la cuenta inicial deja de funcionar en el login y sus sesiones se cierran. `ADMIN_USER` / `ADMIN_PASSWORD` siguen valiendo solo por HTTP Basic, para los scripts de verificación.

## Configuración del VPS

En `/docker/socials-entradas/.env.domains`:

```dotenv
DOMAIN_WEB1=iluminandocaminos.com
DOMAIN_WEB2=hablemosdemarketingmaturin.com
DOMAIN_ADMIN=hablemosdemarketingmaturin.com
DOMAIN_ADMIN_LEGACY=iluminandocaminos.com
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

## Patrocinio · «Juntos lo hacemos posible»

Sección «Patrocinio» del panel: una pestaña por página, con hasta 30 logos cada una (PNG, JPG o WebP de hasta 5 MB) y un enlace opcional por logo (web, Instagram, TikTok, WhatsApp o contacto) que se abre en otra pestaña. Con «Mezclar los patrocinantes» activado (por defecto), las dos webs muestran los logos de ambas pestañas intercalados; desactivado, cada web muestra solo los suyos. Una web sin logos no muestra la sección. El carrusel se mueve solo cuando los logos no caben, se detiene al pasar el cursor, con el teclado o al tocarlo, y adapta el tamaño de las tarjetas a cualquier pantalla. Las imágenes se guardan en el volumen de almacenamiento (`storage/patrocinadores`).

## Entrega de correos (antispam)

El dominio del remitente, `merchan.cloud`, tiene SPF (`include:_spf.mail.hostinger.com`), DKIM de Hostinger (`hostingermail-a/b/c._domainkey`) y DMARC (`p=none`); se comprobó el 9 de noviembre de 2026. Cada correo sale por el SMTP de Hostinger con versión HTML y texto, Message-ID y Reply-To del dominio, EHLO con el dominio y la cabecera `Auto-Submitted: auto-generated`. Los avisos masivos llevan además `List-Unsubscribe`. Para comprobar un envío: en Gmail, «Mostrar original» debe indicar PASS en SPF, DKIM y DMARC. Cuando los informes lo confirmen, se puede endurecer DMARC a `p=quarantine` en el DNS.

## Hoja de control en Google Sheets

Cada pago nuevo, aprobado o rechazado se copia en una hoja de Google para que el equipo lo revise por fuera de la web. La columna «Validación del equipo» es una lista desplegable (Por verificar, Verificado, Rechazado) y «Notas del equipo» es libre; el sistema nunca las sobrescribe, salvo cerrar en «Verificado» o «Rechazado» una validación que seguía «Por verificar» cuando la web decide. Cambiar el estado en la hoja **no** aprueba ni rechaza nada en la web.

Instalación (una vez, en la cuenta dueña de la hoja):

1. En la hoja: **Extensiones → Apps Script**. Borrar el contenido, pegar `integraciones/google-sheets/Codigo.gs` y guardar.
2. Recargar la hoja. Menú **Entradas → Configurar la hoja**, autorizar y copiar la clave de conexión.
3. En Apps Script: **Implementar → Nueva implementación → Aplicación web**, ejecutar como «Yo», acceso «Cualquier usuario». Copiar la URL `https://script.google.com/macros/s/…/exec`.
4. Panel → **Evento y contenido → Hoja de control en Google Sheets** (superadministrador): pegar URL y clave, guardar, «Probar conexión» y «Enviar todos los pagos a la hoja».

La clave solo se guarda en el servidor y no vuelve al navegador. Cada envío deja una línea `[Hoja] …` en el registro del contenedor; un fallo de la hoja nunca bloquea un pago. La hoja contiene datos personales: compartirla solo con las personas del equipo.
