/* Analyse Acoustique TGV — v0.9.6
 * Enregistrement audio en WAV (PCM 16 bits mono) au lieu de WebM.
 * Le WAV se lit partout (Windows, Audacity, Python, Excel…) et n'est pas compressé :
 * idéal pour l'analyse. Le signal est réduit à 24 kHz (22,05 kHz) après un filtre
 * anti-repliement : largement suffisant (analyse jusqu'à 2 500 Hz) et 2 fois plus léger.
 * Taille : environ 2,9 Mo par minute, 173 Mo par heure.
 * Repli automatique sur MediaRecorder si AudioWorklet n'est pas disponible.
 */
"use strict";

(() => {
  const WORKLET = `
class AcqWavRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.size = 4096; this.buf = new Float32Array(this.size); this.n = 0; this.on = true;
    this.port.onmessage = (e) => { if (e.data === "stop") { if (this.n) this.port.postMessage(this.buf.slice(0, this.n)); this.n = 0; this.on = false; } }; }
  process(inputs) {
    const input = inputs[0];
    if (this.on && input && input.length) {
      const len = input[0].length, chs = input.length;
      for (let i = 0; i < len; i++) {
        let v = 0; for (let c = 0; c < chs; c++) v += input[c][i]; v /= chs;
        this.buf[this.n++] = v;
        if (this.n === this.size) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("acq-wav-recorder", AcqWavRecorder);`;

  /* filtre passe-bas FIR (sinc fenêtré Blackman) pour la décimation par 2 */
  /* Filtre FIR passe-bas par la méthode de la fenêtre.
   * La réponse idéale d'un passe-bas est un « sinus cardinal » (sinc) infini ; on le coupe à
   * 63 coefficients et on l'adoucit avec une fenêtre de Blackman pour limiter les ondulations.
   * Coupure 0,21 × fe ≈ 10 kHz à 48 kHz, avant de garder 1 échantillon sur 2 (24 kHz).
   * La somme des coefficients est ramenée à 1 pour ne pas changer le niveau sonore. */
  function designLowpass(taps, cutoff) {
    const h = new Float32Array(taps), m = (taps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const x = i - m, sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
      h[i] = sinc * w; sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    return h;
  }

  /* Enregistreur WAV.
   * Le micro est lu par un AudioWorklet (petit programme exécuté dans le fil audio du
   * navigateur, sans perte d'échantillons même si l'écran est chargé). Chaque bloc est
   * filtré, décimé par 2, converti en entiers 16 bits puis gardé en mémoire. À l'arrêt,
   * toWav() ajoute l'en-tête RIFF de 44 octets (format PCM, mono, 16 bits). */
  class WavRecorder extends EventTarget {
    constructor(ctx, node, sink) {
      super();
      this.ctx = ctx; this.node = node; this.sink = sink;
      this.state = "inactive";
      this.decim = ctx.sampleRate >= 44100 ? 2 : 1;
      this.rate = Math.round(ctx.sampleRate / this.decim);
      this.mimeType = "audio/wav";
      this.h = this.decim > 1 ? designLowpass(63, 0.21) : null; // coupure ≈ 0,21 × fs ≈ 10 kHz
      this.hist = new Float32Array(this.h ? this.h.length : 0);
      this.phase = 0;
      this.chunks = [];
      this.samples = 0;
      node.port.onmessage = (e) => this.push(e.data);
    }
    push(block) {
      if (this.state !== "recording" && this.state !== "stopping") return;
      let out;
      if (!this.h) out = block;
      else {
        const h = this.h, L = h.length, hist = this.hist;
        out = new Float32Array(Math.ceil(block.length / 2) + 1);
        let k = 0;
        for (let i = 0; i < block.length; i++) {
          hist.copyWithin(0, 1); hist[L - 1] = block[i];
          if (this.phase === 0) { let acc = 0; for (let j = 0; j < L; j++) acc += h[j] * hist[j]; out[k++] = acc; }
          this.phase ^= 1;
        }
        out = out.subarray(0, k);
      }
      const pcm = new Int16Array(out.length);
      for (let i = 0; i < out.length; i++) { const v = Math.max(-1, Math.min(1, out[i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
      this.chunks.push(pcm);
      this.samples += pcm.length;
    }
    start() { this.state = "recording"; this.startedAt = performance.now(); }
    stop() {
      if (this.state !== "recording") return;
      this.state = "stopping";
      try { this.node.port.postMessage("stop"); } catch (e) {}
      try { this.node.disconnect(); this.sink.disconnect(); } catch (e) {}
      this.state = "inactive";
      const blob = this.toWav();
      const ev = new Event("dataavailable"); ev.data = blob;
      this.dispatchEvent(ev);
      this.dispatchEvent(new Event("stop"));
    }
    toWav() {
      const n = this.samples, header = new ArrayBuffer(44), v = new DataView(header);
      const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, this.rate, true); v.setUint32(28, this.rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      str(36, "data"); v.setUint32(40, n * 2, true);
      return new Blob([header, ...this.chunks], { type: "audio/wav" });
    }
  }

  /* appelé par le moteur au démarrage d'une acquisition ; null = repli MediaRecorder */
  window.createAcqRecorder = async function createAcqRecorder(stream, ctx, source) {
    try {
      window.acqRecorderInfo = null;
      if (!ctx?.audioWorklet || typeof AudioWorkletNode === "undefined") { window.acqRecorderInfo = "AudioWorklet non pris en charge"; return null; }
      if (!ctx.__acqWavModule) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        ctx.__acqWavModule = true;
      }
      const node = new AudioWorkletNode(ctx, "acq-wav-recorder", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const sink = ctx.createGain(); sink.gain.value = 0;
      source.connect(node); node.connect(sink); sink.connect(ctx.destination);
      const rec = new WavRecorder(ctx, node, sink);
      window.acqRecorderInfo = `WAV ${(rec.rate / 1000).toFixed(rec.rate % 1000 ? 2 : 0).replace(".", ",")} kHz 16 bits`;
      return rec;
    } catch (error) {
      console.warn("Enregistrement WAV indisponible, repli sur MediaRecorder", error);
      window.acqRecorderInfo = "WAV indisponible (" + (error?.message || error) + ")";
      return null;
    }
  };

  // Rechargement automatique une fois la nouvelle version installée (jamais pendant une acquisition)
  if ("serviceWorker" in navigator) {
    let reloaded = false;
    const hadController = !!navigator.serviceWorker.controller; // false à la toute première visite
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded || (typeof acqRunning !== "undefined" && acqRunning)) return;
      reloaded = true;
      location.reload();
    });
  }
})();
