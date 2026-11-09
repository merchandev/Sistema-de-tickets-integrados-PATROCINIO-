# Blog de Hablemos de Marketing

En el administrador compartido (`https://hablemosdemarketingmaturin.com/admin/`), abrir **Blog · Marketing**. La web pública está en `https://hablemosdemarketingmaturin.com/blog`.

## Publicar un artículo

1. Pulsar **Nueva publicación** y escribir el título, extracto y contenido.
2. Añadir formato con los botones de subtítulo, negrita, lista, enlace o cita. El contenido usa Markdown; la vista previa permite revisar el resultado antes de guardar.
3. Completar autor, categoría y etiquetas separadas por comas. Opcionalmente, subir una imagen PNG, JPG o WebP de hasta 5 MB y añadir su texto alternativo, o utilizar una URL HTTPS.
4. **Guardar borrador** conserva el artículo exclusivamente en el administrador. **Publicar** lo muestra inmediatamente en el blog. El enlace se genera a partir del título y también se puede editar; debe ser único.
5. Una publicación existente permite actualizar su contenido, cambiarla a borrador o moverla a la papelera. La papelera conserva los datos y permite restaurarlos como borrador.

La búsqueda, los estados y la paginación permiten localizar publicaciones. Si otra ventana guardó cambios, el editor rechaza la sobrescritura y pide abrir la versión actual. Antes de abandonar cambios sin guardar, el navegador avisa.

## Almacenamiento y despliegue

El blog utiliza una tabla independiente `marketing_blog_posts` en la SQLite existente y no modifica las tablas de entradas o pagos. Las imágenes se conservan en el volumen de almacenamiento bajo `storage/blog`. Las páginas públicas se renderizan en el servidor de Marketing, con título, descripción, URL canónica y vista del artículo. Iluminando Caminos no incorpora una sección de blog.

Las rutas administrativas `/api/admin/blog` utilizan la autenticación existente. La API pública solo devuelve publicaciones en estado `published`; borradores y papelera devuelven 404. El texto HTML se trata como texto y el renderizador rechaza enlaces ejecutables. No se admiten imágenes SVG o archivos que no tengan una firma PNG, JPG o WebP.

Para validar: `npm run test:blog`. La compilación del dashboard se mantiene con `npm run build:admin`. El script `scripts/desplegar-blog.sh` guarda copia consistente de SQLite, almacenamiento y código antes de recrear únicamente el sistema central y Marketing. Conserva los volúmenes, dominios y configuración de ventas del VPS. La producción se entrega sin artículos de demostración.
