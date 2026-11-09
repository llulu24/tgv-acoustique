/* Analyse Acoustique TGV — lecteur audio + filtre coupe-bande qui suit la vitesse (v0.9.10)
 *
 * MÉTHODE
 *  - Le son du fichier affiché (record.samples, mono) est lu par l'API Web Audio.
 *  - Un filtre « coupe-bande » (notch) ou « solo » (passe-bande) est placé sur la fréquence d'un organe.
 *    Cette fréquence est proportionnelle à la vitesse du train : f = pente × vitesse, avec
 *      engrènement réducteur = 51 × 51/44 × (rotation d'essieu) = 5,2268 / D(m) Hz par km/h,
 *      engrènement pont      = 51 × (rotation d'essieu)          = 4,5093 / D(m) Hz par km/h.
 *    Le filtre suit donc la vitesse GPS enregistrée (lignes Campbell du fichier), toutes les 0,25 s.
 *  - Usage : si le bruit gênant disparaît quand on coupe cette fréquence, c'est elle qui le crée.
 *  - Limite : la précision de la vitesse GPS limite la précision du filtre ; la largeur réglable (± %) compense.
 */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const K_RED = 5.2268, K_PONT = 4.5093;     // Hz par km/h pour D = 1 m
  const STEP = 0.25;                          // s entre deux mises à jour de la fréquence du filtre
  let ctx = null, src = null, filt = [], gain = null, comp = null, hpNode = null;
  let playing = false, startCtx = 0, startPos = 0, timer = null;
  let loop = { a: null, b: null };

  function rec() {
    if (typeof records === "undefined") return null;
    const sel = $("lecRecord"), i = sel ? parseInt(sel.value) : NaN;
    if (Number.isFinite(i) && records[i]?.samples) return records[i];
    return (records[selectedIndex]?.samples ? records[selectedIndex] : records.find((r) => r.samples)) || null;
  }
  function fillRecords() {
    const sel = $("lecRecord"); if (!sel || typeof records === "undefined") return;
    const keep = sel.value;
    sel.innerHTML = records.map((r, i) => r.samples ? `<option value="${i}">${String(r.name || "Fichier " + (i + 1)).replace(/[<>&"]/g, "")}</option>` : "").join("") || '<option value="">Aucun fichier chargé</option>';
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep; else if (typeof selectedIndex !== "undefined" && [...sel.options].some((o) => o.value === String(selectedIndex))) sel.value = String(selectedIndex);
  }
  /* onglet « Lecteur » : s'ajoute aux trois onglets du moteur sans modifier sa logique */
  const PANELS = [["analysisMode", "modeAnalysis"], ["acquisitionMode", "modeAcquisition"], ["diagnosticMode", "modeDiagnostic"]];
  function showTab() {
    PANELS.forEach(([p, b]) => { $(p)?.classList.add("hidden"); $(b)?.classList.remove("active"); $(b)?.setAttribute("aria-selected", "false"); });
    $("lecteurMode").classList.remove("hidden"); $("modeLecteur").classList.add("active"); $("modeLecteur").setAttribute("aria-selected", "true");
    fillRecords(); updateUi();
  }
  function hideTab() { $("lecteurMode")?.classList.add("hidden"); $("modeLecteur")?.classList.remove("active"); $("modeLecteur")?.setAttribute("aria-selected", "false"); }
  function rows() { return (window.CampbellTGV?._state?.rows || []).filter((r) => Number.isFinite(r.t)); }
  function speedAt(t) {
    const rs = rows(); if (!rs.length) return null;
    let lo = 0, hi = rs.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (rs[m].t < t) lo = m + 1; else hi = m; }
    const a = rs[Math.max(0, lo - 1)], b = rs[lo];
    const r = Math.abs((a?.t ?? 1e9) - t) <= Math.abs((b?.t ?? 1e9) - t) ? a : b;
    return Math.abs(r.t - t) <= 2 && Number.isFinite(r.speed) ? r : null;
  }
  function diameterM() {
    const v = parseFloat($("lecDiam")?.value);
    return Number.isFinite(v) && v > 500 ? v / 1000 : 0.897;
  }
  function filterFreq(t) {
    const mode = $("lecOrgan").value;
    if (mode === "fixe") return parseFloat($("lecFixe").value) || 1700;
    const r = speedAt(t); if (!r) return null;
    const k = mode.startsWith("pont") ? K_PONT : K_RED, h = mode.endsWith("2") ? 2 : 1;
    return (k / diameterM()) * r.speed * h;
  }
  function modeType() { return $("lecFilter").value; }  // off | notch | solo

  function buildGraph(c) {
    const g = c.createGain(); g.gain.value = Math.pow(10, (parseFloat($("lecGain").value) || 0) / 20);
    // limiteur de sécurité seulement (n'agit qu'au-dessus de -3 dBFS) : il évite la saturation sans colorer le son
    const cp = c.createDynamicsCompressor(); cp.threshold.value = -3; cp.knee.value = 0; cp.ratio.value = 20; cp.attack.value = 0.002; cp.release.value = 0.05;
    const f = [c.createBiquadFilter(), c.createBiquadFilter()];
    const hp = c.createBiquadFilter(); applyHp(hp);
    return { g, cp, f, hp };
  }
  function applyHp(hp) {
    const v = parseFloat($("lecHP")?.value) || 0;
    if (v > 0) { hp.type = "highpass"; hp.frequency.value = v; hp.Q.value = 0.707; }
    else { hp.type = "allpass"; hp.frequency.value = 1000; hp.Q.value = 0.7; }
  }
  function applyFilterType(f) {
    const m = modeType();
    f.forEach((x) => {
      if (m === "off") { x.type = "allpass"; x.frequency.value = 1000; x.Q.value = 0.7; }
      else { x.type = m === "notch" ? "notch" : "bandpass"; x.Q.value = qFromWidth(); }
    });
  }
  function qFromWidth() { const w = Math.max(0.5, parseFloat($("lecWidth").value) || 4); return Math.max(2, 100 / w); }
  function hasLoop() { return loop.a != null && loop.b != null && loop.b > loop.a; }
  function fileTime(tau, p0, dur) {            // temps du fichier lu au bout de tau secondes de lecture
    if (!hasLoop()) return p0 + tau <= dur ? p0 + tau : null;
    const first = loop.b - p0;
    if (p0 >= loop.a && p0 < loop.b && tau < first) return p0 + tau;
    if (p0 < loop.a || p0 >= loop.b) return loop.a + (tau % (loop.b - loop.a));
    return loop.a + ((tau - first) % (loop.b - loop.a));
  }
  function schedule(f, c, p0, dur, ctxStart) {
    // programme la fréquence du filtre pour la suite de la lecture (jusqu'à 1 h d'horloge audio)
    f.forEach((x) => x.frequency.cancelScheduledValues(0));
    if (modeType() === "off") return;
    let last = 1700;
    const H = hasLoop() ? 3600 : Math.min(3600, dur - p0);
    for (let tau = 0; tau <= H; tau += STEP) {
      const t = fileTime(tau, p0, dur); if (t == null) break;
      const fr = filterFreq(t);
      if (fr != null) last = Math.min(3900, Math.max(30, fr));
      f.forEach((x) => x.frequency.setValueAtTime(last, ctxStart + tau));
    }
  }
  function ensureCtx() { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === "suspended") ctx.resume(); return ctx; }

  function play(from) {
    const r = rec(); if (!r) { status("Aucun fichier analysé : chargez un fichier d'abord."); return; }
    stop(false);
    const c = ensureCtx();
    const buf = c.createBuffer(1, r.samples.length, r.sampleRate); buf.getChannelData(0).set(r.samples);
    const { g, cp, f, hp } = buildGraph(c); gain = g; comp = cp; filt = f; hpNode = hp;
    applyFilterType(f);
    src = c.createBufferSource(); src.buffer = buf;
    src.connect(hp); hp.connect(f[0]); f[0].connect(f[1]); f[1].connect(g); g.connect(cp); cp.connect(c.destination);
    const dur = buf.duration;
    const a = loop.a != null && loop.b != null && loop.b > loop.a ? loop.a : null;
    startPos = Math.min(Math.max(0, from ?? 0), dur - 0.05);
    if (a != null && (startPos < loop.a || startPos > loop.b)) startPos = loop.a;
    if (a != null) { src.loop = true; src.loopStart = loop.a; src.loopEnd = loop.b; }
    startCtx = c.currentTime + 0.05;
    schedule(f, c, startPos, dur, startCtx);
    src.start(startCtx, startPos);
    src.onended = () => { if (playing && !src.loop) { playing = false; updateUi(); } };
    playing = true; clearInterval(timer); timer = setInterval(updateUi, 100); updateUi();
  }
  function stop(resetUi = true) {
    if (src) { try { src.onended = null; src.stop(); } catch (e) {} src.disconnect(); src = null; }
    playing = false; clearInterval(timer);
    if (resetUi) updateUi();
  }
  function pos() {
    const r = rec(); if (!r) return 0;
    if (!playing || !ctx) return parseFloat($("lecPos").value) || 0;
    let p = startPos + (ctx.currentTime - startCtx);
    if (loop.a != null && loop.b != null && loop.b > loop.a && p > loop.b) p = loop.a + ((p - loop.a) % (loop.b - loop.a));
    return Math.max(0, p);
  }
  function fmtT(s) { s = Math.max(0, s); return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0"); }
  function status(t) { const e = $("lecStatus"); if (e) e.textContent = t; }

  function updateUi() {
    const r = rec(), dur = r ? r.samples.length / r.sampleRate : 0;
    const p = Math.min(pos(), dur);
    const sl = $("lecPos"); if (sl && document.activeElement !== sl) { sl.max = String(Math.max(1, Math.floor(dur))); sl.value = String(p); }
    $("lecTime").textContent = fmtT(p) + " / " + fmtT(dur);
    const s = speedAt(p);
    const fr = filterFreq(p);
    $("lecNow").textContent = s ? `${Math.round(s.speed)} km/h · ${s.regime}` : "vitesse non disponible pour ce fichier";
    $("lecFreq").textContent = modeType() === "off" ? "filtre inactif" : (fr != null ? `filtre à ${Math.round(fr)} Hz` : "filtre en attente de vitesse");
    $("lecPlay").textContent = playing ? "⏸ Pause" : "▶ Lecture";
    $("lecLoopInfo").textContent = loop.a != null && loop.b != null ? `Boucle : ${fmtT(loop.a)} → ${fmtT(loop.b)} (${Math.round(loop.b - loop.a)} s)` : "Pas de boucle";
  }

  function liveRefresh() {
    // changement de filtre / largeur / organe / gain pendant la lecture : on reprogramme sans couper le son
    if (!playing || !ctx) { updateUi(); return; }
    const p = pos(), r = rec();
    if (gain) gain.gain.value = Math.pow(10, (parseFloat($("lecGain").value) || 0) / 20);
    applyFilterType(filt); if (hpNode) applyHp(hpNode);
    const dur = r.samples.length / r.sampleRate;
    startPos = p; startCtx = ctx.currentTime;
    schedule(filt, ctx, p, dur, ctx.currentTime);
    updateUi();
  }

  function findPassage() {
    const rs = rows(); if (!rs.length) { status("Pas de données de vitesse pour ce fichier."); return; }
    const reg = $("lecFindRegime").value, v0 = parseFloat($("lecFindV0").value), v1 = parseFloat($("lecFindV1").value);
    let a = null, b = null;
    for (const r of rs) {
      const ok = r.regime === reg && Number.isFinite(r.speed) && r.speed >= v0 && r.speed <= v1;
      if (ok) { if (a == null) a = r.t; b = r.t; }
      else if (a != null && b - a >= 3) break;
      else if (a != null) { a = b = null; }
    }
    if (a == null || b - a < 3) { status(`Aucun passage de plus de 3 s en ${reg} entre ${v0} et ${v1} km/h.`); return; }
    loop = { a: Math.max(0, a - 0.5), b: Math.min(b + 0.5, a + 60) };
    status(`Passage trouvé : ${fmtT(loop.a)} → ${fmtT(loop.b)}.`);
    play(loop.a);
  }

  /* export WAV de l'extrait (avec ou sans le filtre actuel) pour comparer avant / après */
  function wav16(data, sr) {
    const n = data.length, ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 32767, true);
    return new Blob([ab], { type: "audio/wav" });
  }
  async function renderSegment(a, b, withFilter) {
    const r = rec(), len = Math.floor((b - a) * r.sampleRate);
    const oc = new OfflineAudioContext(1, len, r.sampleRate);
    const buf = oc.createBuffer(1, r.samples.length, r.sampleRate); buf.getChannelData(0).set(r.samples);
    const s = oc.createBufferSource(); s.buffer = buf;
    const f = [oc.createBiquadFilter(), oc.createBiquadFilter()]; const prev = $("lecFilter").value;
    if (!withFilter) $("lecFilter").value = "off";
    applyFilterType(f);
    const keepLoop = loop; loop = { a: null, b: null };
    schedule(f, oc, a, r.samples.length / r.sampleRate, 0);
    loop = keepLoop; $("lecFilter").value = prev;
    const hp = oc.createBiquadFilter(); applyHp(hp);
    s.connect(hp); hp.connect(f[0]); f[0].connect(f[1]); f[1].connect(oc.destination);
    s.start(0, a, b - a);
    return (await oc.startRendering()).getChannelData(0).slice();
  }
  async function exportWav(withFilter) {
    const r = rec(); if (!r) { status("Aucun fichier."); return; }
    const dur = r.samples.length / r.sampleRate;
    const a = hasLoop() ? loop.a : 0, b = hasLoop() ? loop.b : Math.min(dur, 120);
    const out = await renderSegment(a, b, withFilter);
    let pk = 0; for (let i = 0; i < out.length; i++) pk = Math.max(pk, Math.abs(out[i]));
    const g = pk > 0 ? 0.85 / pk : 1; for (let i = 0; i < out.length; i++) out[i] *= g;   // normalisation d'écoute
    const url = URL.createObjectURL(wav16(out, r.sampleRate));
    const el = document.createElement("a"); el.href = url; el.download = `extrait_${withFilter ? "filtre" : "original"}_${Math.round(a)}-${Math.round(b)}s.wav`; el.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    status(`Extrait ${withFilter ? "filtré" : "original"} exporté (${Math.round(b - a)} s, niveau normalisé pour l'écoute).`);
  }

  function init() {
    if (!$("lecPlay")) return;
    $("modeLecteur").addEventListener("click", showTab);
    document.addEventListener("tgv-mode", hideTab);
    $("lecRecord").addEventListener("change", () => { stop(); loop = { a: null, b: null }; $("lecPos").value = 0; updateUi(); });
    $("lecPlay").addEventListener("click", () => { if (playing) { const p = pos(); stop(false); $("lecPos").value = p; updateUi(); } else play(parseFloat($("lecPos").value) || 0); });
    $("lecStop").addEventListener("click", () => { stop(); $("lecPos").value = 0; updateUi(); });
    $("lecPos").addEventListener("input", () => { if (playing) play(parseFloat($("lecPos").value)); else updateUi(); });
    ["lecFilter", "lecOrgan", "lecWidth", "lecGain", "lecFixe", "lecDiam", "lecHP"].forEach((id) => $(id).addEventListener("input", liveRefresh));
    $("lecA").addEventListener("click", () => { loop.a = pos(); if (loop.b != null && loop.b <= loop.a) loop.b = null; updateUi(); });
    $("lecB").addEventListener("click", () => { loop.b = pos(); if (loop.a != null && loop.a >= loop.b) loop.a = null; updateUi(); if (playing) play(pos()); });
    $("lecClear").addEventListener("click", () => { loop = { a: null, b: null }; if (playing) play(pos()); else updateUi(); });
    $("lecFind").addEventListener("click", findPassage);
    $("lecExportF").addEventListener("click", () => exportWav(true));
    $("lecExportO").addEventListener("click", () => exportWav(false));
    $("lecDiamFromApp").addEventListener("click", () => {
      const d = window.DiametresTGV?.state?.applied?.d1 || parseFloat(document.getElementById("transWheelDiameter1")?.value);
      if (Number.isFinite(d)) { $("lecDiam").value = Math.round(d); liveRefresh(); }
    });
    updateUi();
  }
  window.LecteurTGV = { renderSegment, play, stop, pos, speedAt, filterFreq, _loop: () => loop, init };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
