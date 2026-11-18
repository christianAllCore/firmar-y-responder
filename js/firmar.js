/*
 * Firmar y responder - ventana de firma.
 *
 * Dentro de Outlook (firmar.html?modo=outlook, abierta por el panel): recibe los PDF del correo,
 * deja elegir donde va el sello, firma y devuelve los PDF firmados al panel, que abre la respuesta.
 * Abierta sola en el navegador: firma un PDF del equipo y lo descarga.
 */
import * as pdfjsLib from '../lib/pdf.min.mjs';

const F = window.Firmador;
const C = window.Comun;
const $ = (id) => document.getElementById(id);

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.mjs', import.meta.url).href;
const FUENTES = new URL('../lib/standard_fonts/', import.meta.url).href;

const SALUDOS = ['Buenos días, adjunto el documento firmado.', 'Buenas tardes, adjunto el documento firmado.', 'Buenas noches, adjunto el documento firmado.'];
function saludo() {
  const h = new Date().getHours();
  return SALUDOS[h < 12 ? 0 : h < 19 ? 1 : 2];
}

const estado = {
  modo: 'suelto',
  docs: [],          // { id, nombre, tam, bytes, error, pdf, paginas: [{pg, rot, base, div, lienzo, escala}], sello: {pagina, fx, fy, recordado} }
  actual: -1,
  p12: null,         // { nombre, bytes }
  firmante: '',
  posicion: null,    // ultima posicion usada: { desdeFinal, fx, fy }
  escala: 1,
  ocupado: false,
  enviado: false,
  enviarAlPanel: null
};

// ------------------------------------------------------------------ avisos
function avisar(tipo, mensaje, detalle, etiqueta) {
  const a = $('aviso');
  a.className = 'aviso ' + tipo;
  a.dataset.etiqueta = etiqueta || '';
  a.innerHTML = '';
  const p = document.createElement('div');
  p.textContent = mensaje;
  a.appendChild(p);
  if (detalle) {
    const det = document.createElement('details');
    const s = document.createElement('summary');
    s.textContent = 'Detalle técnico';
    const pre = document.createElement('pre');
    pre.textContent = detalle;
    det.append(s, pre);
    a.appendChild(det);
  }
  a.hidden = false;
  a.scrollIntoView({ block: 'nearest' });
}
function limpiarAviso(etiqueta) {
  const a = $('aviso');
  if (etiqueta === undefined || a.dataset.etiqueta === etiqueta) a.hidden = true;
}
const CONSEJOS = {
  CLAVE: ' Escríbela de nuevo (ojo con las mayúsculas).',
  P12: ' Elige el archivo .p12 que te entregó la entidad de certificación (por ejemplo, Security Data).',
  VENCIDA: '',
  PDF_PROTEGIDO: '',
  PDF_DANADO: ' Pide que te lo vuelvan a enviar.'
};
function mostrarError(e) {
  if (e && e.name === 'ErrorFirma') {
    avisar('error', e.message + (CONSEJOS[e.codigo] || ''), e.detalle);
  } else {
    avisar('error', 'No se pudo firmar por un error inesperado. Intenta otra vez; si se repite, guarda el detalle de abajo.',
      (e && (e.stack || e.message)) || String(e));
  }
}

// ------------------------------------------------------------------ espera / ocupado
function esperarPintado() {
  return new Promise((ok) => requestAnimationFrame(() => setTimeout(ok, 30)));
}
const BOTONES = ['btnResponder', 'btnResponderTodos', 'btnDescargar'];
const TEXTOS = {};
function ocupado(si, idBoton) {
  estado.ocupado = si;
  for (const id of BOTONES) {
    const b = $(id);
    if (!TEXTOS[id]) TEXTOS[id] = b.textContent;
    b.disabled = si || estado.enviado;
    if (si && id === idBoton) {
      b.innerHTML = '';
      const g = document.createElement('span');
      g.className = 'girando' + (b.classList.contains('primario') ? '' : ' oscuro');
      b.append(g, document.createTextNode(' Firmando…'));
    } else if (!si) {
      b.textContent = TEXTOS[id];
    }
  }
}

