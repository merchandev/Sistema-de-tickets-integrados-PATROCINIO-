# Cadena TLS de BCV

El 29-10-2026 `www.bcv.org.ve` entregaba solamente su certificado de servidor, emitido por **Sectigo Public Server Authentication CA DV R36**. Node rechazaba la cadena con `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

`sectigo-dv-r36.pem` procede de la dirección AIA del certificado: `http://crt.sectigo.com/SectigoPublicServerAuthenticationCADVR36.crt`. SHA-256 DER: `8C:54:C3:34:B6:6B:A4:E4:26:77:2A:F4:A3:F9:13:6C:19:A1:AE:C7:29:FD:B2:8C:53:5C:07:A5:A4:EF:22:E0`.

Se añade el intermedio al conjunto estándar de raíces de Node y se valida la firma hasta una raíz pública, vigencia y nombre del servidor. No se activa `allowPartialTrustChain` ni se deshabilita TLS. Si BCV cambia de emisor y vuelve a omitir el intermedio, habrá que incorporar el nuevo certificado desde su AIA y volver a validar la cadena.

## Cambio del 13-11-2026

BCV renovó su certificado (`*.bcv.org.ve`, válido hasta el 30-05-2027) con otro emisor: **Sectigo Public Server Authentication CA OV R36**. Su servidor envía un intermedio que no corresponde (Sectigo RSA Domain Validation Secure Server CA), así que desde el 19-11-2026 Node volvió a rechazar la cadena y las reservas se bloquearon al pasar 24 horas sin tasa confirmada.

`sectigo-ov-r36.pem` procede de `http://crt.sectigo.com/SectigoPublicServerAuthenticationCAOVR36.crt`. SHA-256 DER: `65:42:D1:76:BE:D5:0F:19:3C:0C:E2:97:AE:44:EC:D8:A0:A8:6B:EC:2E:DE:68:27:69:34:40:59:B4:E7:85:30`.

Para que no se repita, `bcvScraper.js` carga todos los `.pem` de esta carpeta y, si la cadena vuelve a fallar por un emisor desconocido, lee la dirección AIA del certificado de BCV, descarga ese intermedio, comprueba que es una CA que firmó el certificado y reintenta. El intermedio solo sirve para construir la cadena: la conexión se sigue validando hasta una raíz pública. El registro muestra `[BCV] Intermedio incorporado desde AIA` con su huella; conviene guardarlo aquí después.

Además, las ventas solo se bloquean si la tasa tiene más de 24 horas **y** su fecha valor ya pasó, porque BCV publica por adelantado la tasa del siguiente día hábil.
