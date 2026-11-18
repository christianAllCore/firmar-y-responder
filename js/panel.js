/*
 * Firmar y responder - panel de Outlook (lo abre el boton "Firmar y responder" del correo).
 *
 * 1. Busca los PDF adjuntos del correo.
 * 2. Abre la ventana de firma (firmar.html) y le pasa los PDF.
 * 3. Cuando la ventana devuelve los PDF firmados, abre "Responder" o "Responder a todos"
 *    de ESTE mismo correo con los PDF firmados ya adjuntos. La persona revisa y pulsa Enviar.
 */
(function () {
  'use strict';
  const C = window.Comun;
  const $ = (id) => document.getElementById(id);
  let item = null;
  let pdfs = [];
  let dialogo = null;
  let resultado = null;

  function estado(texto, tipo) {
    const e = $('estado');
    e.className = 'aviso ' + (tipo || 'info');
    e.textContent = texto;
    e.hidden = false;
  }
  function soporta(conjunto, version) {
    try { return Office.context.requirements.isSetSupported(conjunto, version); } catch (e) { return false; }
  }
  function esPdf(a) {
    return !!a && a.attachmentType === Office.MailboxEnums.AttachmentType.File &&
      (/\.pdf$/i.test(a.name || '') || /pdf/i.test(a.contentType || ''));
  }
  function pintarLista() {
    const l = $('lista');
    l.innerHTML = '';
    for (const a of pdfs) {
      const fila = document.createElement('div');
      fila.className = 'item-pdf';
      const icono = document.createElement('span');
      icono.className = 'icono';
      icono.textContent = 'PDF';
      const nombre = document.createElement('span');
      nombre.className = 'nombre';
      nombre.textContent = a.name;
      nombre.title = a.name;
      const tam = document.createElement('span');
      tam.className = 'tenue';
      tam.style.marginLeft = 'auto';
      tam.textContent = C.tamano(a.size);
      fila.append(icono, nombre, tam);
      l.appendChild(fila);
    }
  }

  function leerAdjunto(id) {
    return new Promise((ok, mal) => {
      item.getAttachmentContentAsync(id, (r) => {
        if (r.status !== Office.AsyncResultStatus.Succeeded) {
          mal(new Error((r.error && r.error.message) || 'Outlook no entregó el archivo.'));
          return;
        }
        if (r.value.format !== Office.MailboxEnums.AttachmentContentFormat.Base64) {
          mal(new Error('Outlook lo entregó como "' + r.value.format + '" (por ejemplo, un enlace de OneDrive) y no como archivo.'));
          return;
        }
        ok(r.value.content);
      });
    });
  }

  // ---------------------------------------------------------------- ventana de firma
  function textoErrorDialogo(err) {
    const c = err && err.code;
    if (c === 12007) return 'Ya hay una ventana de firma abierta.';
    if (c === 12009) return 'La ventana de firma no se abrió. Pulsa «Abrir para firmar» y, si el navegador pregunta, permítela.';
    if (c === 12011) return 'El navegador bloqueó la ventana de firma (ventanas emergentes). Permítelas para Outlook y pulsa «Abrir para firmar».';
    return 'No se pudo abrir la ventana de firma' + (c ? ' (código ' + c + ')' : '') + '. Pulsa «Abrir para firmar».';
  }
  function abrirDialogo() {
    if (dialogo) return;
    if (!soporta('DialogApi', '1.2')) {
      estado('Tu versión de Outlook no permite la ventana de firma (le falta DialogApi 1.2). Usa Outlook en el navegador o el Outlook nuevo.', 'error');
      return;
    }
    resultado = null;
    $('btnAbrir').hidden = true;
    $('btnReabrir').hidden = true;
    $('ayudaRespuesta').hidden = true;
    $('descargas').hidden = true;
    estado('Abriendo la ventana de firma…', 'info');
    const url = new URL('firmar.html', location.href);
    url.searchParams.set('modo', 'outlook');
    Office.context.ui.displayDialogAsync(url.href, { height: 92, width: 92, displayInIframe: true }, (r) => {
      if (r.status !== Office.AsyncResultStatus.Succeeded) {
        dialogo = null;
        $('btnAbrir').hidden = false;
        estado(textoErrorDialogo(r.error), 'error');
        return;
      }
      dialogo = r.value;
      dialogo.addEventHandler(Office.EventType.DialogMessageReceived, (arg) => {
        // solo se aceptan mensajes de la ventana de firma de este mismo sitio
        if (arg && arg.origin && arg.origin !== location.origin) return;
        recibir(arg.message);
      });
      dialogo.addEventHandler(Office.EventType.DialogEventReceived, (arg) => {
        dialogo = null;
        $('btnAbrir').hidden = false;
        if (!resultado) {
          estado(arg && arg.error === 12006
            ? 'Cerraste la ventana de firma sin firmar. Pulsa «Abrir para firmar» para volver.'
            : 'La ventana de firma se cerró' + (arg && arg.error ? ' (código ' + arg.error + ')' : '') + '. Pulsa «Abrir para firmar» para volver.', 'info');
        }
      });
      estado('Ventana de firma abierta: elige dónde va el sello, escribe tu clave y pulsa «Firmar y responder».', 'info');
    });
  }
  function cerrarDialogo() {
    if (dialogo) { try { dialogo.close(); } catch (e) { /* ya estaba cerrada */ } }
    dialogo = null;
  }
  function enviar(obj) {
    if (dialogo) C.enviarEnTrozos((t) => dialogo.messageChild(t), obj);
  }

  const recibir = C.receptor(async (m) => {
    if (!m) return;
    if (m.tipo === 'listo') {
      enviar({ tipo: 'inicio', asunto: item.subject || '', adjuntos: pdfs.map((a) => ({ id: a.id, nombre: a.name, tam: a.size })) });
      for (const a of pdfs) {
        try { enviar({ tipo: 'adjunto', id: a.id, base64: await leerAdjunto(a.id) }); }
        catch (e) { enviar({ tipo: 'adjunto', id: a.id, error: e.message }); }
      }
    } else if (m.tipo === 'responder') {
      resultado = m;
      cerrarDialogo();
      responder(m);
    } else if (m.tipo === 'cerrar') {
      cerrarDialogo();
      $('btnAbrir').hidden = false;
      estado('Cerraste la ventana de firma sin firmar. Pulsa «Abrir para firmar» para volver.', 'info');
    }
  });

  // ---------------------------------------------------------------- respuesta con el PDF firmado
  function htmlMensaje(texto) {
    const cuerpo = C.escaparHtml(texto || '').replace(/\r?\n/g, '<br>');
    return '<div style="font-family:Calibri,Arial,Helvetica,sans-serif;font-size:11pt">' + cuerpo + '</div>';
  }
  function ofrecerDescargas(archivos) {
    const d = $('descargas');
    d.innerHTML = '';
    const t = document.createElement('div');
    t.className = 'tenue';
    t.textContent = 'Por si hace falta, el PDF firmado:';
    d.appendChild(t);
    for (const a of archivos) {
      const bin = atob(a.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const enlace = document.createElement('a');
      enlace.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      enlace.download = a.nombre;
      enlace.textContent = 'Descargar «' + a.nombre + '»';
      d.appendChild(enlace);
    }
    d.hidden = false;
  }
  function responder(m) {
    const nombres = m.archivos.map((a) => a.nombre);
    const extra = m.sinFirma && m.sinFirma.length ? ' No se firmó: ' + m.sinFirma.join(', ') + '.' : '';
    $('btnAbrir').textContent = 'Firmar otra vez';
    $('btnAbrir').hidden = false;
    if (!soporta('Mailbox', '1.15')) {
      // Outlook antiguo: no deja adjuntar un archivo generado; se abre la respuesta y el PDF se descarga aparte.
      ofrecerDescargas(m.archivos);
      const sinAdjunto = m.todos ? 'displayReplyAllForm' : 'displayReplyForm';
      try { item[sinAdjunto](htmlMensaje(m.mensaje)); } catch (e) { /* nada */ }
      estado('Tu Outlook no deja adjuntar el PDF firmado automáticamente. Descárgalo abajo y adjúntalo a la respuesta.' + extra, 'error');
      return;
    }
    estado('Abriendo la respuesta…', 'info');
    abrirRespuesta(m, (ok, error) => {
      if (!ok) {
        ofrecerDescargas(m.archivos);
        estado('Outlook no pudo abrir la respuesta con el PDF firmado (' + (error || 'sin detalle') +
          '). Pulsa «Abrir la respuesta otra vez» o descarga el PDF firmado abajo y adjúntalo a mano.', 'error');
      } else {
        estado('✔ Listo. Se abrió la respuesta' + (m.todos ? ' a todos' : '') + ' con ' +
          (nombres.length === 1 ? '«' + nombres[0] + '» adjunto' : nombres.length + ' PDF firmados adjuntos') +
          '. Revísala y pulsa Enviar.' + extra, 'ok');
      }
      // Outlook en la web abre la respuesta en una ventana nueva. Si la firma tardó unos segundos, el navegador
      // puede bloquearla como «ventana emergente» y aun así Outlook responde «listo» (pasó el 18/11/2026 en Chrome):
      // se deja a la vista un botón para abrirla de nuevo con un clic (con un clic, el navegador ya no la bloquea).
      $('btnReabrir').hidden = false;
      $('ayudaRespuesta').hidden = false;
    });
  }
  function abrirRespuesta(m, alTerminar) {
    const datos = {
      htmlBody: htmlMensaje(m.mensaje),
      attachments: m.archivos.map((a) => ({ type: 'base64', name: a.nombre, base64file: a.base64 }))
    };
    const metodo = m.todos ? 'displayReplyAllFormAsync' : 'displayReplyFormAsync';
    try {
      item[metodo](datos, (r) => {
        if (r.status !== Office.AsyncResultStatus.Succeeded) alTerminar(false, r.error && r.error.message);
        else alTerminar(true);
      });
    } catch (e) {
      alTerminar(false, e && e.message);
    }
  }
  function reabrirRespuesta() {
    if (!resultado) return;
    // se llama directamente desde el clic: así el navegador deja abrir la ventana de la respuesta
    abrirRespuesta(resultado, (ok, error) => {
      if (!ok) estado('Outlook no pudo abrir la respuesta (' + (error || 'sin detalle') + '). Descarga el PDF firmado abajo y adjúntalo a mano.', 'error');
      else estado('✔ Se abrió otra vez la respuesta con el PDF firmado. Revísala y pulsa Enviar.', 'ok');
    });
  }

  // ---------------------------------------------------------------- arranque
  Office.onReady((info) => {
    if (info.host !== Office.HostType.Outlook) {
      estado('Esta página funciona dentro de Outlook. Para firmar un PDF de tu equipo, abre firmar.html.', 'info');
      return;
    }
    item = Office.context.mailbox.item;
    if (!item) { estado('Abre un correo para usar «Firmar y responder».', 'info'); return; }
    if (!soporta('Mailbox', '1.8')) {
      estado('Tu versión de Outlook es muy antigua para leer los adjuntos (necesita Mailbox 1.8).', 'error');
      return;
    }
    pdfs = (item.attachments || []).filter(esPdf);
    pintarLista();
    $('btnAbrir').addEventListener('click', abrirDialogo);
    $('btnReabrir').addEventListener('click', reabrirRespuesta);
    if (!pdfs.length) { estado('Este correo no tiene archivos PDF adjuntos.', 'info'); return; }
    abrirDialogo();
  });
})();