// ------------------------------------------------------------------ pantalla vacia
let observador = null;
function vacio(texto, conGiro, conBoton) {
  if (observador) { observador.disconnect(); observador = null; }
  const cont = $('paginas');
  cont.innerHTML = '';
  const v = document.createElement('div');
  v.className = 'vacio';
  v.id = 'vacio';
  if (conGiro) { const g = document.createElement('span'); g.className = 'girando oscuro'; v.appendChild(g); }
  const t = document.createElement('div');
  t.textContent = texto;
  v.appendChild(t);
  if (conBoton) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn primario';
    b.textContent = 'Elegir un PDF…';
    b.addEventListener('click', () => $('archivoPdf').click());
    v.appendChild(b);
  }
  cont.appendChild(v);
  $('infoPaginas').textContent = '';
  $('btnUltima').hidden = true;
  pintarPaso1(null);
}

// ------------------------------------------------------------------ pestanas de documentos
function pintarPestanas() {
  const cont = $('docs');
  cont.innerHTML = '';
  estado.docs.forEach((d, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'doc-tab' + (i === estado.actual ? ' activo' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', i === estado.actual ? 'true' : 'false');
    b.title = d.nombre + (d.tam ? ' (' + C.tamano(d.tam) + ')' : '');
    if (d.sello) {
      const ok = document.createElement('span');
      ok.className = 'marca-ok';
      ok.textContent = '✔';
      ok.title = 'Tiene el sello puesto';
      b.appendChild(ok);
    }
    const n = document.createElement('span');
    n.className = 'nombre';
    n.textContent = d.nombre;
    b.appendChild(n);
    b.addEventListener('click', () => { if (i !== estado.actual) abrirDocumento(i); });
    cont.appendChild(b);
  });
}

// ------------------------------------------------------------------ abrir y dibujar el PDF
async function abrirDocumento(i) {
  estado.actual = i;
  pintarPestanas();
  const d = estado.docs[i];
  if (d.error) { vacio(d.error); return; }
  if (!d.bytes) { vacio('Trayendo «' + d.nombre + '» del correo…', true); return; }
  if (!d.pdf) {
    vacio('Abriendo «' + d.nombre + '»…', true);
    try {
      const pdf = await pdfjsLib.getDocument({
        data: d.bytes.slice(), isEvalSupported: false, standardFontDataUrl: FUENTES, disableAutoFetch: true
      }).promise;
      const paginas = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const pg = await pdf.getPage(n);
        paginas.push({ pg: pg, rot: pg.rotate, base: pg.getViewport({ scale: 1 }) });
      }
      d.pdf = pdf;
      d.paginas = paginas;
    } catch (e) {
      d.error = (e && e.name === 'PasswordException')
        ? '«' + d.nombre + '» tiene clave para abrirlo; así no se puede firmar. Pide una versión sin clave.'
        : '«' + d.nombre + '» no se pudo abrir: parece dañado o no es un PDF.';
      if (estado.actual === i) vacio(d.error);
      return;
    }
    if (!d.sello && estado.posicion) {
      const total = d.paginas.length;
      const pagina = Math.min(total - 1, Math.max(0, total - 1 - (estado.posicion.desdeFinal || 0)));
      d.sello = { pagina: pagina, fx: estado.posicion.fx, fy: estado.posicion.fy, recordado: true };
      pintarPestanas();
    }
  }
  if (estado.actual === i) dibujarDocumento(d, true);
}

