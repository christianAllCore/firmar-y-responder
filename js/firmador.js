/*
 * Firmar y responder - nucleo de firma electronica de PDF.
 *
 * Firma PAdES basica (SubFilter adbe.pkcs7.detached, SHA-256), el mismo tipo que produce FirmaEC
 * (iText con CryptoStandard.CMS), con sello visible al estilo FirmaEC: QR a la izquierda,
 * "Firmado electronicamente por:" y el nombre en negrita (110 x 36 puntos).
 *
 * La firma se AGREGA al final del archivo (actualizacion incremental): no se reescribe nada de lo
 * que el PDF ya tenia, asi las firmas anteriores (de otras personas) siguen siendo validas.
 *
 * Todo ocurre en memoria, en el navegador: el .p12 y la clave nunca se envian a ninguna parte.
 *
 * Uso:
 *   navegador:  <script src="lib/pdf-lib.min.js">, lib/forge.min.js, lib/qrcode.js y este archivo
 *               -> window.Firmador
 *   Node:       const Firmador = require('./firmador.js')(PDFLib, forge, qrcode)
 */
(function (raiz) {
  'use strict';

  function crearFirmador(PDFLib, forge, qrcode) {
    const PDFDocument = PDFLib.PDFDocument;
    const PDFName = PDFLib.PDFName;
    const PDFRef = PDFLib.PDFRef;
    const PDFDict = PDFLib.PDFDict;
    const PDFArray = PDFLib.PDFArray;
    const PDFNumber = PDFLib.PDFNumber;
    const PDFRawStream = PDFLib.PDFRawStream;
    const PDFObjectParser = PDFLib.PDFObjectParser;

    // Medidas y textos del sello tal como lo deja FirmaEC 5.1.0 (revisado en PDF reales firmados con el):
    // 110 x 36 puntos, QR de 36 x 36 a la izquierda (sin margen), texto desde x = 36.67, letras de 3.25 y 6.25.
    const VERSION = '1.0';
    const SELLO = { ancho: 110, alto: 36, letraChica: 3.25, letraNombre: 6.25 };
    const VALIDAR_CON = 'VALIDAR CON: https://www.firmadigital.gob.ec';
    const HECHO_CON = 'Firmado digitalmente con Firmar y responder ' + VERSION;
    // FirmaEC 5.1.0 resume el documento con SHA-512 (visto en sus firmas); se hace igual.
    const RESUMEN = { webcrypto: 'SHA-512', forge: 'sha512', oid: '2.16.840.1.101.3.4.2.3', largo: 64 };

    // ------------------------------------------------------------------ errores en palabras claras
    class ErrorFirma extends Error {
      constructor(codigo, mensaje, detalle) {
        super(mensaje);
        this.name = 'ErrorFirma';
        this.codigo = codigo;
        this.detalle = detalle ? String(detalle) : '';
      }
    }

    // ------------------------------------------------------------------ bytes
    function bytesLatin1(texto) {
      const b = new Uint8Array(texto.length);
      for (let i = 0; i < texto.length; i++) b[i] = texto.charCodeAt(i) & 0xff;
      return b;
    }
    function binarioDeBytes(u8) {
      let s = '';
      const T = 0x8000;
      for (let i = 0; i < u8.length; i += T) s += String.fromCharCode.apply(null, u8.subarray(i, i + T));
      return s;
    }
    function unir(partes) {
      let n = 0;
      for (const p of partes) n += p.length;
      const r = new Uint8Array(n);
      let o = 0;
      for (const p of partes) { r.set(p, o); o += p.length; }
      return r;
    }
    function aHex(u8) {
      const h = '0123456789ABCDEF';
      let s = '';
      for (let i = 0; i < u8.length; i++) s += h[u8[i] >> 4] + h[u8[i] & 15];
      return s;
    }
    function aBase64(u8) {
      if (typeof btoa === 'function') return btoa(binarioDeBytes(u8));
      return Buffer.from(u8).toString('base64');
    }
    function deBase64(b64) {
      if (typeof atob === 'function') return bytesLatin1(atob(b64));
      return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    function compararBytes(a, b) {
      // Orden DER de un SET OF: se comparan como cadenas de octetos, rellenando la mas corta con ceros.
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const x = i < a.length ? a[i] : 0, y = i < b.length ? b[i] : 0;
        if (x !== y) return x - y;
      }
      return 0;
    }

    // ------------------------------------------------------------------ DER (lo minimo para CMS)
    function derLongitud(n) {
      if (n < 0x80) return [n];
      const b = [];
      while (n > 0) { b.unshift(n & 0xff); n = Math.floor(n / 256); }
      return [0x80 | b.length].concat(b);
    }
    function tlv(etiqueta, contenido) {
      const cab = [etiqueta].concat(derLongitud(contenido.length));
      const r = new Uint8Array(cab.length + contenido.length);
      r.set(cab, 0);
      r.set(contenido, cab.length);
      return r;
    }
    function oidBytes(texto) {
      const p = texto.split('.').map(Number);
      const out = [40 * p[0] + p[1]];
      for (let i = 2; i < p.length; i++) {
        let v = p[i];
        const tmp = [v & 0x7f];
        v = Math.floor(v / 128);
        while (v > 0) { tmp.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
        out.push.apply(out, tmp);
      }
      return new Uint8Array(out);
    }
    function dos(n) { return String(n).padStart(2, '0'); }
    function utcTime(d) {
      return dos(d.getUTCFullYear() % 100) + dos(d.getUTCMonth() + 1) + dos(d.getUTCDate()) +
        dos(d.getUTCHours()) + dos(d.getUTCMinutes()) + dos(d.getUTCSeconds()) + 'Z';
    }
    const der = {
      seq: function () { return tlv(0x30, unir(Array.prototype.slice.call(arguments))); },
      set: function () { return tlv(0x31, unir(Array.prototype.slice.call(arguments))); },
      oid: function (t) { return tlv(0x06, oidBytes(t)); },
      nulo: function () { return new Uint8Array([0x05, 0x00]); },
      octetos: function (u8) { return tlv(0x04, u8); },
      entero: function (n) { return tlv(0x02, new Uint8Array([n])); }, // solo 0..127
      utc: function (d) { return tlv(0x17, bytesLatin1(utcTime(d))); }
    };
    const OID = {
      data: '1.2.840.113549.1.7.1',
      signedData: '1.2.840.113549.1.7.2',
      contentType: '1.2.840.113549.1.9.3',
      messageDigest: '1.2.840.113549.1.9.4',
      signingTime: '1.2.840.113549.1.9.5',
      signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
      sha256: '2.16.840.1.101.3.4.2.1',
      rsaEncryption: '1.2.840.113549.1.1.1',
      cn: '2.5.4.3',
      nombres: '2.5.4.42',
      apellidos: '2.5.4.4',
      cedula: '2.5.4.5'
    };

    function derNodo(b, pos) {
      const etiqueta = b[pos];
      let p = pos + 1;
      let lon = b[p++];
      if (lon & 0x80) {
        const n = lon & 0x7f;
        if (n < 1 || n > 4) throw new Error('Longitud DER no soportada');
        lon = 0;
        for (let i = 0; i < n; i++) lon = lon * 256 + b[p++];
      }
      return { etiqueta: etiqueta, inicio: pos, valor: p, fin: p + lon };
    }
    function derHijos(b, nodo) {
      const r = [];
      let p = nodo.valor;
      while (p < nodo.fin) { const h = derNodo(b, p); r.push(h); p = h.fin; }
      return r;
    }
    function oidTexto(u8) {
      const p = [Math.floor(u8[0] / 40), u8[0] % 40];
      let v = 0;
      for (let i = 1; i < u8.length; i++) {
        v = v * 128 + (u8[i] & 0x7f);
        if (!(u8[i] & 0x80)) { p.push(v); v = 0; }
      }
      return p.join('.');
    }
    function textoDer(etiqueta, u8) {
      if (etiqueta === 0x0c) return new TextDecoder('utf-8').decode(u8);
      if (etiqueta === 0x1e) {
        let s = '';
        for (let i = 0; i + 1 < u8.length; i += 2) s += String.fromCharCode((u8[i] << 8) | u8[i + 1]);
        return s;
      }
      return binarioDeBytes(u8);
    }
    function leerNombreDer(b, nodo) {
      const res = {};
      for (const rdn of derHijos(b, nodo)) {
        for (const atv of derHijos(b, rdn)) {
          const h = derHijos(b, atv);
          if (h.length < 2) continue;
          const clave = oidTexto(b.subarray(h[0].valor, h[0].fin));
          if (!(clave in res)) res[clave] = textoDer(h[1].etiqueta, b.subarray(h[1].valor, h[1].fin));
        }
      }
      return res;
    }
    function piezasCertificado(certDer) {
      const c = derNodo(certDer, 0);
      const tbs = derHijos(certDer, c)[0];
      const campos = derHijos(certDer, tbs);
      const i = campos[0].etiqueta === 0xa0 ? 1 : 0;
      const serie = campos[i], emisor = campos[i + 2], sujeto = campos[i + 4];
      return {
        serieDer: certDer.slice(serie.inicio, serie.fin),
        emisorDer: certDer.slice(emisor.inicio, emisor.fin),
        sujetoDer: certDer.slice(sujeto.inicio, sujeto.fin),
        sujeto: leerNombreDer(certDer, sujeto),
        emisor: leerNombreDer(certDer, emisor)
      };
    }
    function mismosBytes(a, b) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    // ------------------------------------------------------------------ resumen y firma RSA
    function subtle() {
      return (typeof crypto !== 'undefined' && crypto && crypto.subtle) ? crypto.subtle : null;
    }
    async function resumirCon(algoritmo, datos) {
      const s = subtle();
      if (s) return new Uint8Array(await s.digest(algoritmo === 'sha512' ? 'SHA-512' : 'SHA-256', datos));
      const md = forge.md[algoritmo].create();
      md.update(binarioDeBytes(datos));
      return bytesLatin1(md.digest().getBytes());
    }
    function sha256(datos) { return resumirCon('sha256', datos); }
    function resumirDocumento(datos) { return resumirCon(RESUMEN.forge, datos); }
    async function firmarRsa(llave, datos) {
      const s = subtle();
      if (s) {
        try {
          const pkcs8 = bytesLatin1(forge.asn1.toDer(
            forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(llave))).getBytes());
          const k = await s.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: RESUMEN.webcrypto }, false, ['sign']);
          return new Uint8Array(await s.sign('RSASSA-PKCS1-v1_5', k, datos));
        } catch (e) { /* si el navegador no acepta la llave, se firma con forge */ }
      }
      const md = forge.md[RESUMEN.forge].create();
      md.update(binarioDeBytes(datos));
      return bytesLatin1(llave.sign(md));
    }

    // ------------------------------------------------------------------ archivo .p12
    function abrirP12(p12Entrada, clave) {
      const p12Bytes = p12Entrada instanceof Uint8Array ? p12Entrada : new Uint8Array(p12Entrada);
      const asn1 = forge.asn1, pki = forge.pki;
      if (!p12Bytes.length) throw new ErrorFirma('P12', 'El archivo de firma esta vacio.');

      let estructura;
      try {
        estructura = asn1.fromDer(binarioDeBytes(p12Bytes), { strict: false, parseAllBytes: false, decodeBitStrings: true });
      } catch (e) {
        throw new ErrorFirma('P12', 'Ese archivo no parece una firma electronica .p12.', e && e.message);
      }

      // forge rehace cada certificado al leerlo; para meterlos en la firma se guardan los bytes ORIGINALES
      // (si se rehicieran distinto, la cadena de confianza dejaria de validar).
      const crudos = new WeakMap();
      const fromDerOriginal = asn1.fromDer;
      const certificadoOriginal = pki.certificateFromAsn1;
      asn1.fromDer = function (entrada) {
        let bin = null;
        try {
          if (typeof entrada === 'string') bin = entrada;
          else if (entrada && typeof entrada.bytes === 'function') bin = entrada.bytes();
        } catch (e) { bin = null; }
        const r = fromDerOriginal.apply(this, arguments);
        if (bin !== null && r && typeof r === 'object') crudos.set(r, bin);
        return r;
      };
      pki.certificateFromAsn1 = function (obj) {
        const cert = certificadoOriginal.apply(this, arguments);
        const bin = crudos.get(obj);
        if (bin && cert) cert.__derOriginal = bin;
        return cert;
      };

      let p12;
      try {
        p12 = forge.pkcs12.pkcs12FromAsn1(estructura, false, clave || '');
      } catch (e) {
        const m = String((e && e.message) || e);
        if (/MAC could not be verified|Invalid password|wrong password|decrypt|Too few bytes|Unparsed DER|padding/i.test(m)) {
          throw new ErrorFirma('CLAVE', 'La clave no es correcta.', m);
        }
        throw new ErrorFirma('P12', 'No se pudo leer el archivo de firma (.p12).', m);
      } finally {
        asn1.fromDer = fromDerOriginal;
        pki.certificateFromAsn1 = certificadoOriginal;
      }

      const llaves = [], certs = [];
      for (const sc of p12.safeContents) {
        for (const bag of sc.safeBags) {
          if (bag.type === pki.oids.pkcs8ShroudedKeyBag || bag.type === pki.oids.keyBag) llaves.push(bag);
          else if (bag.type === pki.oids.certBag) certs.push(bag);
        }
      }
      const bagLlave = llaves.find(function (b) { return b.key && b.key.n; });
      if (!bagLlave) {
        throw new ErrorFirma('P12_SIN_LLAVE', llaves.length
          ? 'Tu firma usa un tipo de llave que este programa no maneja (no es RSA).'
          : 'El archivo .p12 no trae la llave privada, solo certificados.');
      }
      const llave = bagLlave.key;

      const lista = [];
      for (const b of certs) {
        let bin = null;
        if (b.cert) bin = b.cert.__derOriginal || asn1.toDer(pki.certificateToAsn1(b.cert)).getBytes();
        else if (b.asn1) bin = crudos.get(b.asn1) || asn1.toDer(b.asn1).getBytes();
        if (bin) lista.push({ cert: b.cert, der: bytesLatin1(bin) });
      }
      const propio = lista.find(function (c) {
        return c.cert && c.cert.publicKey && c.cert.publicKey.n && c.cert.publicKey.n.toString(16) === llave.n.toString(16);
      });
      if (!propio) throw new ErrorFirma('P12_SIN_CERT', 'El archivo .p12 no trae el certificado que corresponde a la llave.');

      // Cadena: el propio y luego cada emisor hasta la raiz; lo que sobre, al final.
      const piezas = lista.map(function (c) { return piezasCertificado(c.der); });
      const usados = new Set([lista.indexOf(propio)]);
      const cadena = [propio.der];
      let actual = piezas[lista.indexOf(propio)];
      for (let vuelta = 0; vuelta < lista.length; vuelta++) {
        const k = piezas.findIndex(function (p, i) { return !usados.has(i) && mismosBytes(p.sujetoDer, actual.emisorDer); });
        if (k < 0) break;
        usados.add(k);
        cadena.push(lista[k].der);
        actual = piezas[k];
      }
      lista.forEach(function (c, i) { if (!usados.has(i)) cadena.push(c.der); });

      const p = piezas[lista.indexOf(propio)];
      const s = p.sujeto;
      let nombre = (s[OID.cn] || '').trim();
      if (!nombre) nombre = ((s[OID.nombres] || '') + ' ' + (s[OID.apellidos] || '')).trim();
      if (!nombre) nombre = 'FIRMANTE';
      return {
        llave: llave,
        certDer: propio.der,
        cadena: cadena,
        nombre: nombre.toUpperCase().replace(/\s+/g, ' '),
        emisor: (p.emisor[OID.cn] || '').trim(),
        desde: propio.cert.validity.notBefore,
        hasta: propio.cert.validity.notAfter
      };
    }

    function revisarVigencia(identidad, ahora) {
      const hoy = ahora || new Date();
      const f = function (d) { return dos(d.getDate()) + '/' + dos(d.getMonth() + 1) + '/' + d.getFullYear(); };
      if (identidad.hasta && hoy > identidad.hasta) {
        throw new ErrorFirma('VENCIDA', 'Tu firma electronica vencio el ' + f(identidad.hasta) +
          '. Hay que renovarla con ' + (identidad.emisor || 'la entidad que la emitio') + '.');
      }
      if (identidad.desde && hoy < identidad.desde) {
        throw new ErrorFirma('NO_VIGENTE', 'Tu firma electronica recien sera valida desde el ' + f(identidad.desde) + '.');
      }
    }

    // ------------------------------------------------------------------ CMS (PKCS#7) separado
    async function construirCms(identidad, resumen, fecha, firmaDePrueba) {
      const p = piezasCertificado(identidad.certDer);
      const hashCert = await sha256(identidad.certDer);
      const atributos = [
        der.seq(der.oid(OID.contentType), der.set(der.oid(OID.data))),
        der.seq(der.oid(OID.signingTime), der.set(der.utc(fecha))),
        der.seq(der.oid(OID.messageDigest), der.set(der.octetos(resumen))),
        der.seq(der.oid(OID.signingCertificateV2), der.set(
          der.seq(                                   // SigningCertificateV2
            der.seq(                                 //   certs
              der.seq(                               //     ESSCertIDv2 (hash SHA-256 por omision)
                der.octetos(hashCert),
                der.seq(der.seq(tlv(0xa4, p.emisorDer)), p.serieDer))))))
      ];
      const contenidoAtributos = unir(atributos.slice().sort(compararBytes));
      const firma = firmaDePrueba || await firmarRsa(identidad.llave, tlv(0x31, contenidoAtributos));
      const signerInfo = der.seq(
        der.entero(1),
        der.seq(p.emisorDer, p.serieDer),
        der.seq(der.oid(RESUMEN.oid), der.nulo()),
        tlv(0xa0, contenidoAtributos),
        der.seq(der.oid(OID.rsaEncryption), der.nulo()),
        der.octetos(firma));
      const signedData = der.seq(
        der.entero(1),
        der.set(der.seq(der.oid(RESUMEN.oid), der.nulo())),
        der.seq(der.oid(OID.data)),
        tlv(0xa0, unir(identidad.cadena)),
        der.set(signerInfo));
      return der.seq(der.oid(OID.signedData), tlv(0xa0, signedData));
    }

    // ------------------------------------------------------------------ sello visible
    function crearQr(texto) {
      const anterior = qrcode.stringToBytes;
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      try {
        const q = qrcode(0, 'L');
        q.addData(texto, 'Byte');
        q.make();
        return q;
      } finally {
        qrcode.stringToBytes = anterior;
      }
    }
    function fechaIso(d) {
      const off = -d.getTimezoneOffset();
      const a = Math.abs(off);
      return d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate()) + 'T' +
        dos(d.getHours()) + ':' + dos(d.getMinutes()) + ':' + dos(d.getSeconds()) + '.' +
        String(d.getMilliseconds()).padStart(3, '0') + (off >= 0 ? '+' : '-') + dos(Math.floor(a / 60)) + ':' + dos(a % 60);
    }
    function fechaPdf(d) {
      const off = -d.getTimezoneOffset();
      const a = Math.abs(off);
      return 'D:' + d.getFullYear() + dos(d.getMonth() + 1) + dos(d.getDate()) + dos(d.getHours()) +
        dos(d.getMinutes()) + dos(d.getSeconds()) + (off >= 0 ? '+' : '-') + dos(Math.floor(a / 60)) + "'" + dos(a % 60) + "'";
    }
    function textoQr(nombre, razon, lugar, fecha) {
      // Mismo formato que el QR de FirmaEC 5.1.0; la ultima linea dice con que programa se firmo.
      return 'FIRMADO POR: ' + nombre.trim() + '\n' +
        'RAZON: ' + (razon || '') + '\n' +
        'LOCALIZACION: ' + (lugar || '') + '\n' +
        'FECHA: ' + fechaIso(fecha) + '\n' +
        VALIDAR_CON + '\n' +
        HECHO_CON;
    }
    function partirLineas(texto, maxCaracteres) {
      const palabras = texto.trim().split(/\s+/);
      const lineas = [];
      let linea = '';
      for (let w of palabras) {
        while (w.length > maxCaracteres) {
          if (linea) { lineas.push(linea); linea = ''; }
          lineas.push(w.slice(0, maxCaracteres));
          w = w.slice(maxCaracteres);
        }
        if (!w) continue;
        if (!linea) linea = w;
        else if ((linea + ' ' + w).length <= maxCaracteres) linea += ' ' + w;
        else { lineas.push(linea); linea = w; }
      }
      if (linea) lineas.push(linea);
      return lineas;
    }
    /* Diseno del sello en coordenadas del sello (origen abajo a la izquierda, 110 x 36).
       Lo usan el PDF y la vista previa de la pantalla, para que se vean igual. */
    function disenoSello(nombre, textoDelQr) {
      const W = SELLO.ancho, H = SELLO.alto;
      const q = crearQr(textoDelQr);
      const n = q.getModuleCount();
      const modulos = [];
      for (let f = 0; f < n; f++) {
        const fila = [];
        for (let c = 0; c < n; c++) fila.push(q.isDark(f, c));
        modulos.push(fila);
      }
      const x0 = Math.round(W / 3 * 100) / 100;          // 36.67, como FirmaEC
      const anchoTexto = W - W / 3;
      // Courier: cada letra mide 0.6 del tamano de la letra (19 letras por linea con 6.25).
      // Separacion entre lineas medida en los sellos de FirmaEC 5.1.0: 4.28 entre las chicas,
      // 5.42 de la chica al nombre y 4.94 entre lineas del nombre.
      let tam = SELLO.letraNombre, lineasNombre, total;
      for (;;) {
        lineasNombre = partirLineas(nombre, Math.max(4, Math.floor(anchoTexto / (0.6 * tam))));
        total = 4.28 + 5.42 * tam / SELLO.letraNombre + (lineasNombre.length - 1) * 4.94 * tam / SELLO.letraNombre;
        if (total <= H - 9 || tam <= 3.5) break;
        tam -= 0.25;
      }
      const lineas = [
        { fuente: 'F1', tam: SELLO.letraChica, texto: 'Validar únicamente en FirmaEC.' },
        { fuente: 'F1', tam: SELLO.letraChica, texto: 'Firmado electrónicamente por:' }
      ];
      for (const l of lineasNombre) lineas.push({ fuente: 'F2', tam: tam, texto: l });
      // Con 2 lineas de nombre queda igual que FirmaEC: lineas base en 24.21, 19.93, 14.51 y 9.57.
      let y = H / 2 + total / 2 - 1.11;
      lineas.forEach(function (l, i) {
        if (i === 1) y -= 4.28;
        else if (i === 2) y -= 5.42 * tam / SELLO.letraNombre;
        else if (i > 2) y -= 4.94 * tam / SELLO.letraNombre;
        l.x = x0;
        l.y = Math.round(y * 100) / 100;
      });
      return { ancho: W, alto: H, qr: { modulos: modulos, lado: H, margen: 0 }, lineas: lineas };
    }

    const WINANSI_EXTRA = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
      0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
      0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
      0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
    function cadenaWinAnsi(s) {
      let r = '(';
      for (const ch of s) {
        let c = ch.codePointAt(0);
        if (c >= 0xa0 && c <= 0xff) { /* igual en WinAnsi */ } else if (WINANSI_EXTRA[c]) c = WINANSI_EXTRA[c];
        else if (c < 0x20 || c > 0x7e) c = 0x3f;
        if (c === 0x28 || c === 0x29 || c === 0x5c) r += '\\' + String.fromCharCode(c);
        else if (c >= 0x20 && c <= 0x7e) r += String.fromCharCode(c);
        else r += '\\' + c.toString(8).padStart(3, '0');
      }
      return r + ')';
    }
    function r3(n) {
      const v = Math.round(n * 1000) / 1000;
      return (Object.is(v, -0) ? 0 : v).toString();
    }
    function contenidoSello(d) {
      let c = 'q\n0 g\n';
      const m = d.qr.lado / (d.qr.modulos.length + 2 * d.qr.margen);
      const eps = 0.02; // un poco de traslape para que no aparezcan rayitas blancas entre modulos
      d.qr.modulos.forEach(function (fila, f) {
        let col = 0;
        while (col < fila.length) {
          if (!fila[col]) { col++; continue; }
          let fin = col;
          while (fin + 1 < fila.length && fila[fin + 1]) fin++;
          const x = (d.qr.margen + col) * m;
          const y = d.qr.lado - (d.qr.margen + f + 1) * m;
          c += r3(x) + ' ' + r3(y - eps) + ' ' + r3((fin - col + 1) * m + eps) + ' ' + r3(m + eps) + ' re\n';
          col = fin + 1;
        }
      });
      c += 'f\n';
      for (const l of d.lineas) {
        if (!l.texto) continue;
        c += 'BT /' + l.fuente + ' ' + r3(l.tam) + ' Tf ' + r3(l.x) + ' ' + r3(l.y) + ' Td ' + cadenaWinAnsi(l.texto) + ' Tj ET\n';
      }
      return c + 'Q\n';
    }
    function matrizRotacion(rotacion) {
      switch (((rotacion % 360) + 360) % 360) {
        case 90: return '0 1 -1 0 0 0';
        case 180: return '-1 0 0 -1 0 0';
        case 270: return '0 -1 1 0 0 0';
        default: return '1 0 0 1 0 0';
      }
    }

    // ------------------------------------------------------------------ lectura del PDF
    function esBlanco(c) { return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00; }
    function saltarBlancos(b, p) { while (p < b.length && esBlanco(b[p])) p++; return p; }
    function leerEntero(b, p) {
      let n = 0, k = p;
      while (k < b.length && b[k] >= 0x30 && b[k] <= 0x39) { n = n * 10 + (b[k] - 0x30); k++; }
      return k === p ? null : { valor: n, fin: k };
    }
    function empiezaCon(b, p, texto) {
      if (p + texto.length > b.length) return false;
      for (let i = 0; i < texto.length; i++) if (b[p + i] !== texto.charCodeAt(i)) return false;
      return true;
    }
    function buscarAtras(b, texto, desde) {
      let i = Math.min(desde === undefined ? b.length - texto.length : desde, b.length - texto.length);
      for (; i >= 0; i--) if (b[i] === texto.charCodeAt(0) && empiezaCon(b, i, texto)) return i;
      return -1;
    }
    function buscarAdelante(b, texto, desde) {
      for (let i = desde; i <= b.length - texto.length; i++) if (b[i] === texto.charCodeAt(0) && empiezaCon(b, i, texto)) return i;
      return -1;
    }
    function parsearObjetoEn(bytes, ctx, pos) {
      try {
        return PDFObjectParser.forBytes(bytes.subarray(pos), ctx).parseObject();
      } catch (e) {
        return null;
      }
    }
    function intentarIndice(bytes, ctx, pos) {
      if (pos < 0 || pos >= bytes.length) return null;
      const p = saltarBlancos(bytes, pos);
      if (empiezaCon(bytes, p, 'xref')) {
        const t = buscarAdelante(bytes, 'trailer', p);
        if (t < 0) return null;
        const dict = parsearObjetoEn(bytes, ctx, t + 7);
        return dict instanceof PDFDict ? { tipo: 'tabla', offset: p, dict: dict } : null;
      }
      const a = leerEntero(bytes, p);
      if (!a) return null;
      const g = leerEntero(bytes, saltarBlancos(bytes, a.fin));
      if (!g) return null;
      const q = saltarBlancos(bytes, g.fin);
      if (!empiezaCon(bytes, q, 'obj')) return null;
      const obj = parsearObjetoEn(bytes, ctx, q + 3);
      const dict = obj instanceof PDFRawStream ? obj.dict : (obj instanceof PDFDict ? obj : null);
      if (!dict || dict.get(PDFName.of('Type')) !== PDFName.of('XRef')) return null;
      return { tipo: 'flujo', offset: p, dict: dict };
    }
    function buscarIndiceAlternativo(bytes, ctx, hasta) {
      // startxref apunta mal (pasa con algunos programas): se busca el indice real mas cercano.
      let i = hasta;
      while ((i = buscarAtras(bytes, 'xref', i - 1)) > 0) {
        if (esBlanco(bytes[i - 1])) {
          const r = intentarIndice(bytes, ctx, i);
          if (r) return r;
        }
      }
      let j = hasta;
      while ((j = buscarAtras(bytes, '/XRef', j - 1)) > 0) {
        const desde = Math.max(0, j - 400);
        const ventana = binarioDeBytes(bytes.subarray(desde, j));
        const re = /(\d+)\s+(\d+)\s+obj/g;
        let m, ultima = -1;
        while ((m = re.exec(ventana))) ultima = m.index;
        if (ultima >= 0) {
          const r = intentarIndice(bytes, ctx, desde + ultima);
          if (r) return r;
        }
      }
      return null;
    }
    function leerUltimoIndice(bytes, ctx) {
      const sx = buscarAtras(bytes, 'startxref');
      if (sx < 0) throw new ErrorFirma('PDF_DANADO', 'El PDF esta incompleto o danado (le falta el indice final).');
      const n = leerEntero(bytes, saltarBlancos(bytes, sx + 9));
      let info = n ? intentarIndice(bytes, ctx, n.valor) : null;
      if (!info) info = buscarIndiceAlternativo(bytes, ctx, sx);
      if (!info) throw new ErrorFirma('PDF_DANADO', 'El indice interno del PDF esta danado: no se le puede agregar una firma sin estropearlo.');
      const d = info.dict;
      const t = ctx.trailerInfo || {};
      const tam = d.get(PDFName.of('Size'));
      return {
        tipo: info.tipo,
        offset: info.offset,
        size: tam instanceof PDFNumber ? tam.asNumber() : 0,
        root: d.get(PDFName.of('Root')) || t.Root,
        info: d.get(PDFName.of('Info')) || t.Info,
        id: d.get(PDFName.of('ID')) || t.ID,
        encrypt: d.get(PDFName.of('Encrypt')) || t.Encrypt
      };
    }
    function revisarCertificacion(ctx, catalogo) {
      const perms = ctx.lookup(catalogo.get(PDFName.of('Perms')));
      if (!(perms instanceof PDFDict)) return;
      const docmdp = ctx.lookup(perms.get(PDFName.of('DocMDP')));
      if (!(docmdp instanceof PDFDict)) return;
      const refs = ctx.lookup(docmdp.get(PDFName.of('Reference')));
      if (!(refs instanceof PDFArray)) return;
      for (let i = 0; i < refs.size(); i++) {
        const r = ctx.lookup(refs.get(i));
        if (!(r instanceof PDFDict)) continue;
        const tp = ctx.lookup(r.get(PDFName.of('TransformParams')));
        const p = tp instanceof PDFDict ? tp.get(PDFName.of('P')) : null;
        if (p instanceof PDFNumber && p.asNumber() === 1) {
          throw new ErrorFirma('PDF_CERTIFICADO', 'Quien hizo este PDF lo bloqueo para que no se le agreguen firmas: ' +
            'una firma nueva invalidaria la suya. Pide una version sin ese bloqueo.');
        }
      }
    }

    // ------------------------------------------------------------------ escritura
    function serializar(obj) {
      const b = new Uint8Array(obj.sizeInBytes());
      obj.copyBytesInto(b, 0);
      return b;
    }
    function copiarDict(ctx, dict) {
      const d = PDFDict.withContext(ctx);
      for (const par of dict.entries()) d.set(par[0], par[1]);
      return d;
    }
    function arregloMas(ctx, original, ref) {
      const a = PDFArray.withContext(ctx);
      if (original instanceof PDFArray) for (let i = 0; i < original.size(); i++) a.push(original.get(i));
      a.push(ref);
      return a;
    }
    function textoPdf(s) {
      if (/^[\x20-\x7e]*$/.test(s)) return '(' + s.replace(/[\\()]/g, '\\$&') + ')';
      let h = 'FEFF';
      for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
      return '<' + h + '>';
    }
    function refTexto(r) { return r.objectNumber + ' ' + r.generationNumber + ' R'; }
    function agruparEntradas(entradas) {
      const orden = entradas.slice().sort(function (a, b) { return a.num - b.num; });
      const grupos = [];
      for (const e of orden) {
        const g = grupos[grupos.length - 1];
        if (g && g.inicio + g.items.length === e.num) g.items.push(e);
        else grupos.push({ inicio: e.num, items: [e] });
      }
      return grupos;
    }

    async function abrirPdf(bytes) {
      try {
        return await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
      } catch (e) {
        throw new ErrorFirma('PDF_DANADO', 'No se pudo leer el PDF: parece danado o no es un PDF.', e && e.message);
      }
    }

    /*
     * Firma el PDF.
     *   op.identidad  lo que devuelve abrirP12
     *   op.pagina     indice de pagina (0 = primera)
     *   op.rect       [x1, y1, x2, y2] en coordenadas del PDF (puntos)
     *   op.rotacion   /Rotate de la pagina (0, 90, 180, 270): el sello se gira para verse derecho
     *   op.razon, op.lugar  opcionales (van en la firma y en el QR, como en FirmaEC)
     *   op.fecha      Date (por omision, ahora)
     * Devuelve los bytes del PDF firmado.
     */
    async function firmarPdf(entrada, op) {
      const pdf = entrada instanceof Uint8Array ? entrada : new Uint8Array(entrada);
      const identidad = op.identidad;
      const fecha = op.fecha || new Date();
      revisarVigencia(identidad, fecha);

      const doc = await abrirPdf(pdf);
      const ctx = doc.context;
      const indice = leerUltimoIndice(pdf, ctx);
      if (indice.encrypt || doc.isEncrypted) {
        throw new ErrorFirma('PDF_PROTEGIDO', 'Este PDF esta protegido (con clave o con permisos) y no se puede firmar aqui. ' +
          'Pide a quien lo envio una version sin proteccion.');
      }
      const catalogo = ctx.lookup(indice.root);
      if (!(catalogo instanceof PDFDict)) throw new ErrorFirma('PDF_DANADO', 'El PDF esta danado (no se encuentra su catalogo).');
      revisarCertificacion(ctx, catalogo);

      let paginas;
      try { paginas = doc.getPages(); } catch (e) {
        throw new ErrorFirma('PDF_DANADO', 'No se pudieron leer las paginas del PDF.', e && e.message);
      }
      if (!(op.pagina >= 0 && op.pagina < paginas.length)) throw new ErrorFirma('PAGINA', 'La pagina elegida para la firma no existe.');
      const pagina = paginas[op.pagina];
      const refPagina = pagina.ref;
      const dictPagina = pagina.node;
      const rect = op.rect.map(Number);
      if (rect.length !== 4 || rect.some(function (v) { return !isFinite(v); })) throw new ErrorFirma('POSICION', 'No se sabe donde poner la firma.');

      let siguiente = Math.max(indice.size || 0, ctx.largestObjectNumber + 1);
      const numSello = siguiente++, numFirma = siguiente++, numCampo = siguiente++;
      const refCampo = PDFRef.of(numCampo, 0);
      const objetos = [];

      // Nombre del campo, sin repetir los que ya tenga el PDF (Firma1, Firma2, ...)
      const acroCrudo = catalogo.get(PDFName.of('AcroForm'));
      const acro = ctx.lookup(acroCrudo);
      const camposCrudo = acro instanceof PDFDict ? acro.get(PDFName.of('Fields')) : undefined;
      const campos = ctx.lookup(camposCrudo);
      const usados = new Set();
      if (campos instanceof PDFArray) {
        for (let i = 0; i < campos.size(); i++) {
          const f = ctx.lookup(campos.get(i));
          const t = f instanceof PDFDict ? f.get(PDFName.of('T')) : null;
          if (t && typeof t.decodeText === 'function') { try { usados.add(t.decodeText()); } catch (e) { /* nada */ } }
        }
      }
      // Mismo nombre que pone FirmaEC (iText): Signature1, Signature2, ...
      let k = 1;
      while (usados.has('Signature' + k)) k++;
      const nombreCampo = 'Signature' + k;

      // 1) apariencia del sello
      const diseno = disenoSello(identidad.nombre, textoQr(identidad.nombre, op.razon, op.lugar, fecha));
      const contenido = contenidoSello(diseno);
      const dictSello = '<< /Type /XObject /Subtype /Form /BBox [0 0 ' + diseno.ancho + ' ' + diseno.alto + ']' +
        ' /Matrix [' + matrizRotacion(op.rotacion || 0) + ']' +
        ' /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>' +
        ' /F2 << /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >> >> /ProcSet [/PDF /Text] >>' +
        ' /Length ' + contenido.length + ' >>';
      objetos.push({ num: numSello, gen: 0, bytes: bytesLatin1(dictSello + '\nstream\n' + contenido + '\nendstream') });

      // 2) diccionario de la firma, con espacio reservado para el PKCS#7
      const largoFirmaRsa = Math.ceil(identidad.llave.n.bitLength() / 8);
      const tamCms = (await construirCms(identidad, new Uint8Array(RESUMEN.largo), fecha, new Uint8Array(largoFirmaRsa))).length;
      const reservado = tamCms + 256;
      const moldeRango = '[0 0000000000 0000000000 0000000000]';
      const cab = '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange ';
      const medio = ' /Contents <';
      const ceros = '0'.repeat(reservado * 2);
      const cola = '> /M ' + textoPdf(fechaPdf(fecha)) + ' /Name ' + textoPdf(identidad.nombre) +
        ' /Reason ' + textoPdf(op.razon || '') + ' /Location ' + textoPdf(op.lugar || '') + ' /ContactInfo ()' +
        ' /Prop_Build << /App << /Name /' + ('Firmar y responder ' + VERSION).replace(/ /g, '#20') + ' >> >> >>';
      objetos.push({
        num: numFirma, gen: 0, bytes: bytesLatin1(cab + moldeRango + medio + ceros + cola),
        marcas: {
          rango: cab.length,
          abre: cab.length + moldeRango.length + medio.length - 1,             // posicion de '<'
          cierra: cab.length + moldeRango.length + medio.length + ceros.length // posicion de '>'
        }
      });

      // 3) el campo de firma con su anotacion (widget)
      objetos.push({
        num: numCampo, gen: 0, bytes: bytesLatin1('<< /Type /Annot /Subtype /Widget /FT /Sig /T ' + textoPdf(nombreCampo) +
          ' /V ' + numFirma + ' 0 R /F 132 /P ' + refTexto(refPagina) + ' /Rect [' + rect.map(r3).join(' ') + ']' +
          ' /AP << /N ' + numSello + ' 0 R >> >>')
      });

      // 4) la pagina (o su lista de anotaciones) con el campo nuevo
      const annots = dictPagina.get(PDFName.of('Annots'));
      if (annots instanceof PDFRef) {
        objetos.push({ num: annots.objectNumber, gen: annots.generationNumber, bytes: serializar(arregloMas(ctx, ctx.lookup(annots), refCampo)) });
      } else {
        const copia = copiarDict(ctx, dictPagina);
        copia.set(PDFName.of('Annots'), arregloMas(ctx, annots, refCampo));
        objetos.push({ num: refPagina.objectNumber, gen: refPagina.generationNumber, bytes: serializar(copia) });
      }

      // 5) el formulario del documento (AcroForm) con el campo nuevo y SigFlags 3
      const ajustarAcro = function (dictAcro) {
        const copia = copiarDict(ctx, dictAcro);
        const fc = dictAcro.get(PDFName.of('Fields'));
        if (fc instanceof PDFRef) {
          objetos.push({ num: fc.objectNumber, gen: fc.generationNumber, bytes: serializar(arregloMas(ctx, ctx.lookup(fc), refCampo)) });
        } else {
          copia.set(PDFName.of('Fields'), arregloMas(ctx, fc, refCampo));
        }
        copia.set(PDFName.of('SigFlags'), PDFNumber.of(3));
        return copia;
      };
      if (acroCrudo instanceof PDFRef && acro instanceof PDFDict) {
        objetos.push({ num: acroCrudo.objectNumber, gen: acroCrudo.generationNumber, bytes: serializar(ajustarAcro(acro)) });
      } else {
        const copiaCat = copiarDict(ctx, catalogo);
        if (acro instanceof PDFDict) {
          copiaCat.set(PDFName.of('AcroForm'), ajustarAcro(acro));
        } else {
          const numAcro = siguiente++;
          objetos.push({ num: numAcro, gen: 0, bytes: bytesLatin1('<< /Fields [' + numCampo + ' 0 R] /SigFlags 3 >>') });
          copiaCat.set(PDFName.of('AcroForm'), PDFRef.of(numAcro, 0));
        }
        objetos.push({ num: indice.root.objectNumber, gen: indice.root.generationNumber, bytes: serializar(copiaCat) });
      }

      // ---- actualizacion incremental: se agrega al final, sin tocar nada de lo anterior
      const partes = [pdf];
      let largo = pdf.length;
      const ultimoByte = pdf[pdf.length - 1];
      if (ultimoByte !== 0x0a && ultimoByte !== 0x0d) { const nl = bytesLatin1('\n'); partes.push(nl); largo += nl.length; }
      const entradas = [];
      let inicioFirma = -1, marcas = null;
      for (const o of objetos) {
        const encabezado = bytesLatin1(o.num + ' ' + o.gen + ' obj\n');
        const pie = bytesLatin1('\nendobj\n');
        entradas.push({ num: o.num, gen: o.gen, offset: largo });
        if (o.marcas) { inicioFirma = largo + encabezado.length; marcas = o.marcas; }
        partes.push(encabezado, o.bytes, pie);
        largo += encabezado.length + o.bytes.length + pie.length;
      }
      const extras = (indice.info instanceof PDFRef ? ' /Info ' + refTexto(indice.info) : '') +
        (indice.id instanceof PDFArray ? ' /ID ' + binarioDeBytes(serializar(indice.id)) : '');

      if (indice.tipo === 'tabla') {
        const tam = Math.max(siguiente, indice.size || 0);
        let txt = 'xref\n';
        for (const g of agruparEntradas(entradas)) {
          txt += g.inicio + ' ' + g.items.length + '\n';
          for (const e of g.items) txt += String(e.offset).padStart(10, '0') + ' ' + String(e.gen).padStart(5, '0') + ' n\r\n';
        }
        txt += 'trailer\n<< /Size ' + tam + ' /Root ' + refTexto(indice.root) + extras + ' /Prev ' + indice.offset + ' >>\n' +
          'startxref\n' + largo + '\n%%EOF\n';
        partes.push(bytesLatin1(txt));
      } else {
        const numXref = siguiente++;
        const tam = Math.max(siguiente, indice.size || 0);
        entradas.push({ num: numXref, gen: 0, offset: largo });
        const grupos = agruparEntradas(entradas);
        const datos = new Uint8Array(entradas.length * 7);
        let p = 0;
        for (const g of grupos) {
          for (const e of g.items) {
            datos[p++] = 1;
            datos[p++] = (e.offset >>> 24) & 0xff; datos[p++] = (e.offset >>> 16) & 0xff;
            datos[p++] = (e.offset >>> 8) & 0xff; datos[p++] = e.offset & 0xff;
            datos[p++] = (e.gen >>> 8) & 0xff; datos[p++] = e.gen & 0xff;
          }
        }
        const dict = '<< /Type /XRef /Size ' + tam + ' /Root ' + refTexto(indice.root) + extras + ' /Prev ' + indice.offset +
          ' /W [1 4 2] /Index [' + grupos.map(function (g) { return g.inicio + ' ' + g.items.length; }).join(' ') + ']' +
          ' /Length ' + datos.length + ' >>';
        partes.push(bytesLatin1(numXref + ' 0 obj\n' + dict + '\nstream\n'), datos,
          bytesLatin1('\nendstream\nendobj\nstartxref\n' + largo + '\n%%EOF\n'));
      }

      const salida = unir(partes);
      const a = inicioFirma + marcas.abre;
      const b = inicioFirma + marcas.cierra + 1;
      const rango = '[0 ' + a + ' ' + b + ' ' + (salida.length - b) + ']';
      if (rango.length > moldeRango.length) throw new ErrorFirma('INTERNO', 'El PDF es demasiado grande para firmarlo.');
      salida.set(bytesLatin1(rango.padEnd(moldeRango.length, ' ')), inicioFirma + marcas.rango);

      const resumen = await resumirDocumento(unir([salida.subarray(0, a), salida.subarray(b)]));
      const cms = await construirCms(identidad, resumen, fecha);
      if (cms.length > reservado) throw new ErrorFirma('INTERNO', 'La firma no entro en el espacio reservado.');
      salida.set(bytesLatin1(aHex(cms)), a + 1);
      return salida;
    }

    async function contarPaginas(bytes) {
      const doc = await abrirPdf(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      return doc.getPageCount();
    }

    return {
      VERSION: VERSION,
      SELLO: SELLO,
      ErrorFirma: ErrorFirma,
      abrirP12: abrirP12,
      revisarVigencia: revisarVigencia,
      firmarPdf: firmarPdf,
      contarPaginas: contarPaginas,
      disenoSello: disenoSello,
      textoQr: textoQr,
      util: { aBase64: aBase64, deBase64: deBase64, sha256: sha256, aHex: aHex, piezasCertificado: piezasCertificado }
    };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = crearFirmador;
  } else {
    raiz.Firmador = crearFirmador(raiz.PDFLib, raiz.forge, raiz.qrcode);
  }
})(typeof self !== 'undefined' ? self : this);
