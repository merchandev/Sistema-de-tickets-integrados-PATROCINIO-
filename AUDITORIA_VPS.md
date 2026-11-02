# Revisión de aislamiento del proyecto de entradas

Fecha de revisión: **2 de noviembre de 2026**. Alcance: inspección de Docker y puertos en modo lectura. No se cambiaron servicios, puertos, DNS, firewall, redes, volúmenes ni configuración de los proyectos existentes.

Este documento contiene únicamente las conclusiones del proyecto de entradas. El inventario completo de otros proyectos se conserva fuera de Git.

## Estado observado

- `socials-entradas` está registrado como proyecto Compose independiente y sus cuatro servicios están `running` y `healthy`.
- Solo está conectado a la red `socials-entradas_default`. No comparte esa red con los contenedores de otros proyectos revisados.
- La base de datos, capturas/PDF y correo usan volúmenes con prefijo `socials-entradas_`. No se encontraron volúmenes compartidos con los demás proyectos.
- Los puertos publicados son `127.0.0.1:3001`, `127.0.0.1:3002`, `127.0.0.1:4000` y `127.0.0.1:8025`. No se encontraron puertos publicados coincidentes con los proyectos anteriores en la captura de estado.
- No hay rutas Traefik activas para las entradas. El archivo de dominios es una propuesta pendiente de asignación de DNS y activación; utiliza nombres de router/servicio con prefijo `socials-`.
- Los tres servicios Node ejecutan con el usuario `node`, sin modo privilegiado y sin acceso al socket de Docker. La clave compartida se monta en modo lectura.

Estos resultados describen el estado observado. La separación de redes y volúmenes no constituye una garantía absoluta frente a fallos del host o consumo excesivo de recursos.

## Pendientes antes de producción

1. **Límites de recursos:** los cuatro contenedores no tienen límites explícitos de CPU, memoria o procesos. Bajo carga pueden competir con las aplicaciones anteriores. Definir límites dentro de los archivos Compose de este proyecto antes de abrir ventas.
2. **Dominios y TLS:** confirmar los dominios, verificar DNS y activar solamente las rutas de este proyecto mediante el proxy existente. No instalar otro proxy ni ocupar nuevamente los puertos 80/443.
3. **Operación:** configurar SMTP real, datos bancarios, condiciones, copias consistentes de SQLite y restauración de los archivos de almacenamiento.
4. **Actualizaciones:** registrar versiones, probar cambios en un entorno separado y actualizar solo los servicios de `socials-entradas`.

Ninguno de estos ajustes se aplicó en el VPS durante esta revisión. La siguiente configuración debe limitarse a los contenedores y archivos de este proyecto.