function dibujarDocumento(d, desplazar) {
  const cont = $('paginas');
  const proporcion = cont.scrollHeight > 0 ? cont.scrollTop / cont.scrollHeight : 0;
  if (observador) observador.disconnect();
  cont.innerHTML = '';
  const disponible = Math.max(200, cont.clientWidth - 40);
  const maxAncho = Math.max.apply(null, d.paginas.map((p) => p.base.width));
  estado.escala = Math.max(0.4, Math.min(1.75, disponible / maxAncho));
  observador = new IntersectionObserver((entradas) => {
    for (const e of entradas) if (e.isIntersecting) renderizar(d, Number(e.target.dataset.i));
  }, { root: cont, rootMargin: '800px 0px' });
  d.paginas.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'pagina';
    div.dataset.i = String(i);
    div.style.width = Math.floor(p.base.width * estado.escala) + 'px';
    div.style.height = Math.floor(p.base.height * estado.escala) + 'px';
    const lienzo = document.createElement('canvas');
    lienzo.className = 'lienzo';
    div.appendChild(lienzo);
    const pie = document.createElement('div');
    pie.className = 'pie-pagina';
    pie.textContent = 'Página ' + (i + 1) + ' de ' + d.paginas.length;
    div.appendChild(pie);
    p.div = div;
    p.lienzo = lienzo;
    p.escala = null;
    div.addEventListener('mousemove', (ev) => moverFantasma(d, i, ev));
    div.addEventListener('mouseleave', ocultarFantasma);
    div.addEventListener('click', (ev) => ponerSello(d, i, ev));
    cont.appendChild(div);
    observador.observe(div);
  });
  pintarSello(d);
  $('infoPaginas').textContent = d.paginas.length === 1 ? '1 página' : d.paginas.length + ' páginas';
  $('btnUltima').hidden = d.paginas.length < 2;
  pintarPaso1(d);
  if (desplazar) {
    if (d.sello) {
      // el SELLO al centro de la vista (no la pagina: en una pagina alta el sello quedaba cortado al pie)
      const div = d.paginas[d.sello.pagina].div;
      cont.scrollTop = Math.max(0, div.offsetTop + d.sello.fy * div.offsetHeight - cont.clientHeight / 2);
    } else {
      cont.scrollTop = 0;
    }
  } else {
    cont.scrollTop = proporcion * cont.scrollHeight;
  }
}

