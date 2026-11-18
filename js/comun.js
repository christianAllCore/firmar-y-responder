/*
 * Firmar y responder - piezas comunes del panel de Outlook y de la ventana de firma.
 */
(function (raiz) {
  'use strict';

  // ---------------------------------------------------------------- mensajes entre panel y ventana
  // Office pasa texto entre el panel y la ventana de firma; un PDF puede pesar varios MB, asi que
  // los mensajes grandes se parten en trozos y se vuelven a juntar del otro lado.
  const TROZO = 512 * 1024;

  function enviarEnTrozos(enviar, objeto) {
    const texto = JSON.stringify(objeto);
    if (texto.length <= TROZO) { enviar(texto); return; }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const n = Math.ceil(texto.length / TROZO);
    for (let i = 0; i < n; i++) enviar(JSON.stringify({ __trozo: id, i: i, n: n, d: texto.substr(i * TROZO, TROZO) }));
  }

  function receptor(alRecibir) {
    const pendientes = {};
    return function (texto) {
      let m;
      try { m = JSON.parse(texto); } catch (e) { return; }
      if (m && m.__trozo) {
        const p = pendientes[m.__trozo] || (pendientes[m.__trozo] = { partes: new Array(m.n), recibidos: 0 });
        if (p.partes[m.i] === undefined) { p.partes[m.i] = m.d; p.recibidos++; }
        if (p.recibidos === m.n) {
          delete pendientes[m.__trozo];
          let completo;
          try { completo = JSON.parse(p.partes.join('')); } catch (e) { return; }
          alRecibir(completo);
        }
        return;
      }
      alRecibir(m);
    };
  }

  // ---------------------------------------------------------------- memoria del navegador
  // Guarda el archivo .p12 (tal cual, protegido por su propia clave) y las preferencias.
  // La CLAVE nunca se guarda. Si el navegador no deja guardar, se pide el archivo cada vez.
  const BASE = 'firmar-y-responder', TABLA = 'datos';
  let promesaBase = null;
  const enMemoria = {};

  function abrirBase() {
    if (promesaBase) return promesaBase;
    promesaBase = new Promise(function (ok) {
      try {
        if (!raiz.indexedDB) { ok(null); return; }
        const pedido = raiz.indexedDB.open(BASE, 1);
        pedido.onupgradeneeded = function () { pedido.result.createObjectStore(TABLA); };
        pedido.onsuccess = function () { ok(pedido.result); };
        pedido.onerror = function () { ok(null); };
        pedido.onblocked = function () { ok(null); };
      } catch (e) { ok(null); }
    });
    return promesaBase;
  }
  function operar(modo, accion) {
    return abrirBase().then(function (db) {
      if (!db) return undefined;
      return new Promise(function (ok) {
        try {
          const tx = db.transaction(TABLA, modo);
          const pedido = accion(tx.objectStore(TABLA));
          tx.oncomplete = function () { ok(pedido ? pedido.result : undefined); };
          tx.onerror = function () { ok(undefined); };
          tx.onabort = function () { ok(undefined); };
        } catch (e) { ok(undefined); }
      });
    });
  }
  const almacen = {
    leer: function (clave) {
      return operar('readonly', function (t) { return t.get(clave); }).then(function (v) {
        return v === undefined ? enMemoria[clave] : v;
      });
    },
    guardar: function (clave, valor) {
      enMemoria[clave] = valor;
      return operar('readwrite', function (t) { return t.put(valor, clave); });
    },
    borrar: function (clave) {
      delete enMemoria[clave];
      return operar('readwrite', function (t) { return t.delete(clave); });
    }
  };

  // ---------------------------------------------------------------- utilidades
  function escaparHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function tamano(bytes) {
    if (!(bytes >= 0)) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  }
  function nombreFirmado(nombre) {
    // Igual que FirmaEC: "documento.pdf" -> "documento-signed.pdf"
    const base = String(nombre || 'documento.pdf').replace(/\.pdf$/i, '');
    return base + '-signed.pdf';
  }

  raiz.Comun = {
    enviarEnTrozos: enviarEnTrozos,
    receptor: receptor,
    almacen: almacen,
    escaparHtml: escaparHtml,
    tamano: tamano,
    nombreFirmado: nombreFirmado
  };
})(typeof self !== 'undefined' ? self : this);
