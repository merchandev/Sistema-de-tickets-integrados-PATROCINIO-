/**
 * Hoja de control de pagos · Entradas de Iluminando Caminos y Hablemos de Marketing.
 *
 * El sistema de entradas envía aquí cada pago (nuevo, aprobado o rechazado) y este script crea o
 * actualiza su fila. La columna «Validación del equipo» es una lista desplegable para revisar los pagos
 * por fuera de la web; cambiarla NO aprueba ni rechaza nada en la web: eso se hace en el panel.
 *
 * Instalación (una sola vez):
 *   1. En la hoja: Extensiones → Apps Script. Borra lo que haya, pega este archivo y guarda.
 *   2. Vuelve a la hoja y recárgala. En el menú «Entradas» elige «Configurar la hoja» y autoriza.
 *      Copia la clave de conexión que aparece.
 *   3. En Apps Script: Implementar → Nueva implementación → Aplicación web.
 *      Ejecutar como: «Yo». Quién tiene acceso: «Cualquier usuario». Implementar y copia la URL.
 *   4. En el panel (Evento y contenido → Hoja de control) pega la URL y la clave, guarda y prueba.
 */

const NOMBRE_HOJA = 'Pagos';
const ENCABEZADOS = [
  'ID', 'Fecha', 'Página', 'Entrada', 'Nombre', 'Cédula', 'Teléfono', 'Correo', 'Banco', 'Referencia',
  'Monto (Bs.)', 'Monto (USD)', 'Tasa BCV', 'Comprobante', 'Comentario del comprador',
  'Estado en la web', 'Validación del equipo', 'Notas del equipo'
];
// Columnas (1 = A) que escribe el sistema; las dos últimas son del equipo y nunca se sobrescriben
const COL_COMPROBANTE = 14;
const COL_ESTADO_WEB = 16;
const COL_VALIDACION = 17;
const COLUMNAS_SISTEMA = 16;
const TEXTO_COLUMNAS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16];
const VALIDACIONES = ['Por verificar', 'Verificado', 'Rechazado'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Entradas')
    .addItem('Configurar la hoja', 'configurar')
    .addItem('Ver la clave de conexión', 'verClave')
    .addToUi();
}

function hoja_() {
  const libro = SpreadsheetApp.getActiveSpreadsheet();
  return libro.getSheetByName(NOMBRE_HOJA) || libro.insertSheet(NOMBRE_HOJA);
}

function reglaValidacion_() {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(VALIDACIONES, true)
    .setAllowInvalid(false)
    .setHelpText('Elige: Por verificar, Verificado o Rechazado.')
    .build();
}

function clave_() {
  const propiedades = PropertiesService.getScriptProperties();
  let clave = propiedades.getProperty('CLAVE');
  if (!clave) {
    clave = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
    propiedades.setProperty('CLAVE', clave);
  }
  return clave;
}