async function renderizar(d, i) {
  const p = d.paginas[i];
  const escala = estado.escala;
  const lienzo = p.lienzo;
  if (p.escala === escala || p.trabajando) return;
  p.trabajando = true;
  try {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = p.pg.getViewport({ scale: escala * dpr });
    lienzo.width = Math.floor(vp.width);
    lienzo.height = Math.floor(vp.height);
    await p.pg.render({ canvasContext: lienzo.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    p.escala = escala;
  } catch (e) {
    console.warn('No se pudo dibujar la página ' + (i + 1), e);
  } finally {
    p.trabajando = false;
  }
  // si mientras tanto cambio el tamano de la ventana, dibujar otra vez en el lienzo nuevo
  if (p.lienzo !== lienzo || estado.escala !== escala) { p.escala = null; renderizar(d, i); }
}

// ------------------------------------------------------------------ sello: vista previa y ubicacion
let disenoCache = { nombre: null, diseno: null };
function disenoActual() {
  const nombre = estado.firmante || 'TU NOMBRE COMO ESTÁ EN TU FIRMA';
  if (disenoCache.nombre !== nombre) {
    disenoCache = { nombre: nombre, diseno: F.disenoSello(nombre, F.textoQr(nombre, '', '', new Date())) };
  }
  return disenoCache.diseno;
}
function dibujarVistaSello(lienzo, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  const clave = W + 'x' + H + '|' + (estado.firmante || '');
  if (lienzo.dataset.clave === clave) return;
  lienzo.dataset.clave = clave;
  lienzo.width = W;
  lienzo.height = H;
  const ctx = lienzo.getContext('2d');
  const k = W / F.SELLO.ancho;
  const dis = disenoActual();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  // Cada modulo del QR mide menos de un pixel a tamano real: se pinta con bordes redondeados al pixel
  // para que no se encimen (si no, el QR se ve como una mancha negra).
  const n = dis.qr.modulos.length;
  const m = dis.qr.lado / (n + 2 * dis.qr.margen) * k;
  const borde = (i) => Math.round((dis.qr.margen + i) * m);
  dis.qr.modulos.forEach((fila, f) => fila.forEach((oscuro, c) => {
    if (oscuro) ctx.fillRect(borde(c), borde(f), Math.max(1, borde(c + 1) - borde(c)), Math.max(1, borde(f + 1) - borde(f)));
  }));
  for (const l of dis.lineas) {
    if (!l.texto) continue;
    ctx.font = (l.fuente === 'F2' ? 'bold ' : '') + (l.tam * k).toFixed(2) + 'px "Courier New", Courier, monospace';
    ctx.fillText(l.texto, l.x * k, (F.SELLO.alto - l.y) * k);
  }
}
function tamSello() { return { w: F.SELLO.ancho * estado.escala, h: F.SELLO.alto * estado.escala }; }
function ubicar(el, cx, cy) {
  const t = tamSello();
  el.style.left = (cx - t.w / 2) + 'px';
  el.style.top = (cy - t.h / 2) + 'px';
  el.style.width = t.w + 'px';
  el.style.height = t.h + 'px';
  dibujarVistaSello(el.firstChild, t.w, t.h);
}
function crearSello(clase) {
  const el = document.createElement('div');
  el.className = 'sello ' + clase;
  el.appendChild(document.createElement('canvas'));
  return el;
}
const fantasma = crearSello('fantasma');
fantasma.hidden = true;
let selloPuesto = null;

function centroLimitado(div, ev) {
  const r = div.getBoundingClientRect();
  const t = tamSello();
  const x = Math.min(Math.max(ev.clientX - r.left, t.w / 2), r.width - t.w / 2);
  const y = Math.min(Math.max(ev.clientY - r.top, t.h / 2), r.height - t.h / 2);
  return { x: x, y: y, fx: x / r.width, fy: y / r.height };
}
function moverFantasma(d, i, ev) {
  if (estado.ocupado) return;
  const div = d.paginas[i].div;
  const c = centroLimitado(div, ev);
  if (fantasma.parentNode !== div) div.appendChild(fantasma);
  ubicar(fantasma, c.x, c.y);
  fantasma.hidden = false;
}
function ocultarFantasma() { fantasma.hidden = true; }
function ponerSello(d, i, ev) {
  if (estado.ocupado) return;
  const c = centroLimitado(d.paginas[i].div, ev);
  d.sello = { pagina: i, fx: c.fx, fy: c.fy };
  pintarSello(d);
  pintarPaso1(d);
  pintarPestanas();
  limpiarAviso('sello');
}
function pintarSello(d) {
  if (selloPuesto && selloPuesto.parentNode) selloPuesto.parentNode.removeChild(selloPuesto);
  if (!d || !d.sello || !d.paginas || !d.paginas[d.sello.pagina] || !d.paginas[d.sello.pagina].div) return;
  const div = d.paginas[d.sello.pagina].div;
  selloPuesto = crearSello('puesto');
  div.appendChild(selloPuesto);
  const ancho = parseFloat(div.style.width), alto = parseFloat(div.style.height);
  ubicar(selloPuesto, d.sello.fx * ancho, d.sello.fy * alto);
}
function pintarPaso1(d) {
  const e = $('estadoSello');
  e.innerHTML = '';
  const hecho = !!(d && d.sello && d.paginas);
  $('paso1').classList.toggle('hecha', hecho);
  $('ayudaSello').hidden = hecho;
  if (!hecho) return;
  const b = document.createElement('b');
  b.textContent = '✔ Sello en la página ' + (d.sello.pagina + 1) + ' de ' + d.paginas.length + '.';
  e.append(b, document.createTextNode(d.sello.recordado
    ? ' Lo puse donde lo pusiste la última vez; haz clic en otro lugar para moverlo.'
    : ' Haz clic en otro lugar para moverlo.'));
}

// Coordenadas del sello en el PDF (tiene en cuenta el giro de la pagina y su recorte)
function rectanguloPdf(d) {
  const p = d.paginas[d.sello.pagina];
  const vp = p.pg.getViewport({ scale: 1 });
  const cx = d.sello.fx * vp.width, cy = d.sello.fy * vp.height;
  const w = F.SELLO.ancho / 2, h = F.SELLO.alto / 2;
  const pts = [[cx - w, cy - h], [cx + w, cy - h], [cx - w, cy + h], [cx + w, cy + h]].map((q) => vp.convertToPdfPoint(q[0], q[1]));
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return { rect: [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)], rotacion: p.rot };
}

// ------------------------------------------------------------------ archivo .p12
function ponerP12(nombre, bytes, guardar) {
  estado.p12 = { nombre: nombre, bytes: bytes };
  $('sinP12').hidden = true;
  $('conP12').hidden = false;
  $('nombreP12').textContent = nombre;
  $('nombreP12').title = nombre;
  $('paso2').classList.add('hecha');
  if (guardar) {
    C.almacen.guardar('p12', { nombre: nombre, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), guardado: Date.now() });
  }
}
function quitarP12() {
  estado.p12 = null;
  estado.firmante = '';
  C.almacen.borrar('p12');
  guardarPreferencias(null);
  $('clave').value = '';
  $('sinP12').hidden = false;
  $('conP12').hidden = true;
  $('paso2').classList.remove('hecha');
  pintarFirmante();
  refrescarSellos();
  avisar('info', 'Se quitó tu archivo de firma de este navegador.');
}
async function alElegirP12(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  if (f.size > 1024 * 1024) {
    avisar('error', 'Ese archivo es demasiado grande para ser una firma .p12 (pesa ' + C.tamano(f.size) + ').');
    return;
  }
  const bytes = new Uint8Array(await f.arrayBuffer());
  if (bytes[0] !== 0x30) {
    avisar('error', 'Ese archivo no parece una firma electrónica. Busca el archivo .p12 (o .pfx) que te entregó la entidad de certificación.');
    return;
  }
  ponerP12(f.name, bytes, true);
  estado.firmante = '';
  pintarFirmante();
  refrescarSellos();
  limpiarAviso();
  $('clave').focus();
}
function pintarFirmante() {
  $('firmante').textContent = estado.firmante ? 'Firmará: ' + estado.firmante : '';
}
function refrescarSellos() {
  disenoCache = { nombre: null, diseno: null };
  fantasma.firstChild.dataset.clave = '';
  const d = estado.docs[estado.actual];
  if (d && d.paginas) pintarSello(d);
}

