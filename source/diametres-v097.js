/* Analyse Acoustique TGV — v0.9.7 RC
 * Calcul des diamètres de roue (essieux E1 / E2) à partir du sifflement d'engrènement.
 *
 * MÉTHODE
 *   La fréquence d'engrènement du réducteur vaut  f = (51 × 51 / 44) × v / (3,6 × π × D)
 *   (≈ 5,81 Hz par km/h pour D = 900 mm) : à vitesse connue, elle ne dépend que du diamètre
 *   de roue D. Chaque essieu moteur produit donc sa propre trace, à une fréquence qui
 *   dépend de son diamètre.
 *   1. On prend l'enregistrement et la vitesse seconde par seconde (CSV / JSON / ZIP de
 *      session associé). On garde les instants en traction (si le régime est renseigné),
 *      au-dessus de 150 km/h et à vitesse stable (accélération < 0,08 m/s²).
 *   2. Pour chaque instant : spectre fin (FFT de 8 192 points à 8 kHz, ≈ 1 Hz par case).
 *   3. Pour chaque diamètre testé (840 à 950 mm, au millimètre), on calcule la fréquence
 *      attendue et l'ÉMERGENCE du son à cette fréquence : niveau maximal dans ±0,3 % moins
 *      le niveau médian du voisinage (±4 %, sans la zone ±1,2 %). On fait la moyenne sur
 *      tous les instants retenus.
 *   4. La courbe « émergence en fonction du diamètre » présente un PIC par essieu audible.
 *      Chaque pic est affiné au demi-millimètre (tolérance ±0,15 %, interpolation
 *      parabolique). L'incertitude statistique est estimée par rééchantillonnage
 *      (bootstrap) des instants.
 *   Validation (essai du 30/10/2026, deux motrices) : diamètres retrouvés à ± 2 mm des
 *   valeurs mesurées en atelier (857 → 857,2 ; 924 → 922,4 ; 896 → 897,3 ; 906 → ≈ 904).
 *   Limite : deux essieux dont les diamètres diffèrent de moins de 1,5 % environ donnent
 *   un seul pic élargi (« diamètres proches »).
 *   Durée nécessaire (mesurée sur les essais du 30/10, 95 % des cas) : 30 s → ± 8 mm,
 *   1 min → ± 3 à 6 mm, 2 min → ± 1,5 à 3 mm, 5 min → ± 1 mm ; plus ± 1 à 2 mm dus au GPS.
 *   D'où : minimum 60 s, résultat « fiable » à partir de 120 s.
 *
 * TEMPS RÉEL (v0.9.7 RC)
 *   Pendant l'acquisition, un analyseur FFT de 32 768 points (≈ 1,5 Hz par case à 48 kHz)
 *   est branché sur le micro. Chaque seconde où le régime saisi est « Traction », la vitesse
 *   GPS au-dessus de 150 km/h et stable, l'émergence de chaque diamètre testé est ajoutée à
 *   une moyenne cumulée : la courbe et les diamètres s'affinent au fil du trajet.
 */
"use strict";

