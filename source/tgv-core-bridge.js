/* Analyse Acoustique TGV — pont JavaScript vers le noyau Rust (tgv_core.wasm).
 * NON TESTÉ en navigateur : la compilation WebAssembly n'a pas pu être faite dans
 * l'environnement de développement (voir README_RUST.md). La logique Rust, elle, est validée
 * contre le JS d'origine (validation/compare.js).
 *
 * Principe : window.TgvCore.ready (Promise) vaut true si le .wasm est chargé, false sinon.
 * Tant que ready n'est pas true, le code existant en JavaScript reste utilisé : l'app ne
 * dépend jamais du .wasm. Les fonctions renvoient des structures identiques à celles du JS
 * d'origine (null à la place de NaN) pour pouvoir les brancher sans toucher au reste.
 */
"use strict";
(() => {
  let w = null; // exports WebAssembly
  const mem = () => w.memory.buffer; // à relire après chaque allocation (la mémoire peut grandir)

  /* copie un tableau typé dans la mémoire WASM ; renvoie [pointeur, octets] */
  function put(arr) {
    const bytes = arr.byteLength, p = w.tgv_alloc(bytes);
    new Uint8Array(mem(), p, bytes).set(new Uint8Array(arr.buffer, arr.byteOffset, bytes));
    return [p, bytes];
  }
  function alloc(bytes) { return [w.tgv_alloc(bytes), bytes]; }
  const drop = (...blocks) => blocks.forEach(([p, n]) => w.tgv_free(p, n));
  const f64 = (p, n) => new Float64Array(mem(), p, n);
  const f32 = (p, n) => new Float32Array(mem(), p, n);
  const nul = (v) => (Number.isNaN(v) ? null : v);

  const api = {
    available: false,
    /* Garde mémoire : au-delà de ~60 Mo de signal (≈ 30 min à 8 kHz), on reste sur le JS d'origine. */
    fits: (nSamples) => nSamples * 4 <= 60e6,

    /* Pondération A (dB) */
    aWeighting: (f) => w.tgv_a_weighting(f),

    /* Spectre moyen de Welch : { freqRaw, freq, db, dbA } (Float64Array) */
    welch(samples, n, sampleRate, calFactor = 1) {
      const bins = n >> 1, s = put(samples), o = [0, 1, 2, 3].map(() => alloc(bins * 8));
      w.tgv_welch(s[0], samples.length, n, sampleRate, calFactor, o[0][0], o[1][0], o[2][0], o[3][0]);
      const res = { freqRaw: f64(o[0][0], bins).slice(), freq: f64(o[1][0], bins).slice(), db: f64(o[2][0], bins).slice(), dbA: f64(o[3][0], bins).slice() };
      drop(s, ...o);
      return res;
    },

    /* Pics d'un spectre : [{ i, f, v, rawV, aV, prominence }] */
    findPeaks(freq, db, sampleRate, fftSize, count = 10, maxF = 2500, byLevel = false) {
      const fb = put(freq), db_ = put(db), ob = alloc(count * 5 * 8);
      const n = w.tgv_find_peaks(fb[0], db_[0], freq.length, sampleRate, fftSize, count, maxF, byLevel ? 1 : 0, ob[0]);
      const r = f64(ob[0], n * 5), peaks = [];
      for (let i = 0; i < n; i++) peaks.push({ i: r[i * 5], f: r[i * 5 + 1], v: r[i * 5 + 2], rawV: r[i * 5 + 2], aV: r[i * 5 + 3], prominence: r[i * 5 + 4] });
      drop(fb, db_, ob);
      return peaks;
    },

    /* Fréquences de la chaîne à une vitesse et un diamètre : même objet que transmissionFrequencies */
    transmission(speedKmh, diameterMm) {
      const ob = alloc(6 * 8), ok = w.tgv_transmission(speedKmh, diameterMm, ob[0]);
      const r = ok ? Array.from(f64(ob[0], 6)) : null;
      drop(ob);
      return r && { axle: r[0], bridgeInput: r[1], motor: r[2], reducerIntermediate: r[3], meshBridge: r[4], meshReducer: r[5] };
    },
    equivalentDiameter: (hz, speedKmh, reducer) => nul(w.tgv_equivalent_diameter(hz, speedKmh, reducer ? 1 : 0)),

    /* Suivi de la fréquence : même résultat que trackTone() : { frames:[{t,peakHz,peakDb,tnr,prom,bandDb,spec}], N, binHz, sr } */
    trackTone(record, fLo, fHi, calFactor = 1) {
      const x = put(record.samples), sr = record.sampleRate;
      const h = w.tgv_track_tone(x[0], record.samples.length, sr, record.duration, fLo, fHi, calFactor);
      drop(x);
      const nf = w.tgv_tone_frames(h), info = alloc(16);
      w.tgv_tone_info(h, info[0]);
      const [N, binHz] = Array.from(f64(info[0], 2));
      drop(info);
      const col = (c) => f64(w.tgv_tone_column(h, c), nf).slice();
      const t = col(0), pk = col(1), pd = col(2), tn = col(3), pr = col(4), bd = col(5);
      const GRID_N = 501, spec = f32(w.tgv_tone_spec(h), nf * GRID_N).slice();
      w.tgv_tone_free(h);
      const frames = [];
      for (let i = 0; i < nf; i++) frames.push({ t: t[i], peakHz: nul(pk[i]), peakDb: nul(pd[i]), tnr: nul(tn[i]), prom: nul(pr[i]), bandDb: bd[i], spec: spec.subarray(i * GRID_N, (i + 1) * GRID_N) });
      return { frames, N, binHz, sr };
    },

    /* Spectre en ordres : { db, orderStep, fMid, duration, cycles } */
    orderSpectrum(record, tA, tB, ts, fs) {
      const x = put(record.samples), a = put(Float64Array.from(ts)), b = put(Float64Array.from(fs));
      const h = w.tgv_order_spectrum(x[0], record.samples.length, record.sampleRate, tA, tB, a[0], b[0], ts.length);
      drop(x, a, b);
      const info = alloc(32); w.tgv_order_info(h, info[0]);
      const [orderStep, fMid, duration, cycles] = Array.from(f64(info[0], 4));
      drop(info);
      const db = f32(w.tgv_order_db(h), w.tgv_order_len(h)).slice();
      w.tgv_order_free(h);
      return { db, orderStep, fMid, duration, cycles };
    },

    /* Décodeur WAV par blocs : d = TgvCore.wavDecoder(h) ; d.push(arrayBuffer) ; d.finish() */
    wavDecoder(h, target = 8000, cutoff = 3000) {
      const frameBytes = h.blockAlign || (h.bits / 8) * h.channels, totalFrames = Math.floor(h.dataSize / frameBytes);
      const d = w.tgv_wav_new(h.format, h.bits, h.channels, h.rate, h.blockAlign || 0, totalFrames, target, cutoff);
      if (!d) throw new Error(h.bits + " bits non pris en charge");
      return {
        push(buffer) { const b = put(new Uint8Array(buffer)); w.tgv_wav_push(d, b[0], b[1]); drop(b); },
        finish() {
          const samples = f32(w.tgv_wav_samples(d), w.tgv_wav_len(d)).slice(), outRate = w.tgv_wav_out_rate(d);
          w.tgv_wav_free(d);
          return { samples, sampleRate: outRate, sourceSampleRate: h.rate, duration: samples.length / outRate, streamed: true };
        },
      };
    },
  };

  api.ready = (async () => {
    try {
      const url = new URL("tgv_core.wasm", document.currentScript?.src || location.href).href;
      let bytes;
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        bytes = await resp.arrayBuffer();
      } catch (e) {
        // page ouverte directement (file://) : fetch() est refusé, on utilise le .wasm embarqué
        if (!window.__TGV_WASM_B64) throw e;
        const bin = atob(window.__TGV_WASM_B64); bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      }
      const { instance } = await WebAssembly.instantiate(bytes, {});
      w = instance.exports; api.available = true;
      return true;
    } catch (e) {
      console.warn("TgvCore : noyau Rust indisponible, le code JavaScript est utilisé.", e);
      return false;
    }
  })();
  window.TgvCore = api;
})();