// ------------------------------------------------------------------ preferencias
function guardarPreferencias(docFirmado) {
  const pref = { firmante: estado.firmante, mensaje: $('mensaje').value };
  const actual = estado.docs[estado.actual];
  const ref = (actual && actual.sello && actual.paginas) ? actual : docFirmado;
  if (ref && ref.sello && ref.paginas) {
    pref.posicion = { desdeFinal: ref.paginas.length - 1 - ref.sello.pagina, fx: ref.sello.fx, fy: ref.sello.fy };
  } else if (estado.posicion) {
    pref.posicion = estado.posicion;
  }
  estado.posicion = pref.posicion || null;
  if (SALUDOS.indexOf(pref.mensaje) >= 0) pref.mensaje = '';  // el saludo se ajusta solo a la hora
  // Se espera a que quede guardado: el panel cierra esta ventana apenas recibe los PDF firmados
  // y un guardado a medias se pierde (pasaba: la segunda vez no recordaba el lugar del sello).
  return Promise.race([C.almacen.guardar('preferencias', pref), new Promise((ok) => setTimeout(ok, 2000))]);
}

// ------------------------------------------------------------------ firmar
async function firmar(accion) {
  if (estado.ocupado || estado.enviado) return;
  limpiarAviso();
  if (!estado.docs.some((d) => d.pdf)) {
    avisar('error', estado.modo === 'suelto' ? 'Primero elige un PDF.' : 'Espera a que se abra el PDF.');
    return;
  }
  const conSello = estado.docs.filter((d) => d.pdf && d.sello);
  if (!conSello.length) {
    avisar('error', 'Haz clic en el documento, en el lugar donde quieres tu firma.', null, 'sello');
    return;
  }
  if (!estado.p12) {
    avisar('error', 'Elige tu archivo de firma (.p12) en el paso 2.');
    return;
  }
  const clave = $('clave').value;
  if (!clave) {
    avisar('error', 'Escribe la clave de tu firma electrónica.');
    $('clave').focus();
    return;
  }
  const idBoton = accion === 'todos' ? 'btnResponderTodos' : accion === 'descargar' ? 'btnDescargar' : 'btnResponder';
  ocupado(true, idBoton);
  ocultarFantasma();
  await esperarPintado();
  try {
    const identidad = F.abrirP12(estado.p12.bytes, clave);
    F.revisarVigencia(identidad);
    if (estado.firmante !== identidad.nombre) {
      estado.firmante = identidad.nombre;
      pintarFirmante();
      refrescarSellos();
    }
    const archivos = [];
    for (const d of conSello) {
      const r = rectanguloPdf(d);
      const bytes = await F.firmarPdf(d.bytes, { identidad: identidad, pagina: d.sello.pagina, rect: r.rect, rotacion: r.rotacion });
      archivos.push({ nombre: C.nombreFirmado(d.nombre), bytes: bytes });
    }
    $('clave').value = '';
    await guardarPreferencias(conSello[conSello.length - 1]);
    const sinFirma = estado.docs.filter((d) => !d.sello).map((d) => d.nombre);
    if (accion === 'descargar') {
      descargar(archivos);
      avisar('ok', archivos.length === 1
        ? 'Listo: se descargó «' + archivos[0].nombre + '».'
        : 'Listo: se descargaron ' + archivos.length + ' archivos firmados.');
    } else {
      estado.enviado = true;
      avisar('ok', 'Firmado. Abriendo la respuesta en Outlook…');
      estado.enviarAlPanel({
        tipo: 'responder',
        todos: accion === 'todos',
        mensaje: $('mensaje').value,
        archivos: archivos.map((a) => ({ nombre: a.nombre, base64: F.util.aBase64(a.bytes) })),
        sinFirma: sinFirma
      });
    }
  } catch (e) {
    mostrarError(e);
    if (e && e.codigo === 'CLAVE') { $('clave').focus(); $('clave').select(); }
  } finally {
    ocupado(false);
  }
}
function descargar(archivos) {
  for (const a of archivos) {
    const url = URL.createObjectURL(new Blob([a.bytes], { type: 'application/pdf' }));
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = a.nombre;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

// ------------------------------------------------------------------ Outlook
function esperarOffice() {
  const pedido = new URLSearchParams(location.search).get('modo') === 'outlook';
  if (!pedido) return Promise.resolve('suelto');
  if (typeof Office === 'undefined') return Promise.resolve('fallo');
  return new Promise((ok) => {
    const t = setTimeout(() => ok('fallo'), 20000);
    Office.onReady(() => {
      clearTimeout(t);
      ok(Office.context && Office.context.ui && typeof Office.context.ui.messageParent === 'function' ? 'outlook' : 'fallo');
    });
  });
}
function conectarConPanel() {
  const recibir = C.receptor(alRecibirDelPanel);
  estado.enviarAlPanel = (obj) => C.enviarEnTrozos((t) => Office.context.ui.messageParent(t), obj);
  Office.context.ui.addHandlerAsync(Office.EventType.DialogParentMessageReceived, (arg) => recibir(arg.message), (r) => {
    if (r.status !== Office.AsyncResultStatus.Succeeded) {
      vacio('No se pudo conectar con Outlook.');
      avisar('error', 'No se pudo conectar con Outlook. Cierra esta ventana y pulsa otra vez «Firmar y responder».', r.error && r.error.message);
      return;
    }
    estado.enviarAlPanel({ tipo: 'listo' });
  });
}
function alRecibirDelPanel(m) {
  if (!m) return;
  if (m.tipo === 'inicio') {
    $('asunto').textContent = m.asunto ? 'Correo: ' + m.asunto : '';
    $('asunto').title = m.asunto || '';
    estado.docs = (m.adjuntos || []).map((a) => ({ id: a.id, nombre: a.nombre, tam: a.tam, bytes: null, error: null, pdf: null, paginas: null, sello: null }));
    if (!estado.docs.length) vacio('Este correo no tiene PDF adjuntos.');
    pintarPestanas();
  } else if (m.tipo === 'adjunto') {
    const i = estado.docs.findIndex((d) => d.id === m.id);
    if (i < 0) return;
    const d = estado.docs[i];
    if (m.error) d.error = 'No se pudo traer «' + d.nombre + '» de Outlook: ' + m.error;
    else d.bytes = F.util.deBase64(m.base64);
    if (estado.actual < 0 || estado.actual === i) abrirDocumento(i);
  } else if (m.tipo === 'error') {
    estado.enviado = false;
    ocupado(false);
    avisar('error', m.mensaje, m.detalle);
  }
}

// ------------------------------------------------------------------ modo suelto (fuera de Outlook)
async function cargarPdfsSueltos(lista) {
  const pdfs = Array.from(lista || []).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!pdfs.length) { avisar('error', 'Elige un archivo PDF.'); return; }
  let primero = -1;
  for (const f of pdfs) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    estado.docs.push({ id: 'local-' + estado.docs.length, nombre: f.name, tam: f.size, bytes: bytes, error: null, pdf: null, paginas: null, sello: null });
    if (primero < 0) primero = estado.docs.length - 1;
  }
  limpiarAviso();
  abrirDocumento(primero);
}

