/**
 * Hoja de control de pagos · Entradas de Iluminando Caminos y Hablemos de Marketing.
 *
 * El sistema de entradas envía aquí cada pago (nuevo, aprobado o rechazado) y este script crea o
 * actualiza su fila. La columna «Validación del equipo» es una lista desplegable para revisar los pagos
 * por fuera de la web; cambiarla NO aprueba ni rechaza nada en la web: eso se hace en el panel.
 *
 * Instalación (una sola vez), de una de estas dos formas:
 *   A. En la hoja: Extensiones → Apps Script. Pega este archivo y guarda. Recarga la hoja, en el menú
 *      «Entradas» elige «Configurar la hoja», autoriza y copia la clave de conexión que aparece.
 *   B. Si ese menú da error (pasa con varias cuentas de Google abiertas): crea un proyecto en
 *      script.google.com, pega este archivo, elige la función «configurar» y pulsa Ejecutar. Autoriza
 *      y copia la clave del registro de ejecución (función «verClave»). El script abre la hoja por su ID.
 *   Después, en Apps Script: Implementar → Nueva implementación → Aplicación web.
 *      Ejecutar como: «Yo». Quién tiene acceso: «Cualquier usuario». Implementar y copia la URL.
 *   Por último, en el panel (Evento y contenido → Hoja de control) pega la URL y la clave, guarda y prueba.
 *   Al cambiar este archivo: guarda, ejecuta «configurar» y en Implementar → Administrar implementaciones
 *   edita la implementación y elige «Nueva versión» (la URL no cambia).
 */

const NOMBRE_HOJA = 'Pagos';
// Hoja que recibe los pagos; se usa cuando el script no está dentro de la propia hoja
const ID_HOJA = '1-QwaXmGvrgs3RopcTrPnPhtp62gFX9J21NVxKSQLy6I';
// Columnas visibles, en este orden; la última («ID») queda oculta y sirve para encontrar la fila de cada pago
const ENCABEZADOS = ['Referencia', 'Monto (Bs.)', 'Banco', 'Nombre', 'Cédula', 'Entrada', 'Fecha de pago', 'Validación del equipo', 'ID'];
const COL_MONTO = 2;
const COL_VALIDACION = 8;
const COL_ID = 9;
const TEXTO_COLUMNAS = [1, 3, 4, 5, 6, 7, 9];
const VALIDACIONES = ['Por verificar', 'Verificado', 'Rechazado'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Entradas')
    .addItem('Configurar la hoja', 'configurar')
    .addItem('Ver la clave de conexión', 'verClave')
    .addToUi();
}

function libro_() {
  return SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(ID_HOJA);
}

function hoja_() {
  const libro = libro_();
  return libro.getSheetByName(NOMBRE_HOJA) || libro.insertSheet(NOMBRE_HOJA);
}

// Muestra un aviso en la hoja o, si el script se ejecuta desde el editor, en el registro de ejecución
function avisar_(titulo, texto) {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.alert(titulo, texto, ui.ButtonSet.OK);
  } catch (err) {
    console.log(titulo + '\n\n' + texto);
  }
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
  // Una hoja sin pagos se limpia por completo, por si quedaron formatos de una versión anterior
  if (hoja.getLastRow() <= 1) {
    hoja.clear();
    hoja.getRange(1, 1, hoja.getMaxRows(), hoja.getMaxColumns()).clearDataValidations();
    hoja.setConditionalFormatRules([]);
    if (hoja.getMaxColumns() > ENCABEZADOS.length) hoja.deleteColumns(ENCABEZADOS.length + 1, hoja.getMaxColumns() - ENCABEZADOS.length);
  }
  hoja.getRange(1, 1, 1, ENCABEZADOS.length).setValues([ENCABEZADOS])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#2b1140')
    .setVerticalAlignment('middle').setWrap(true);
  hoja.setFrozenRows(1);
  hoja.setFrozenColumns(0);
  hoja.setRowHeight(1, 36);
  const anchos = [130, 120, 170, 200, 120, 110, 150, 170, 60];
  anchos.forEach((ancho, i) => hoja.setColumnWidth(i + 1, ancho));
  hoja.hideColumns(COL_ID);

  const filas = Math.max(hoja.getMaxRows() - 1, 1);
  TEXTO_COLUMNAS.forEach(col => hoja.getRange(2, col, filas, 1).setNumberFormat('@'));
  hoja.getRange(2, COL_MONTO, filas, 1).setNumberFormat('#,##0.00');
  hoja.getRange(2, COL_VALIDACION, filas, 1).setDataValidation(reglaValidacion_());

  const colores = [
    ['Por verificar', '#fff4d6', '#7a5200'],
    ['Verificado', '#dcf5e6', '#11683b'],
    ['Rechazado', '#fde2e1', '#9b1c1c']
  ];
  hoja.setConditionalFormatRules(colores.map(([texto, fondo, letra]) => SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(texto).setBackground(fondo).setFontColor(letra).setBold(true)
    .setRanges([hoja.getRange(2, COL_VALIDACION, filas, 1)]).build()));

  avisar_(
    'Hoja lista',
    'Clave de conexión (cópiala en el panel de entradas):\n\n' + clave_() +
    '\n\nAhora implementa el script como aplicación web: Implementar → Nueva implementación → Aplicación web, ' +
    'ejecutar como «Yo» y acceso «Cualquier usuario».'
  );
}

function verClave() {
  avisar_('Clave de conexión', clave_());
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
    return respuesta_({ ok: true, hoja: libro_().getName(), filas: Math.max(hoja.getLastRow() - 1, 0) });
  }
  if (cuerpo.accion !== 'pedidos' || !Array.isArray(cuerpo.pedidos)) return respuesta_({ ok: false, error: 'Acción desconocida' });

  const cerrojo = LockService.getScriptLock();
  cerrojo.waitLock(25000);
  try {
    if (hoja.getLastRow() === 0) hoja.getRange(1, 1, 1, ENCABEZADOS.length).setValues([ENCABEZADOS]).setFontWeight('bold');
    const ultima = hoja.getLastRow();
    const filaPorId = {};
    if (ultima > 1) {
      hoja.getRange(2, COL_ID, ultima - 1, 1).getValues().forEach((fila, i) => { filaPorId[String(fila[0])] = i + 2; });
    }
    let nuevas = 0;
    let actualizadas = 0;
    cuerpo.pedidos.forEach(p => {
      const id = String(p.id || '').trim();
      if (!id) return;
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
      hoja.getRange(fila, 1, 1, 7).setValues([[
        p.referencia || '', Number(p.montoBs) || 0, p.banco || '', p.nombre || '', p.cedula || '', p.entrada || '', p.fecha || ''
      ]]);
      hoja.getRange(fila, COL_ID).setValue(id);
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
