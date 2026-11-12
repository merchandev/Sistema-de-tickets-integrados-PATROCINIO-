/**
 * Hoja de control de pagos · Entradas de Iluminando Caminos y Hablemos de Marketing.
 *
 * El sistema de entradas envía aquí cada pago (nuevo, aprobado o rechazado) y este script crea o
 * actualiza su fila. «Validación en el banco» guarda la revisión manual del equipo.
 * «Validación en web» refleja el estado del sistema, que se administra desde el panel.
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
 *   Al cambiar este archivo: guarda y en Implementar → Administrar implementaciones
 *   edita la implementación y elige «Nueva versión» (la URL no cambia).
 */

const NOMBRE_HOJA = 'Pagos';
// Hoja que recibe los pagos; se usa cuando el script no está dentro de la propia hoja
const ID_HOJA = '1-QwaXmGvrgs3RopcTrPnPhtp62gFX9J21NVxKSQLy6I';
// Columnas visibles, en este orden; la última («ID») queda oculta y sirve para encontrar la fila de cada pago
const ENCABEZADOS = ['Referencia', 'Monto (Bs.)', 'Banco', 'Nombre', 'Cédula', 'Entrada', 'Fecha de pago', 'Validación en el banco', 'Validación en web', 'ID'];
const COL_MONTO = 2;
const COL_BANCO = 8;
const COL_ESTADO_WEB = 9;
const COL_ID = 10;
const TEXTO_COLUMNAS = [1, 3, 4, 5, 6, 7, COL_ID];
const VALIDACIONES = ['Por verificar', 'Verificado', 'Rechazado'];
const ESTADOS_WEB = { 'En verificación': 'Por verificar', Aprobado: 'Verificado', Rechazado: 'Rechazado' };

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

function prepararEncabezados_(hoja) {
  if (hoja.getLastRow() > 0) {
    const ancho = Math.min(hoja.getMaxColumns(), COL_ID);
    const encabezados = hoja.getRange(1, 1, 1, ancho).getDisplayValues()[0];
    if (ENCABEZADOS.every((titulo, i) => encabezados[i] === titulo)) return;
    const formatoAnterior = ENCABEZADOS.slice(0, 7).every((titulo, i) => encabezados[i] === titulo)
      && encabezados[COL_BANCO - 1] === 'Validación del equipo'
      && encabezados[COL_ESTADO_WEB - 1] === 'ID';
    if (!formatoAnterior) throw new Error('Los encabezados de la pestaña Pagos no coinciden con la configuración de la integración.');
    hoja.insertColumnBefore(COL_ESTADO_WEB);
  }
  if (hoja.getMaxColumns() < COL_ID) {
    hoja.insertColumnsAfter(hoja.getMaxColumns(), COL_ID - hoja.getMaxColumns());
  }
  hoja.getRange(1, 1, 1, COL_ID).setValues([ENCABEZADOS]).setFontWeight('bold');
}

/** Prepara encabezados, formatos, la lista desplegable y los colores. Se puede repetir sin perder datos. */
function configurar() {
  const hoja = hoja_();
  prepararEncabezados_(hoja);
  hoja.getRange(1, 1, 1, ENCABEZADOS.length).setValues([ENCABEZADOS])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#2b1140')
    .setVerticalAlignment('middle').setWrap(true);
  hoja.setFrozenRows(1);
  hoja.setFrozenColumns(0);
  hoja.setRowHeight(1, 36);
  const anchos = [130, 120, 170, 200, 120, 110, 150, 170, 170, 60];
  anchos.forEach((ancho, i) => hoja.setColumnWidth(i + 1, ancho));
  hoja.hideColumns(COL_ID);

  const filas = Math.max(hoja.getMaxRows() - 1, 1);
  TEXTO_COLUMNAS.forEach(col => hoja.getRange(2, col, filas, 1).setNumberFormat('@'));
  hoja.getRange(2, COL_MONTO, filas, 1).setNumberFormat('#,##0.00');
  const validaciones = hoja.getRange(2, COL_BANCO, filas, 2);
  validaciones.setDataValidation(reglaValidacion_());

  const colores = [
    ['Por verificar', '#fff4d6', '#7a5200'],
    ['Verificado', '#dcf5e6', '#11683b'],
    ['Rechazado', '#fde2e1', '#9b1c1c']
  ];
  hoja.setConditionalFormatRules(colores.map(([texto, fondo, letra]) => SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(texto).setBackground(fondo).setFontColor(letra).setBold(true)
    .setRanges([validaciones]).build()));

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

  const prueba = cuerpo.accion === 'prueba';
  if (!prueba && (cuerpo.accion !== 'pedidos' || !Array.isArray(cuerpo.pedidos))) {
    return respuesta_({ ok: false, error: 'Acción desconocida' });
  }

  const cerrojo = LockService.getScriptLock();
  try {
    cerrojo.waitLock(25000);
    const hoja = hoja_();
    prepararEncabezados_(hoja);
    const ultima = hoja.getLastRow();
    const filaPorId = new Map();
    if (ultima > 1) {
      hoja.getRange(2, COL_ID, ultima - 1, 1).getValues().forEach(([valor], i) => {
        const id = String(valor).trim();
        if (id) filaPorId.set(id, i + 2);
      });
    }
    if (prueba) return respuesta_({ ok: true, hoja: libro_().getName(), filas: filaPorId.size });

    let siguienteFila = ultima + 1;
    let nuevas = 0;
    let actualizadas = 0;
    cuerpo.pedidos.forEach(p => {
      const id = String(p.id || '').trim();
      if (!id) return;
      let fila = filaPorId.get(id);
      if (!fila) {
        fila = siguienteFila++;
        if (fila > hoja.getMaxRows()) hoja.insertRowsAfter(hoja.getMaxRows(), fila - hoja.getMaxRows());
        hoja.getRange(fila, COL_ID).setNumberFormat('@').setValue(id);
        filaPorId.set(id, fila);
        nuevas++;
      } else {
        actualizadas++;
      }
      TEXTO_COLUMNAS.forEach(col => hoja.getRange(fila, col).setNumberFormat('@'));
      hoja.getRange(fila, 1, 1, 7).setValues([[
        p.referencia || '', Number(p.montoBs) || 0, p.banco || '', p.nombre || '', p.cedula || '', p.entrada || '', p.fecha || ''
      ]]);
      const banco = hoja.getRange(fila, COL_BANCO).setDataValidation(reglaValidacion_());
      if (!banco.getValue()) banco.setValue('Por verificar');
      hoja.getRange(fila, COL_ESTADO_WEB).setDataValidation(reglaValidacion_())
        .setValue(ESTADOS_WEB[p.estadoWeb] || 'Por verificar');
    });
    SpreadsheetApp.flush();
    return respuesta_({ ok: true, nuevas: nuevas, actualizadas: actualizadas });
  } catch (err) {
    return respuesta_({ ok: false, error: String(err.message || err) });
  } finally {
    if (cerrojo.hasLock()) cerrojo.releaseLock();
  }
}