/** Prepara encabezados, formatos, la lista desplegable y los colores. Se puede repetir sin perder datos. */
function configurar() {
  const hoja = hoja_();
  hoja.getRange(1, 1, 1, ENCABEZADOS.length).setValues([ENCABEZADOS])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#2b1140')
    .setVerticalAlignment('middle').setWrap(true);
  hoja.setFrozenRows(1);
  hoja.setFrozenColumns(1);
  hoja.setRowHeight(1, 36);
  const anchos = [56, 140, 150, 130, 180, 110, 120, 210, 150, 120, 110, 100, 90, 120, 240, 130, 160, 220];
  anchos.forEach((ancho, i) => hoja.setColumnWidth(i + 1, ancho));

  const filas = Math.max(hoja.getMaxRows() - 1, 1);
  TEXTO_COLUMNAS.forEach(col => hoja.getRange(2, col, filas, 1).setNumberFormat('@'));
  hoja.getRange(2, 11, filas, 1).setNumberFormat('#,##0.00');
  hoja.getRange(2, 12, filas, 1).setNumberFormat('$#,##0.00');
  hoja.getRange(2, 13, filas, 1).setNumberFormat('#,##0.0000');
  hoja.getRange(2, COL_VALIDACION, filas, 1).setDataValidation(reglaValidacion_());

  const colores = [
    [COL_VALIDACION, 'Por verificar', '#fff4d6', '#7a5200'],
    [COL_VALIDACION, 'Verificado', '#dcf5e6', '#11683b'],
    [COL_VALIDACION, 'Rechazado', '#fde2e1', '#9b1c1c'],
    [COL_ESTADO_WEB, 'En verificación', '#eef2ff', '#3730a3'],
    [COL_ESTADO_WEB, 'Aprobado', '#dcf5e6', '#11683b'],
    [COL_ESTADO_WEB, 'Rechazado', '#fde2e1', '#9b1c1c']
  ];
  const reglas = colores.map(([col, texto, fondo, letra]) => SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(texto).setBackground(fondo).setFontColor(letra).setBold(true)
    .setRanges([hoja.getRange(2, col, filas, 1)]).build());
  hoja.setConditionalFormatRules(reglas);

  SpreadsheetApp.getUi().alert(
    'Hoja lista',
    'Clave de conexión (cópiala en el panel de entradas):\n\n' + clave_() +
    '\n\nAhora implementa el script como aplicación web: Implementar → Nueva implementación → Aplicación web, ' +
    'ejecutar como «Yo» y acceso «Cualquier usuario».',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function verClave() {
  SpreadsheetApp.getUi().alert('Clave de conexión', clave_(), SpreadsheetApp.getUi().ButtonSet.OK);
}

function respuesta_(datos) {
  return ContentService.createTextOutput(JSON.stringify(datos)).setMimeType(ContentService.MimeType.JSON);
}

/** Lo llama el sistema de entradas. Cuerpo JSON: { clave, accion: 'prueba' | 'pedidos', pedidos: [...] } */
function doPost(e) {
  let cuerpo;
  try {
    cuerpo = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return respuesta_({ ok: false, error: 'JSON no válido' });
  }
  const guardada = PropertiesService.getScriptProperties().getProperty('CLAVE');
  if (!guardada || cuerpo.clave !== guardada) return respuesta_({ ok: false, error: 'Clave de conexión incorrecta' });

  const hoja = hoja_();
  if (cuerpo.accion === 'prueba') {
    return respuesta_({ ok: true, hoja: SpreadsheetApp.getActiveSpreadsheet().getName(), filas: Math.max(hoja.getLastRow() - 1, 0) });
  }
  if (cuerpo.accion !== 'pedidos' || !Array.isArray(cuerpo.pedidos)) return respuesta_({ ok: false, error: 'Acción desconocida' });

  const cerrojo = LockService.getScriptLock();
  cerrojo.waitLock(25000);
  try {
    if (hoja.getLastRow() === 0) hoja.getRange(1, 1, 1, ENCABEZADOS.length).setValues([ENCABEZADOS]).setFontWeight('bold');
    const ultima = hoja.getLastRow();
    const filaPorId = {};
    if (ultima > 1) {
      hoja.getRange(2, 1, ultima - 1, 1).getValues().forEach((fila, i) => { filaPorId[String(fila[0])] = i + 2; });
    }
    let nuevas = 0;
    let actualizadas = 0;
    cuerpo.pedidos.forEach(p => {
      const id = String(p.id || '').trim();
      if (!id) return;
      const valores = [[
        id, p.fecha || '', p.pagina || '', p.entrada || '', p.nombre || '', p.cedula || '', p.telefono || '',
        p.correo || '', p.banco || '', p.referencia || '', Number(p.montoBs) || 0, Number(p.montoUsd) || 0,
        Number(p.tasa) || 0, '', p.comentario || '', p.estadoWeb || ''
      ]];
      let fila = filaPorId[id];
      const existia = Boolean(fila);
      if (!fila) {
        fila = hoja.getLastRow() + 1;
        filaPorId[id] = fila;
        nuevas++;
      } else {
        actualizadas++;
      }
      TEXTO_COLUMNAS.forEach(col => hoja.getRange(fila, col).setNumberFormat('@'));
      hoja.getRange(fila, 1, 1, COLUMNAS_SISTEMA).setValues(valores);
      if (p.comprobante) {
        hoja.getRange(fila, COL_COMPROBANTE).setRichTextValue(
          SpreadsheetApp.newRichTextValue().setText('Ver captura').setLinkUrl(p.comprobante).build()
        );
      }
      const celda = hoja.getRange(fila, COL_VALIDACION);
      celda.setDataValidation(reglaValidacion_());
      const actual = String(celda.getValue() || '');
      if (!existia || !actual) celda.setValue('Por verificar');
      // Lo que decide la web cierra la validación pendiente; una decisión del equipo no se toca
      if ((!actual || actual === 'Por verificar') && p.estadoWeb === 'Aprobado') celda.setValue('Verificado');
      if ((!actual || actual === 'Por verificar') && p.estadoWeb === 'Rechazado') celda.setValue('Rechazado');
    });
    return respuesta_({ ok: true, nuevas: nuevas, actualizadas: actualizadas });
  } finally {
    cerrojo.releaseLock();
  }
}
