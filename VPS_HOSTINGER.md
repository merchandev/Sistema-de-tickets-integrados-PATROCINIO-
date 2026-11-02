# Proyecto de entradas en Hostinger

La configuración pública y el estado de apertura de ventas se describen en [PRODUCCION.md](PRODUCCION.md). El administrador puede compartir el dominio de Web 1 mediante la ruta `/admin/`; las rutas del proxy tienen prioridades explícitas para evitar que sustituyan la portada.

Servidor: `<IP_DEL_VPS>`. Carpeta: `/docker/socials-entradas`.

El proyecto agrupa las dos webs y un único sistema central, conectado a una sola base SQLite persistente. Cada servidor web identifica su origen mediante el secreto compartido; ambas páginas consumen la misma API y Socket.IO. Los diseños permanecen independientes.

## Arranque privado

```bash
cd /docker/socials-entradas
docker compose -f compose.yaml -f compose.hostinger.yaml up -d --build --wait
```

Los puertos 3001, 3002, 4000 y 8025 se vinculan solamente a `127.0.0.1`. Para revisarlos desde el equipo mediante un túnel:

```bash
ssh -L 13001:127.0.0.1:3001 -L 13002:127.0.0.1:3002 -L 14000:127.0.0.1:4000 root@<IP_DEL_VPS>
```

Accesos con el túnel abierto: `http://localhost:13001`, `http://localhost:13002` y `http://localhost:14000/admin/`.

## Dominios y HTTPS

Los dominios definitivos y las rutas de administración están registrados en [PRODUCCION.md](PRODUCCION.md). `.env.domains` contiene `DOMAIN_WEB1`, `DOMAIN_WEB2` y `DOMAIN_ADMIN`; deben ser nombres de host, sin `https://` ni rutas. Los registros A deben apuntar al VPS y cualquier registro AAAA debe corresponder también a este servidor.

El overlay `compose.domains.yaml` integra este proyecto con el proveedor Docker de Traefik ya instalado en el VPS y con su resolver `letsencrypt`. Una vez comprobados los dominios y DNS:

```bash
docker compose --env-file .env.domains -f compose.yaml -f compose.hostinger.yaml -f compose.domains.yaml up -d --wait
```

El dominio administrativo fija la URL de los QR. La configuración de SMTP sigue apuntando al buzón de simulación Mailpit hasta que se configure el proveedor de entrega real en el dashboard. Revisar datos bancarios, fecha, contenido y condiciones antes de habilitar ventas.

## Credenciales y persistencia

Las credenciales del VPS se generan en `.env.docker` y el secreto de origen en `.web-proxy-key`, ambos con permisos 600 en el servidor. Son distintos de los del entorno local. No deben subirse a Git. Los volúmenes de base de datos y almacenamiento sobreviven al reinicio y a la recreación de contenedores; no utilizar `down -v`.

`scripts/verificar-vps.py` comprueba los tres servicios, administrador protegido, tasa y precio compartidos y una reserva concurrente; libera la reserva al finalizar y no crea órdenes de compra.
