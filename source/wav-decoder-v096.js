/* Analyse Acoustique TGV — v0.9.6
 * Lecture des fichiers WAV longs sans saturer la mémoire.
 * Le fichier est lu par blocs de 8 Mo, mélangé en mono, filtré (passe-bas Butterworth
 * d'ordre 8 à 3 kHz) puis décimé vers ~8 kHz au fil de l'eau.
 * Mémoire : environ 115 Mo par heure d'enregistrement (au lieu d'environ 700 Mo à 48 kHz).
 * Formats : PCM entier 8/16/24/32 bits et flottant 32/64 bits, toutes fréquences, tous canaux.
 */
"use strict";

(() => {
  const TARGET = 8000, CUTOFF = 3000, BLOCK = 8 * 1024 * 1024;

  async function readBytes(file, start, length) {
    return new DataView(await file.slice(start, start + length).arrayBuffer());
  }

  async function parseHeader(file) {
    const head = await readBytes(file, 0, Math.min(file.size, 1 << 16));
    const tag = (o) => String.fromCharCode(head.getUint8(o), head.getUint8(o + 1), head.getUint8(o + 2), head.getUint8(o + 3));
    if (head.byteLength < 12 || !["RIFF", "RF64"].includes(tag(0)) || tag(8) !== "WAVE") throw new Error("En-tête WAV invalide");
    let pos = 12, fmt = null, dataStart = null, dataSize = null, ds64Size = null;
    while (pos + 8 <= head.byteLength) {
      const id = tag(pos), size = head.getUint32(pos + 4, true);
      if (id === "ds64") ds64Size = Number(head.getBigUint64(pos + 16, true));
      if (id === "fmt ") {
        let format = head.getUint16(pos + 8, true);
        const channels = head.getUint16(pos + 10, true), rate = head.getUint32(pos + 12, true), bits = head.getUint16(pos + 22, true);
        if (format === 0xfffe && size >= 40) format = head.getUint16(pos + 32, true); // WAVE_FORMAT_EXTENSIBLE
        fmt = { format, channels, rate, bits, blockAlign: head.getUint16(pos + 20, true) };
      }
      if (id === "data") {
        dataStart = pos + 8;
        dataSize = size === 0xffffffff && ds64Size ? ds64Size : size;
        break;
      }
      pos += 8 + size + (size & 1);
    }
    if (!fmt || dataStart === null) throw new Error("Bloc fmt ou data introuvable");
    if (![1, 3].includes(fmt.format)) throw new Error("WAV compressé non pris en charge (format " + fmt.format + ")");
    dataSize = Math.min(dataSize || 0, file.size - dataStart);
    if (!dataSize || dataSize < 0 || (dataSize === 0 && file.size > dataStart)) dataSize = file.size - dataStart; // en-tête non finalisé
    return { ...fmt, dataStart, dataSize };
  }

  /* biquads RBJ formant un Butterworth d'ordre 8 */
  /* Filtre anti-repliement avant la réduction à 8 kHz.
   * Si on ne garde qu'un échantillon sur q sans filtrer, les sons au-dessus de 4 kHz
   * « replieraient » dans la bande analysée et créeraient de faux pics. On applique donc un
   * filtre passe-bas Butterworth d'ordre 8 (atténuation ≈ 48 dB par octave, réponse plate
   * dans la bande utile) coupant à 3 000 Hz.
   * Un filtre d'ordre 8 est réalisé par 4 filtres d'ordre 2 (« biquads ») en série, avec les
   * coefficients de Robert Bristow-Johnson ; le coefficient de qualité de chaque étage vient
   * de la position des pôles de Butterworth : Q = 1 / (2 cos((2k−1)π/16)). */
  function butterworth8(fc, fs) {
    const sections = [];
    for (let k = 1; k <= 4; k++) {
      const q = 1 / (2 * Math.cos(((2 * k - 1) * Math.PI) / 16));
      const w0 = (2 * Math.PI * fc) / fs, alpha = Math.sin(w0) / (2 * q), cos = Math.cos(w0), a0 = 1 + alpha;
      sections.push({ b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 });
    }
    return sections;
  }

  /* Lecture d'un WAV par blocs de 8 Mo (jamais le fichier entier en mémoire) :
   *   1. mélange des voies en mono (moyenne) ;
   *   2. filtrage passe-bas (4 biquads) échantillon par échantillon ;
   *   3. décimation entière : on garde 1 échantillon sur q, avec q = partie entière de
   *      (fréquence d'origine / 8 000). Exemple : 48 kHz → q = 6 → 8 kHz ;
   *      24 kHz → q = 3 → 8 kHz ; 44,1 kHz → q = 5 → 8,82 kHz.
   * La fréquence d'origine est conservée (sourceSampleRate) pour la calibration. */
  window.decodeWavFile = async function decodeWavFile(file, onProgress) {
    const h = await parseHeader(file);
    const bytes = h.bits / 8, frameBytes = h.blockAlign || bytes * h.channels;
    const totalFrames = Math.floor(h.dataSize / frameBytes);
    const q = Math.max(1, Math.floor(h.rate / TARGET));
    const outRate = h.rate / q;
    const out = new Float32Array(Math.ceil(totalFrames / q));
    const filt = q > 1 ? butterworth8(Math.min(CUTOFF, 0.42 * outRate), h.rate) : null;
    const read = (() => {
      if (h.format === 3 && h.bits === 32) return (v, o) => v.getFloat32(o, true);
      if (h.format === 3 && h.bits === 64) return (v, o) => v.getFloat64(o, true);
      if (h.bits === 16) return (v, o) => v.getInt16(o, true) / 32768;
      if (h.bits === 24) return (v, o) => { const x = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16); return x / 8388608; };
      if (h.bits === 32) return (v, o) => v.getInt32(o, true) / 2147483648;
      if (h.bits === 8) return (v, o) => (v.getUint8(o) - 128) / 128;
      throw new Error(h.bits + " bits non pris en charge");
    })();
    const blockFrames = Math.max(1, Math.floor(BLOCK / frameBytes));
    // v0.9.8 Rust : conversion + filtre + décimation dans le noyau WebAssembly si disponible
    let rustDec = null;
    if (window.TgvCore?.available && out.length * 4 <= 60e6) { try { rustDec = window.TgvCore.wavDecoder(h, TARGET, CUTOFF); } catch (e) { rustDec = null; } }
    let frame = 0, k = 0, phase = 0;
    while (frame < totalFrames) {
      const n = Math.min(blockFrames, totalFrames - frame);
      const view = await readBytes(file, h.dataStart + frame * frameBytes, n * frameBytes);
      if (rustDec) rustDec.push(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
      for (let i = 0; !rustDec && i < n; i++) {
        const base = i * frameBytes;
        let x = 0;
        for (let c = 0; c < h.channels; c++) x += read(view, base + c * bytes);
        x /= h.channels;
        if (filt) {
          for (let s = 0; s < 4; s++) {
            const f = filt[s], y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
            f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y; x = y;
          }
          if (phase === 0 && k < out.length) out[k++] = x;
          phase = (phase + 1) % q;
        } else if (k < out.length) out[k++] = x;
      }
      frame += n;
      if (onProgress) onProgress(frame / totalFrames);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (rustDec) return rustDec.finish();
    const samples = k < out.length ? out.slice(0, k) : out;
    return { samples, sampleRate: outRate, sourceSampleRate: h.rate, duration: samples.length / outRate, streamed: true };
  };

  window.isWavFile = (file) => /\.wav$/i.test(file?.name || "") || /wav/i.test(file?.type || "");
})();