(() => {
  const $id = (id) => document.getElementById(id);
  const N = 8192, D_MIN = 840, D_MAX = 950, TOL = 0.003, TOL_FINE = 0.0015;
  // Plage plausible d'un diamètre de roue TGV : 850 mm (cote de retrait) à 924 mm (neuve).
  // Sert seulement à contrôler la cohérence du calcul (vitesse GPS, chaîne de transmission) :
  // la recherche va volontairement au-delà (840–950) pour repérer une valeur aberrante.
  const D_NEUF = 924, D_RETRAIT = 850, TOL_COTE = 3;
  const horsCotes = (d) => d > D_NEUF + TOL_COTE || d < D_RETRAIT - TOL_COTE;
  const MIN_SPEED = 150, MAX_ACCEL = 0.08, MIN_SECONDS = 60, RELIABLE_SECONDS = 120;
  const state = { result: null, busy: false };
  const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d).replace(".", ",") : "—");
  const pause = () => new Promise((r) => setTimeout(r, 0));
  const setInfo = (text, error = false) => { const el = $id("diamStatus"); if (el) { el.textContent = text; el.classList.toggle("status-error", error); } };

  // pente de l'engrènement réducteur pour D = 1 m (Hz par km/h × m)
  const meshPerKmhAt1m = () => transmissionFrequencies(100, 1000).meshReducer / 100;

  function currentRecord() {
    const id = $id("toneRecord")?.value;
    return records.find((r) => String(r.id) === id) || records[0];
  }
  function speedTrack() { return window.AnalyseRaieTGV?.state?.speedTrack || null; }
  // vitesse (et régime) interpolée à l'instant t du fichier
  function speedAt(track, t) {
    const tt = t + (parseFloat($id("toneCsvOffset")?.value) || 0);
    if (tt < track[0].t || tt > track.at(-1).t) return { v: null, regime: null };
    let lo = 0, hi = track.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (track[m].t <= tt) lo = m; else hi = m; }
    const a = track[lo], b = track[hi];
    if (!Number.isFinite(a.v) || !Number.isFinite(b.v)) return { v: null, regime: a.regime };
    const u = b.t > a.t ? (tt - a.t) / (b.t - a.t) : 0;
    return { v: a.v + (b.v - a.v) * u, regime: Math.abs(tt - a.t) <= Math.abs(b.t - tt) ? a.regime : b.regime };
  }
  // accélération (m/s²) par régression linéaire sur ±4 s
  function accelAt(track, t) {
    const pts = [];
    for (let dt = -4; dt <= 4; dt += 1) { const s = speedAt(track, t + dt); if (Number.isFinite(s.v)) pts.push([dt, s.v / 3.6]); }
    if (pts.length < 6) return null;
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let sxy = 0, sxx = 0; pts.forEach(([x, y]) => { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; });
    return sxx ? sxy / sxx : null;
  }

  /* ---------- 1 et 2 : sélection des instants et spectres fins ---------- */
  async function collectSpectra(record, track) {
    const sr = record.sampleRate, x = record.samples;
    const binHz = (sr / N) * frequencyCalibrationFactorFor(record.sourceSampleRate || sr);
    const k0 = Math.floor(700 / binHz), k1 = Math.min(N / 2 - 1, Math.ceil(2600 / binHz));
    const hasTraction = track.some((p) => p.regime === "Traction");
    const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = hann(i, N);
    const frames = [], frame = new Float64Array(N);
    const step = N / sr;                        // fenêtres jointives (≈ 1 s)
    let n = 0;
    for (let tc = N / 2 / sr; tc + N / 2 / sr <= record.duration; tc += step, n++) {
      const s = speedAt(track, tc);
      if (!(s.v >= MIN_SPEED)) continue;
      if (hasTraction && s.regime !== "Traction") continue;
      const a = accelAt(track, tc);
      if (a === null || Math.abs(a) > MAX_ACCEL) continue;
      const start = Math.round(tc * sr - N / 2);
      let mean = 0; for (let i = 0; i < N; i++) mean += x[start + i]; mean /= N;
      for (let i = 0; i < N; i++) frame[i] = (x[start + i] - mean) * win[i];
      const F = fftReal(frame), db = new Float32Array(k1 - k0 + 1);
      for (let k = k0; k <= k1; k++) db[k - k0] = 10 * Math.log10(F.re[k] * F.re[k] + F.im[k] * F.im[k] + 1e-20);
      frames.push({ t: tc, v: s.v, db });
      if (n % 60 === 0) { setInfo(`Spectres fins : ${Math.round((100 * tc) / record.duration)} %`); await pause(); }
    }
    return { frames, binHz, k0, hasTraction };
  }

  /* ---------- 3 : émergence à la fréquence attendue pour un diamètre ---------- */
  function emergence(fr, f0, binHz, k0, tol) {
    const idx = (f) => Math.round(f / binHz) - k0, db = fr.db;
    const a = Math.max(0, idx(f0 * (1 - tol))), b = Math.min(db.length - 1, Math.max(a, idx(f0 * (1 + tol))));
    let peak = -Infinity; for (let i = a; i <= b; i++) if (db[i] > peak) peak = db[i];
    const lo = Math.max(0, idx(f0 * 0.96)), hi = Math.min(db.length - 1, idx(f0 * 1.04));
    const e0 = idx(f0 * 0.988), e1 = idx(f0 * 1.012), around = [];
    for (let i = lo; i <= hi; i++) if (i < e0 || i > e1) around.push(db[i]);
    if (around.length < 8 || !Number.isFinite(peak)) return null;
    around.sort((p, q) => p - q);
    return peak - around[around.length >> 1];
  }
  function matrix(spec, diameters, tol) {
    const s1 = meshPerKmhAt1m();
    return spec.frames.map((fr) => diameters.map((D) => emergence(fr, (s1 * fr.v) / (D / 1000), spec.binHz, spec.k0, tol)));
  }
  const meanCols = (M, rows) => M[0].map((_, j) => { let s = 0, n = 0; for (const i of rows) { const v = M[i][j]; if (v !== null) { s += v; n++; } } return n ? s / n : NaN; });
  function refinePeak(D, E) {
    let i = 0; E.forEach((v, j) => { if (v > E[i]) i = j; });
    if (i <= 0 || i >= E.length - 1) return D[i];
    const l = E[i - 1], c = E[i], r = E[i + 1], den = l - 2 * c + r;
    return D[i] + (Math.abs(den) > 1e-9 ? Math.max(-1, Math.min(1, (0.5 * (l - r)) / den)) : 0) * (D[1] - D[0]);
  }

  // maxima locaux nettement au-dessus du fond de la courbe (au plus deux essieux, écart ≥ 12 mm)
  function curvePeaks(Ds, E) {
    const fin = E.filter(Number.isFinite).sort((a, b) => a - b), base = fin[Math.floor(fin.length / 2)];
    const cands = [];
    for (let j = 1; j < E.length - 1; j++) if (E[j] >= E[j - 1] && E[j] >= E[j + 1] && E[j] - base >= 3) cands.push(j);
    cands.sort((a, b) => E[b] - E[a]);
    const peaks = [];
    for (const j of cands) if (peaks.every((p) => Math.abs(Ds[p] - Ds[j]) >= 12) && peaks.length < 2) peaks.push(j);
    return { base, peaks };
  }
  // précision réaliste selon la durée de signal exploitable (essais du 30/10/2026)
  function precisionFor(n, stat = 0) {
    const p = n >= 300 ? 1.5 : n >= RELIABLE_SECONDS ? 2.5 : n >= MIN_SECONDS ? 5 : 8;
    return Math.max(p, stat);
  }
  const reliability = (n) => (n >= RELIABLE_SECONDS ? "fiable" : n >= MIN_SECONDS ? "correcte" : "en cours");

  /* ---------- 4 : recherche des pics et affinage ---------- */
  async function run() {
    const record = currentRecord(), track = speedTrack();
    if (!record?.samples) { setInfo("Chargez d’abord l’enregistrement (ou le ZIP de session).", true); return; }
    if (!track?.length) { setInfo("Associez le CSV / JSON de l’acquisition (vitesse seconde par seconde) dans « Analyse du sifflement », ou déposez le ZIP de session.", true); return; }
    state.busy = true; $id("diamRun").disabled = true;
    try {
      const spec = await collectSpectra(record, track);
      if (spec.frames.length < MIN_SECONDS) {
        state.result = null; render();
        setInfo(`Pas assez de passages exploitables (${spec.frames.length} s) : il faut au moins ${MIN_SECONDS} s ${spec.hasTraction ? "en traction " : ""}au-dessus de ${MIN_SPEED} km/h à vitesse stable (${RELIABLE_SECONDS} s pour un résultat fiable).`, true);
        return;
      }
      setInfo(`Recherche du diamètre sur ${spec.frames.length} s de signal…`); await pause();
      const Ds = []; for (let d = D_MIN; d <= D_MAX; d += 1) Ds.push(d);
      const M = matrix(spec, Ds, TOL), all = M.map((_, i) => i), E = meanCols(M, all);
      const { base, peaks } = curvePeaks(Ds, E);
      await pause();
      // affinage au demi-millimètre + incertitude (bootstrap sur les instants)
      const found = [];
      for (const j of peaks) {
        const Df = []; for (let d = Ds[j] - 6; d <= Ds[j] + 6; d += 0.5) Df.push(d);
        const Mf = matrix(spec, Df, TOL_FINE), Ef = meanCols(Mf, all);
        const d0 = refinePeak(Df, Ef), boot = [];
        for (let b = 0; b < 60; b++) { const rows = all.map(() => Math.floor(Math.random() * all.length)); boot.push(refinePeak(Df, meanCols(Mf, rows))); }
        const m = boot.reduce((a, v) => a + v, 0) / boot.length, sd = Math.sqrt(boot.reduce((a, v) => a + (v - m) ** 2, 0) / boot.length);
        found.push({ d: d0, prom: E[j] - base, em: E[j], stat: 2 * sd });
        await pause();
      }
      found.sort((a, b) => a.d - b.d);
      const vs = spec.frames.map((f) => f.v);
      state.result = { source: "fichier", record: record.name, Ds, E, base, found, n: spec.frames.length, vMin: Math.min(...vs), vMax: Math.max(...vs), traction: spec.hasTraction };
      render();
      if (found.length) apply(true);
      setInfo(found.length ? `Calcul terminé : ${found.length} diamètre(s) trouvé(s) sur ${spec.frames.length} s de signal, reportés dans les réglages E1 / E2. ${SI_ESSIEUX}` : "Calcul terminé : aucun pic net. Vérifiez la vitesse associée et la chaîne de transmission.");
    } catch (error) {
      console.error("Calcul des diamètres", error); setInfo("Erreur pendant le calcul : " + (error?.message || error), true);
    } finally { state.busy = false; $id("diamRun").disabled = !records.length; }
  }

  /* ---------- affichage ---------- */
  function draw(canvas, width, height) {
    const r = state.result, ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, width, height);
    if (!r) return;
    const L = 60, Rm = 20, T = 30, B = 44, pw = width - L - Rm, ph = height - T - B;
    const yMax = Math.max(...r.E.filter(Number.isFinite)) + 2, yMin = Math.max(0, Math.min(...r.E.filter(Number.isFinite)) - 2);
    const X = (d) => L + ((d - D_MIN) / (D_MAX - D_MIN)) * pw, Y = (e) => T + ph - ((e - yMin) / (yMax - yMin)) * ph;
    ctx.strokeStyle = "#E1E1E1"; ctx.fillStyle = "#4D4F53"; ctx.font = "12px Arial"; ctx.lineWidth = 1;
    for (let d = D_MIN; d <= D_MAX; d += 10) { ctx.beginPath(); ctx.moveTo(X(d), T); ctx.lineTo(X(d), T + ph); ctx.stroke(); ctx.fillText(String(d), X(d) - 10, height - 26); }
    for (let e = Math.ceil(yMin); e <= yMax; e += 2) { ctx.beginPath(); ctx.moveTo(L, Y(e)); ctx.lineTo(L + pw, Y(e)); ctx.stroke(); ctx.fillText(String(e), L - 24, Y(e) + 4); }
    ctx.fillText("diamètre de roue testé (mm)", L + pw / 2 - 80, height - 8);
    ctx.save(); ctx.translate(14, T + ph / 2 + 60); ctx.rotate(-Math.PI / 2); ctx.fillText("émergence moyenne (dB)", 0, 0); ctx.restore();
    // zones hors de la plage plausible 850–924 mm
    ctx.fillStyle = "rgba(60,55,50,0.05)"; ctx.fillRect(X(D_MIN), T, X(D_RETRAIT) - X(D_MIN), ph); ctx.fillRect(X(D_NEUF), T, X(D_MAX) - X(D_NEUF), ph);
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.font = "11px Arial";
    [[D_RETRAIT, "#747678", "850"], [D_NEUF, "#747678", "924"]].forEach(([d, c, t]) => { ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(X(d), T); ctx.lineTo(X(d), T + ph); ctx.stroke(); ctx.fillStyle = c; ctx.fillText(t, X(d) + 3, T + 12); });
    ctx.setLineDash([]); ctx.font = "12px Arial";
    ctx.strokeStyle = "#E05206"; ctx.lineWidth = 2; ctx.beginPath();
    r.Ds.forEach((d, j) => { if (!Number.isFinite(r.E[j])) return; j ? ctx.lineTo(X(d), Y(r.E[j])) : ctx.moveTo(X(d), Y(r.E[j])); }); ctx.stroke();
    r.found.forEach((p, i) => {
      const j = r.Ds.findIndex((d) => d >= p.d), e = r.E[Math.max(0, j)];
      ctx.fillStyle = "#3C3732"; ctx.beginPath(); ctx.arc(X(p.d), Y(e), 5, 0, 2 * Math.PI); ctx.fill();
      ctx.font = "bold 13px Arial"; ctx.fillText(`${fmt(p.d, 1)} mm`, X(p.d) + 8, Y(e) - 6); ctx.font = "12px Arial";
    });
    ctx.fillStyle = "#3C3732"; ctx.font = "bold 14px Arial"; ctx.fillText("Recherche du diamètre de roue (engrènement réducteur, tolérance ±0,3 %)", L, 18);
  }
  function rowsForTable() {
    const r = state.result; if (!r) return [];
    return r.found.map((p, i) => [r.found.length === 2 ? (i ? "Essieu 2 (plus grand)" : "Essieu 1 (plus petit)") : "Essieu(x)", `${fmt(p.d, 1)} mm`, `± ${fmt(precisionFor(r.n, p.stat), 1)} mm`, `${fmt(p.prom, 1)} dB`, p.prom < 4 ? "faible (pic peu net)" : reliability(r.n)]);
  }
  const SI_ESSIEUX = "À vérifier dans la base SI-Essieux : les diamètres calculés doivent correspondre aux deux essieux de tête (essieux moteurs de la motrice mesurée).";
  function verdict() {
    const r = state.result; if (!r) return "";
    if (!r.found.length) return "Aucun pic net : pas assez de traction stable, vitesse mal associée ou chaîne de transmission différente.";
    if (r.found.length === 1) return "Un seul pic : les deux essieux ont des diamètres proches (moins de 1,5 % d’écart environ) ou un seul essieu est audible. La valeur s’applique aux deux essieux à ± quelques millimètres. " + SI_ESSIEUX;
    return `Deux essieux distincts, écart ${fmt(r.found[1].d - r.found[0].d, 1)} mm. L’ordre E1 / E2 (position dans la motrice) ne peut pas être déduit du son. ` + SI_ESSIEUX;
  }
  function render() {
    const box = $id("diamResult"); if (!box) return;
    const r = state.result;
    $id("diamApply").disabled = !(r && r.found.length);
    if (!r) { box.innerHTML = ""; const c = $id("diamCanvas"); c.hidden = true; return; }
    const c = $id("diamCanvas"); c.hidden = false;
    const w = c.clientWidth || 900, h = 300, dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr; c.style.height = h + "px";
    const ctx = c.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw(c, w, h);
    box.innerHTML = `<div class="small"><b>Source : ${r.source === "direct" ? "acquisition en direct" : "fichier"}</b> — ${escapeHtml(r.record)} — ${r.n} s de signal retenues (${r.traction ? "traction, " : ""}${fmt(r.vMin)}–${fmt(r.vMax)} km/h, vitesse stable).</div>` +
      `<table class="diam-table"><tr><th>Essieu</th><th>Diamètre calculé</th><th>Précision</th><th>Netteté du pic</th><th>Confiance</th></tr>` +
      rowsForTable().map((row) => "<tr>" + row.map((c2) => `<td>${escapeHtml(c2)}</td>`).join("") + "</tr>").join("") + "</table>" +
      `<div class="small">${escapeHtml(verdict())} Fiabilité selon la durée de traction stable : moins de ${MIN_SECONDS} s en cours, ${MIN_SECONDS} à ${RELIABLE_SECONDS} s correcte (± 3 à 6 mm), au-delà de ${RELIABLE_SECONDS} s fiable (± 2 à 3 mm). Validé le 30/10/2026 sur deux motrices.</div>`;
  }
  // v0.9.7 RC : les diamètres calculés remplacent automatiquement les valeurs de réglage
  // (repères E1 / E2 du spectre, droites du Campbell, rapport) ; l'origine est affichée.
  state.applied = null;
  function apply(auto = false) {
    const r = state.result; if (!r?.found.length || r.n < MIN_SECONDS) return;
    const cl = (d) => Math.max(D_RETRAIT, Math.min(D_NEUF, Math.round(d)));   // réglage borné 850–924
    const d1 = cl(r.found[0].d), d2 = cl((r.found[1] || r.found[0]).d);
    const prev = state.applied;
    state.applied = { d1, d2, source: r.source, n: r.n, record: r.record, reliability: reliability(r.n), single: r.found.length === 1 };
    if (!prev || prev.d1 !== d1 || prev.d2 !== d2) {
      [["transWheelDiameter1", d1], ["transWheelDiameter2", d2]].forEach(([id, d]) => {
        const el = $id(id); if (!el) return; el.value = d; el.dataset.calcule = "1";
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    showOrigin();
    try { window.DiagnosticTGV?.refresh?.(); } catch (e) { /* préconisations recalculées avec les nouveaux diamètres */ }
    if (!auto) setInfo(`Diamètres calculés appliqués : E1 = ${d1} mm, E2 = ${d2} mm. ${SI_ESSIEUX}`);
    if (!$id("diagnosticMode")?.classList.contains("hidden")) render();
  }
  function showOrigin() {
    let box = $id("diamOrigin");
    const grid = document.querySelector("#transmissionReference .axle-diameter-grid");
    if (!box && grid) { box = document.createElement("div"); box.id = "diamOrigin"; box.className = "small diam-origin"; grid.after(box); }
    if (!box) return;
    const a = state.applied, manual = ["transWheelDiameter1", "transWheelDiameter2"].some((id) => $id(id) && !$id(id).dataset.calcule);
    box.innerHTML = a && !manual
      ? `<b>Diamètres calculés</b> à partir du sifflement (${a.source === "direct" ? "acquisition en direct" : "fichier"}, ${a.n} s, ${a.reliability}) — à vérifier dans SI-Essieux (2 essieux de tête).`
      : "<b>Diamètres non calculés</b> : valeurs de réglage. Lancez « Calculer les diamètres E1 / E2 » (onglet Diagnostic) ou faites une acquisition en traction.";
    box.dataset.calc = a && !manual ? "1" : "";
  }
  function calculated() { const a = state.applied, manual = ["transWheelDiameter1", "transWheelDiameter2"].some((id) => $id(id) && !$id(id).dataset.calcule); return a && !manual ? a : null; }
  // section du rapport PDF complet
  function appendToReport(container) {
    const r = state.result; if (!r?.found.length) return;
    const section = document.createElement("section");
    section.style.breakInside = "avoid";
    section.innerHTML = "<h2>Diamètres de roue calculés à partir du sifflement</h2>";
    const c = document.createElement("canvas"); c.width = 1100; c.height = 360; draw(c, 1100, 360);
    section.appendChild(createReportImage(c.toDataURL("image/png"), "Recherche du diamètre de roue"));
    section.appendChild(makeSimpleTable(["Essieu", "Diamètre calculé", "Précision", "Netteté du pic", "Confiance"], rowsForTable()));
    const p = document.createElement("div"); p.style.cssText = "font-size:12px;margin:6px 0 12px";
    p.textContent = `${r.record} — ${r.n} s de signal retenues (${fmt(r.vMin)}–${fmt(r.vMax)} km/h). ${verdict()}`;
    section.appendChild(p); container.appendChild(section);
  }
  function init() {
    if (!$id("diamSection")) return;
    $id("diamRun").addEventListener("click", run);
    $id("diamApply").addEventListener("click", () => apply(false));
    // une saisie à la main redevient une valeur « saisie »
    ["transWheelDiameter1", "transWheelDiameter2"].forEach((id) => $id(id)?.addEventListener("input", (e) => { if (e.isTrusted) { delete e.target.dataset.calcule; showOrigin(); } }));
    showOrigin();
    $id("diamShowLive")?.addEventListener("click", () => { if (live.result) { showLive(); setInfo("Affichage du calcul en direct de l’acquisition."); } else setInfo("Pas encore de calcul en direct : démarrez une acquisition et passez en traction stable au-dessus de 150 km/h.", true); });
    const sync = () => { $id("diamRun").disabled = state.busy || !records.length; };
    new MutationObserver(sync).observe($id("toneRecord"), { childList: true }); sync();
    window.addEventListener("resize", () => state.result && render());
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  /* ---------- 5 : calcul en temps réel pendant l'acquisition ---------- */
  const live = { an: null, buf: null, sr: 0, sum: null, cnt: null, n: 0, speeds: [], vMin: Infinity, vMax: -Infinity, lastPeaks: 0, result: null, reason: "" };
  const LIVE_DS = []; for (let d = D_MIN; d <= D_MAX; d += 1) LIVE_DS.push(d);
  function liveReset() {
    live.sum = new Float64Array(LIVE_DS.length); live.cnt = new Uint32Array(LIVE_DS.length);
    live.n = 0; live.speeds = []; live.vMin = Infinity; live.vMax = -Infinity; live.result = null; live.reason = "";
  }
  function liveAccel(now) {
    const pts = live.speeds.filter(([t, v]) => Number.isFinite(v) && now - t <= 8);
    if (pts.length < 6 || pts.at(-1)[0] - pts[0][0] < 5) return null;
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let sxy = 0, sxx = 0; pts.forEach(([x, y]) => { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; });
    return sxx ? sxy / sxx / 3.6 : null;
  }
  function liveBox() {
    const box = $id("diamLiveBox"); if (!box) return;
    const r = live.result, running = typeof acqRunning !== "undefined" && acqRunning;
    if (!running && !r) { box.textContent = "Diamètres en direct : en attente de traction stable au-dessus de 150 km/h."; box.dataset.state = ""; return; }
    const dur = live.n >= 60 ? `${Math.floor(live.n / 60)} min ${String(live.n % 60).padStart(2, "0")} s` : `${live.n} s`;
    const vals = r?.found?.length ? r.found.map((p) => `${fmt(p.d, 0)} mm`).join(" / ") : "—";
    box.innerHTML = `<b>Diamètres en direct :</b> ${vals} — ${dur} de traction stable — <b>${reliability(live.n)}</b>` + (live.reason && running ? ` <span class="small">(${escapeHtml(live.reason)})</span>` : "");
    box.dataset.state = reliability(live.n);
  }
  function liveCompute() {
    const E = LIVE_DS.map((_, j) => (live.cnt[j] ? live.sum[j] / live.cnt[j] : NaN));
    const { base, peaks } = curvePeaks(LIVE_DS, E);
    const found = peaks.map((j) => {
      let d = LIVE_DS[j];
      if (j > 0 && j < E.length - 1) { const l = E[j - 1], c = E[j], r = E[j + 1], den = l - 2 * c + r; if (Math.abs(den) > 1e-9) d += Math.max(-1, Math.min(1, (0.5 * (l - r)) / den)); }
      return { d, prom: E[j] - base, em: E[j], stat: 0 };
    }).sort((a, b) => a.d - b.d);
    live.result = { source: "direct", record: "Acquisition en cours sur cet appareil", Ds: LIVE_DS, E, base, found, n: live.n, vMin: live.vMin, vMax: live.vMax, traction: true };
    // l'affichage de l'onglet Diagnostic suit le direct tant qu'aucun calcul sur fichier n'a été demandé
    if (!state.result || state.result.source === "direct") { state.result = live.result; if (!$id("diagnosticMode")?.classList.contains("hidden")) render(); if (live.n >= MIN_SECONDS && found.length) apply(true); }
  }
  function liveTick() {
    const running = typeof acqRunning !== "undefined" && acqRunning;
    if (!running) {
      if (live.an) { try { acqSourceNode?.disconnect(live.an); } catch (e) {} live.an = null; if (live.n) liveCompute(); liveBox(); }
      return;
    }
    if (!live.an) {
      if (typeof acqAudioContext === "undefined" || !acqAudioContext || !acqSourceNode) return;
      liveReset();
      const an = acqAudioContext.createAnalyser(); an.fftSize = 32768; an.smoothingTimeConstant = 0;
      acqSourceNode.connect(an); live.an = an; live.buf = new Float32Array(an.frequencyBinCount); live.sr = acqAudioContext.sampleRate;
    }
    const now = performance.now() / 1000, v = Number.isFinite(acqCurrentSpeed) ? acqCurrentSpeed : null;
    live.speeds.push([now, v]); while (live.speeds.length && now - live.speeds[0][0] > 10) live.speeds.shift();
    const regime = $id("acqRegime")?.value, a = liveAccel(now);
    live.reason = regime !== "Traction" ? "régime saisi : " + (regime || "—") : !(v >= MIN_SPEED) ? `vitesse < ${MIN_SPEED} km/h ou inconnue` : a === null ? "vitesse GPS en cours de stabilisation" : Math.abs(a) > MAX_ACCEL ? "accélération ou freinage" : "";
    if (!live.reason) {
      live.an.getFloatFrequencyData(live.buf);
      const binHz = (live.sr / live.an.fftSize) * frequencyCalibrationFactorFor(live.sr), s1 = meshPerKmhAt1m(), fr = { db: live.buf };
      LIVE_DS.forEach((D, j) => { const e = emergence(fr, (s1 * v) / (D / 1000), binHz, 0, TOL); if (e !== null && Number.isFinite(e)) { live.sum[j] += e; live.cnt[j]++; } });
      live.n++; live.vMin = Math.min(live.vMin, v); live.vMax = Math.max(live.vMax, v);
      if (live.n >= 20 && now - live.lastPeaks >= 5) { live.lastPeaks = now; liveCompute(); }
    }
    liveBox();
  }
  setInterval(() => { try { liveTick(); } catch (error) { console.warn("Diamètres en direct", error); } }, 1000);
  // résumé enregistré dans le JSON de la session
  function liveExport() {
    if (!live.n) return null;
    if (!live.result) liveCompute();
    return { methode: "engrènement réducteur, tolérance ±0,3 %", secondesRetenues: live.n, fiabilite: reliability(live.n),
      vitesseMinKmh: Number(live.vMin.toFixed(1)), vitesseMaxKmh: Number(live.vMax.toFixed(1)),
      diametresMm: live.result.found.map((p) => Number(p.d.toFixed(1))), precisionMm: precisionFor(live.n) };
  }
  function showLive() { if (live.result) { state.result = live.result; render(); } }

  window.DiametresTGV = { horsCotes, run, appendToReport, state, liveExport, showLive, calculated, SI_ESSIEUX, _live: live };
})();
