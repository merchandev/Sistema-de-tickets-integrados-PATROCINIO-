# Cadena TLS de BCV

El 29-10-2026 `www.bcv.org.ve` entregaba solamente su certificado de servidor, emitido por **Sectigo Public Server Authentication CA DV R36**. Node rechazaba la cadena con `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

`sectigo-dv-r36.pem` procede de la dirección AIA del certificado: `http://crt.sectigo.com/SectigoPublicServerAuthenticationCADVR36.crt`. SHA-256 DER: `8C:54:C3:34:B6:6B:A4:E4:26:77:2A:F4:A3:F9:13:6C:19:A1:AE:C7:29:FD:B2:8C:53:5C:07:A5:A4:EF:22:E0`.

Se añade el intermedio al conjunto estándar de raíces de Node y se valida la firma hasta una raíz pública, vigencia y nombre del servidor. No se activa `allowPartialTrustChain` ni se deshabilita TLS. Si BCV cambia de emisor y vuelve a omitir el intermedio, habrá que incorporar el nuevo certificado desde su AIA y volver a validar la cadena.