// ------------------------------------------------------------------ arranque
function conectarControles() {
  $('btnResponder').addEventListener('click', () => firmar('remitente'));
  $('btnResponderTodos').addEventListener('click', () => firmar('todos'));
  $('btnDescargar').addEventListener('click', () => firmar('descargar'));
  $('btnElegirP12').addEventListener('click', () => $('archivoP12').click());
  $('btnCambiarP12').addEventListener('click', () => $('archivoP12').click());
  $('btnQuitarP12').addEventListener('click', quitarP12);
  $('archivoP12').addEventListener('change', alElegirP12);
  $('btnElegirPdf').addEventListener('click', () => $('archivoPdf').click());
  $('archivoPdf').addEventListener('change', (ev) => { cargarPdfsSueltos(ev.target.files); ev.target.value = ''; });
  $('btnVerClave').addEventListener('click', () => {
    const c = $('clave');
    c.type = c.type === 'password' ? 'text' : 'password';
    $('btnVerClave').textContent = c.type === 'password' ? 'Ver' : 'Ocultar';
    c.focus();
  });
  $('clave').addEventListener('input', () => limpiarAviso());
  $('btnUltima').addEventListener('click', () => {
    const d = estado.docs[estado.actual];
    // al pie de la ultima pagina, que es donde casi siempre van las firmas
    if (d && d.paginas) d.paginas[d.paginas.length - 1].div.scrollIntoView({ block: 'end' });
  });
  $('btnCerrar').addEventListener('click', () => { if (estado.enviarAlPanel) estado.enviarAlPanel({ tipo: 'cerrar' }); });
  const cont = $('paginas');
  cont.addEventListener('dragover', (ev) => {
    if (estado.modo !== 'suelto') return;
    ev.preventDefault();
    const v = $('vacio');
    if (v) v.classList.add('soltar');
  });
  cont.addEventListener('dragleave', () => { const v = $('vacio'); if (v) v.classList.remove('soltar'); });
  cont.addEventListener('drop', (ev) => {
    if (estado.modo !== 'suelto') return;
    ev.preventDefault();
    cargarPdfsSueltos(ev.dataTransfer.files);
  });
  let espera = null;
  window.addEventListener('resize', () => {
    clearTimeout(espera);
    espera = setTimeout(() => {
      const d = estado.docs[estado.actual];
      if (d && d.paginas) dibujarDocumento(d, false);
    }, 200);
  });
}

