# Publicación de los dominios

- Iluminando Caminos: `https://iluminandocaminos.com`
- Hablemos de Marketing: `https://hablemosdemarketingmaturin.com`
- Administrador: `https://iluminandocaminos.com/admin/`

Los dominios se sirven con el Traefik existente. El dashboard, su API, los soportes/PDF y la verificación QR se dirigen al central mediante rutas con prioridad 100; la portada y compra de Iluminando Caminos se dirigen a Web 1 con prioridad 10. Esto permite compartir el primer dominio sin crear un subdominio DNS adicional.

## Estado de las compras

Las páginas se publican con **`SALES_ENABLED=false`**. Los visitantes pueden consultar el evento y las entradas, pero el servidor rechaza nuevas reservas y reportes de pago con `SALES_NOT_OPEN`. Las pantallas muestran el aviso de próxima apertura y el mapa no permite reservar. Es una decisión temporal hasta que se configuren cobros y SMTP reales.

Para abrir ventas más adelante: validar los datos bancarios, el contenido y fecha del evento, configurar y probar SMTP real, cambiar `SALES_ENABLED=true` en `.env.domains` del VPS y recrear el servicio central con la configuración completa. Las credenciales administrativas no se guardan en Git.

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
