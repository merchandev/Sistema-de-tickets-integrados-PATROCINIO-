# Guía de Despliegue en VPS de Hostinger (Sistema Central + Página Web 1 + Página Web 2)

> Actualización del 29 de octubre de 2026: el entorno Docker local y sus pruebas están documentados en [DOCKER_LOCAL.md](./DOCKER_LOCAL.md). El sistema central exige `ADMIN_PASSWORD` y admite `ADMIN_USER` (por defecto `admin`). Para PM2 hay que agregar esas variables al entorno antes de iniciar. La consulta BCV ahora es exclusivamente directa por HTTPS con cadena TLS validada; una consulta fallida conserva la última tasa oficial identificada como caché. Docker utiliza `.web-proxy-key` para identificar la web de origen; al transferir el entorno conservar ese archivo junto con `.env.docker`. SMTP externo requiere credenciales reales; la simulación Docker entrega a Mailpit. Este documento anterior describe la alternativa PM2.

Esta arquitectura consta de **tres proyectos independientes** sincronizados a una única base de datos transaccional (`SQLite WAL`) y motor en tiempo real (`Socket.IO`):

1. **`sistema-central`** (Puerto `4000`): API Central, Motor de Bloqueo Atómico (3 minutos), Scraper del BCV en tiempo real, Generador de Entradas PDF con Código QR criptográfico, Servidor SMTP y Dashboard de Administración (`/admin`).
2. **`pagina-web-1`** (Puerto `3001`): Primer portal web independiente de venta de entradas.
3. **`pagina-web-2`** (Puerto `3002`): Segundo portal web independiente de venta de entradas.

---

## 1. Requisitos en el VPS de Hostinger (Ubuntu 22.04 / 24.04)

```bash
# Instalar Node.js 24.x, Nginx y PM2
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
sudo npm install -g pm2
```

## 2. Instalación y Puesta en Marcha con PM2

Dentro de la carpeta del proyecto en el VPS:

```bash
cd sistema-central && npm install && cd ..
cd pagina-web-1 && npm install && cd ..
cd pagina-web-2 && npm install && cd ..

# Iniciar los 3 servicios en segundo plano con PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## 3. Configuración para 2 IPs Diferentes o 2 Dominios en Nginx

Edita las variables en `pagina-web-1/.env` y `pagina-web-2/.env` apuntando a la IP o dominio público del `sistema-central`:

```env
CENTRAL_API_URL=http://IP_O_DOMINIO_SISTEMA_CENTRAL:4000
```

Ejemplo de bloques en `/etc/nginx/sites-available/entradas`:

```nginx
# 1. Sistema Central & Dashboard Administrativo
server {
    listen 80;
    server_name admin.tudominio.com; # O IP principal

    client_max_body_size 15M;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

# 2. Página Web 1 (IP 1 o Dominio 1)
server {
    listen 80;
    server_name pagina1.com; # O IP_1:80

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

# 3. Página Web 2 (IP 2 o Dominio 2)
server {
    listen 80;
    server_name pagina2.com; # O IP_2:80

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