async function iniciar() {
  $('version').textContent = 'v' + F.VERSION;
  conectarControles();
  const pref = (await C.almacen.leer('preferencias')) || {};
  estado.posicion = pref.posicion || null;
  estado.firmante = pref.firmante || '';
  $('mensaje').value = (typeof pref.mensaje === 'string' && pref.mensaje.trim()) ? pref.mensaje : saludo();
  const p12 = await C.almacen.leer('p12');
  if (p12 && p12.bytes) ponerP12(p12.nombre, new Uint8Array(p12.bytes), false);
  else estado.firmante = '';
  pintarFirmante();

  const modo = await esperarOffice();
  if (modo === 'outlook') {
    estado.modo = 'outlook';
    document.body.classList.add('modo-outlook');
    vacio('Trayendo el PDF del correo…', true);
    conectarConPanel();
  } else if (modo === 'fallo') {
    estado.modo = 'outlook';
    document.body.classList.add('modo-outlook');
    vacio('No se pudo conectar con Outlook.');
    avisar('error', 'No se pudo conectar con Outlook (no cargó su librería). Revisa tu conexión a internet, cierra esta ventana y pulsa otra vez «Firmar y responder».');
  } else {
    estado.modo = 'suelto';
    document.body.classList.add('modo-suelto');
    vacio('Elige un PDF para firmarlo, o arrástralo aquí.', false, true);
  }
  if (estado.p12) $('clave').focus();
}

iniciar().catch((e) => avisar('error', 'La ventana de firma no pudo arrancar.', (e && (e.stack || e.message)) || String(e)));
