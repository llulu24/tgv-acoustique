/* Analyse Acoustique TGV — v0.9.6
 * Onglet « Analyse de fichiers » : analyse de la fréquence gênante d'un fichier audio.
 * Suivi de la fréquence dans le temps, spectre en ordres (vitesse compensée),
 * bandes latérales 1/27, 1/41, 1/51, harmonique 2, identification de l'organe,
 * vitesse par saisie, rampe ou CSV d'acquisition, envoi vers le diagramme de Campbell,
 * rapport HTML simple.
 */
"use strict";
/* MÉTHODE — ANALYSE FINE DU SIFFLEMENT D'UN FICHIER
 * Objectif : identifier précisément l'organe qui produit le sifflement, à partir d'un
 * enregistrement, même quand la vitesse varie pendant l'enregistrement.
 * Étapes :
 *   1. SUIVI (trackTone) : spectre toutes les ≥ 0,25 s, recherche du pic dans la plage
 *      choisie (1 300–1 900 Hz par défaut), émergence et rapport tonal pour chaque instant.
 *   2. SÉLECTION (longestRun) : plus longue période continue où le pic est tonal
 *      (émergence ≥ 10 dB, trous ≤ 2 s, sauts de fréquence ≤ 25 Hz), limitée à 120 s
 *      autour du niveau maximal.
 *   3. COURBE DE FRÉQUENCE (polyfit + buildTrack) : la fréquence suivie est lissée ;
 *      les points aberrants (> 3 écarts-types) sont éliminés.
 *   4. SPECTRE EN ORDRES (orderSpectrum) : le signal est rééchantillonné en suivant cette
 *      courbe, ce qui « fige » le sifflement à une fréquence constante. On obtient alors une
 *      résolution très fine (≈ 0,1 Hz sur 10 s) sans que la variation de vitesse étale le pic.
 *   5. BANDES LATÉRALES (analyseOrders) aux ordres 1 ± 1/27, 1 ± 1/41, 1 ± 1/51 et autour
 *      de l'harmonique 2 : l'arbre en cause est celui dont les bandes ressortent.
 *   6. IDENTIFICATION : avec la vitesse (fichier, rampe ou CSV d'acquisition), comparaison
 *      de la fréquence avec l'engrènement réducteur et pont pour E1 et E2, et diamètre
 *      équivalent. */

(() => {
  const $id = (id) => document.getElementById(id);
  const SIDEBANDS = [
    { teeth: 27, label: "rotation moteur (pignon 27 dents)", short: "moteur 27 dents" },
    { teeth: 41, label: "rotation de la roue intermédiaire (41 dents)", short: "roue intermédiaire 41 dents" },
    { teeth: 51, label: "rotation de la roue de sortie du réducteur (51 dents)", short: "roue de sortie 51 dents" },
  ];
  const CHAINS = [
    { key: "meshReducer", label: "engrènement réducteur" },
    { key: "meshBridge", label: "engrènement pont" },
  ];
  const GRID_STEP = 5, GRID_MAX = 2500, GRID_N = GRID_MAX / GRID_STEP + 1;
  const state = { result: null, speedTrack: null, busy: false };

  const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d).replace(".", ",") : "—");
  const esc = (t) => (typeof escapeHtml === "function" ? escapeHtml(String(t)) : String(t));
  const dbToPow = (db) => Math.pow(10, db / 10);
  const powToDb = (p) => (p > 0 ? 10 * Math.log10(p) : -200);
  const median = (arr) => { const a = arr.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const pause = () => new Promise((r) => setTimeout(r, 0));
  const criticalBandHz = (f) => 25 + 75 * Math.pow(1 + 1.4 * Math.pow(f / 1000, 2), 0.69);
  const chainSlope = (key, d) => { const f = transmissionFrequencies(100, d); return f ? f[key] / 100 : null; };
  function setInfo(text, error = false) { const el = $id("toneStatus"); el.textContent = text; el.classList.toggle("status-error", error); }

  /* ---------- sélection du fichier ---------- */
  function refreshSelector() {
    const sel = $id("toneRecord"); if (!sel) return;
    const previous = sel.value;
    sel.innerHTML = "";
    records.forEach((r) => { const o = document.createElement("option"); o.value = String(r.id); o.textContent = r.name + (r.speed ? ` — ${r.speed} km/h` : ""); sel.appendChild(o); });
    if ([...sel.options].some((o) => o.value === previous)) sel.value = previous;
    $id("toneRun").disabled = !records.length || state.busy;
    if (!records.length) { state.result = null; render(); }
  }
  const currentRecord = () => records.find((r) => String(r.id) === $id("toneRecord")?.value) || records[0];

  /* ---------- vitesse : CSV > rampe > vitesse du fichier ---------- */
  /* Vitesse à l'instant t du fichier, par ordre de priorité :
   *   1. CSV / JSON d'acquisition associé : interpolation linéaire entre les deux lignes
   *      qui encadrent t (avec un décalage réglable si le son et le CSV ne démarrent pas
   *      ensemble) ; le régime est celui de la ligne la plus proche ;
   *   2. rampe saisie (vitesse début → fin), supposée linéaire ;
   *   3. vitesse unique saisie pour le fichier. */
  function speedAt(t, record) {
    const offset = parseFloat($id("toneCsvOffset")?.value) || 0;
    if (state.speedTrack?.length) {
      const tt = t + offset, tr = state.speedTrack;
      if (tt < tr[0].t - 2 || tt > tr.at(-1).t + 2) return { v: null, regime: null };
      let i = 1; while (i < tr.length && tr[i].t < tt) i++;
      const a = tr[Math.max(0, i - 1)], b = tr[Math.min(tr.length - 1, i)];
      const regime = Math.abs(a.t - tt) <= Math.abs(b.t - tt) ? a.regime : b.regime;
      if (!Number.isFinite(a.v) || !Number.isFinite(b.v)) return { v: Number.isFinite(a.v) ? a.v : Number.isFinite(b.v) ? b.v : null, regime };
      const u = b.t > a.t ? (tt - a.t) / (b.t - a.t) : 0;
      return { v: a.v + (b.v - a.v) * Math.max(0, Math.min(1, u)), regime };
    }
    const v0 = parseFloat($id("toneSpeedStart")?.value), v1 = parseFloat($id("toneSpeedEnd")?.value);
    if (Number.isFinite(v0) && Number.isFinite(v1) && record.duration > 0) return { v: v0 + (v1 - v0) * Math.max(0, Math.min(1, t / record.duration)), regime: record.regime };
    const v = parseFloat(record.speed);
    return { v: Number.isFinite(v) && v > 0 ? v : null, regime: record.regime };
  }
  function speedSourceLabel() {
    if (state.speedTrack?.length) return "CSV d’acquisition associé";
    if (Number.isFinite(parseFloat($id("toneSpeedStart")?.value)) && Number.isFinite(parseFloat($id("toneSpeedEnd")?.value))) return "rampe saisie (début → fin)";
    return "vitesse du fichier (constante)";
  }
  async function loadSpeedFile(file) {
    const text = await file.text();
    let track = [];
    if (/\.json$/i.test(file.name) || text.trim().startsWith("{")) {
      const obj = JSON.parse(text);
      const samples = Array.isArray(obj.samples) ? obj.samples : [];
      track = samples.map((s) => ({ t: Number(s.elapsed), v: s.speed === null ? null : Number(s.speed), regime: s.regime || obj.identity?.regime || "" }));
    } else {
      const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
      const parse = (l) => l.split(";").map((c) => c.trim().replace(/^"|"$/g, "").replace(/""/g, '"').replace(/^'/, ""));
      const head = parse(lines[0]);
      const it = head.indexOf("temps_s"), iv = head.indexOf("vitesse_kmh"), ir = head.indexOf("regime");
      if (it < 0 || iv < 0) throw new Error("Colonnes temps_s et vitesse_kmh introuvables (CSV d’acquisition attendu).");
      track = lines.slice(1).map(parse).map((c) => ({ t: parseFloat(c[it].replace(",", ".")), v: c[iv] === "" ? null : parseFloat(c[iv].replace(",", ".")), regime: ir >= 0 ? c[ir] : "" }));
    }
    track = track.filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
    if (!track.some((p) => Number.isFinite(p.v))) throw new Error("Aucune vitesse dans ce fichier.");
    // vitesses nulles en tout début d'acquisition (valeur par défaut avant la première saisie) : ignorées
    const firstMoving = track.findIndex((p) => Number.isFinite(p.v) && p.v > 0);
    if (firstMoving > 0) for (let i = 0; i < firstMoving; i++) track[i].v = null;
    state.speedTrack = track;
    window.CarteTrajetTGV?.loadFromText(text, file.name); // v0.9.6 : carte du trajet GPS
    const vs = track.map((p) => p.v).filter(Number.isFinite);
    $id("toneCsvState").textContent = `${file.name} : ${track.length} points, ${fmt(Math.min(...vs))}–${fmt(Math.max(...vs))} km/h, ${fmt(track.at(-1).t, 0)} s.`;
    $id("toneCsvClear").disabled = false;
    // v0.9.6 : vitesse réelle reportée sur le fichier (repères E1/E2 du spectre) si elle n'est pas saisie
    const rec = currentRecord();
    const moving = track.map((p) => p.v).filter((v) => Number.isFinite(v) && v > 5).sort((a, b) => a - b);
    if (rec && !(parseFloat(rec.speed) > 0) && moving.length) {
      rec.speed = moving[Math.floor(moving.length / 2)].toFixed(0);
      rec.speedRange = [moving[0], moving.at(-1)];
      if (typeof renderFileList === "function") renderFileList();
      if (typeof drawCurrent === "function") drawCurrent();
    }
    const regs = track.map((p) => p.regime).filter((r) => r && r !== "Non renseigné");
    if (rec && regs.length && (!rec.regime || rec.regime === "Non renseigné")) {
      const counts = {}; regs.forEach((r) => (counts[r] = (counts[r] || 0) + 1));
      rec.regime = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      if (typeof renderFileList === "function") renderFileList();
    }
  }

  /* ---------- 1. suivi de la fréquence trame par trame ---------- */
  /* Étape 1 — suivi du pic dans le temps.
   * FFT de ≈ 1 s (8 192 points à 8 kHz, pas en fréquence ≈ 1 Hz) avec fenêtre de Hann.
   * Le pas entre deux spectres s'adapte à la durée (≈ 3 000 spectres au plus) pour qu'un
   * enregistrement de 2 h reste rapide à analyser.
   * Pour chaque spectre : fréquence et niveau du pic (interpolation parabolique),
   * rapport tonal (bande critique), émergence (pic − médiane ±60 Hz), énergie de la bande
   * 1 500–1 700 Hz et spectre réduit sur une grille de 5 Hz (pour le Campbell). */
  async function trackTone(record, fLo, fHi) {
    // v0.9.8 Rust : noyau WebAssembly si disponible, sinon le calcul JavaScript ci-dessous.
    if (window.TgvCore?.available && window.TgvCore.fits(record.samples.length)) {
      try {
        setInfo("Suivi du sifflement (noyau Rust)…"); await pause();
        return window.TgvCore.trackTone(record, fLo, fHi, frequencyCalibrationFactorFor(record.sourceSampleRate || record.sampleRate));
      } catch (e) { console.warn("Noyau Rust (suivi) : repli sur le JavaScript", e); }
    }
    const x = record.samples, sr = record.sampleRate;
    // pas adapté à la durée : au plus ~3 000 trames, même pour un enregistrement de 2 h
    const N = Math.pow(2, Math.round(Math.log2(sr * 1.024))), hop = Math.round(sr * Math.max(0.25, record.duration / 3000)), bins = N >> 1;
    const binHz = (sr / N) * frequencyCalibrationFactorFor(record.sourceSampleRate || sr);
    const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = hann(i, N);
    const frames = [], frame = new Float64Array(N), lev = new Float64Array(bins);
    const total = Math.max(1, Math.floor((x.length - N) / hop) + 1);
    for (let fi = 0, start = 0; start + N <= x.length; fi++, start += hop) {
      let mean = 0; for (let i = 0; i < N; i++) mean += x[start + i]; mean /= N;
      for (let i = 0; i < N; i++) frame[i] = (x[start + i] - mean) * win[i];
      const F = fftReal(frame);
      for (let k = 0; k < bins; k++) lev[k] = 10 * Math.log10((F.re[k] * F.re[k] + F.im[k] * F.im[k]) / (N * N) + 1e-20);
      let best = -1;
      for (let k = Math.ceil(fLo / binHz); k <= Math.floor(fHi / binHz) && k < bins - 1; k++) if (best < 0 || lev[k] > lev[best]) best = k;
      let peakHz = null, peakDb = null, tnr = null, prom = null;
      if (best > 0) {
        const l = lev[best - 1], c = lev[best], r = lev[best + 1], den = l - 2 * c + r;
        const d = Math.abs(den) > 1e-9 ? Math.max(-1, Math.min(1, (0.5 * (l - r)) / den)) : 0;
        peakHz = (best + d) * binHz; peakDb = c - 0.25 * (l - r) * d;
        const cb = criticalBandHz(peakHz), lo = Math.max(1, Math.round((peakHz - cb / 2) / binHz)), hi = Math.min(bins - 1, Math.round((peakHz + cb / 2) / binHz));
        let tp = 0, np = 0, nb = 0;
        for (let k = lo; k <= hi; k++) { if (Math.abs(k - best) <= 2) tp += dbToPow(lev[k]); else { np += dbToPow(lev[k]); nb++; } }
        if (nb && tp > 0) tnr = 10 * Math.log10(tp / ((np / nb) * (hi - lo + 1)));
        const w = Math.max(30, Math.round(60 / binHz)), around = [];
        for (let k = Math.max(1, best - w); k <= Math.min(bins - 1, best + w); k++) if (Math.abs(k - best) > 3) around.push(lev[k]);
        around.sort((p, q) => p - q);
        prom = peakDb - around[Math.floor(around.length / 2)];
      }
      let bp = 0; for (let k = Math.ceil(1500 / binHz); k <= Math.floor(1700 / binHz) && k < bins; k++) bp += dbToPow(lev[k]);
      const spec = new Float32Array(GRID_N);
      for (let g = 0; g < GRID_N; g++) {
        const f = g * GRID_STEP, a = Math.max(0, Math.ceil((f - 2.5) / binHz)), b = Math.min(bins - 1, Math.floor((f + 2.5) / binHz));
        let v = -160; for (let k = a; k <= b; k++) v = Math.max(v, lev[k]); spec[g] = v;
      }
      frames.push({ t: (start + N / 2) / sr, peakHz, peakDb, tnr, prom, bandDb: powToDb(bp), spec });
      if (fi % 40 === 0) { setInfo(`Suivi du sifflement : ${Math.round((100 * fi) / total)} %`); await pause(); }
    }
    return { frames, N, binHz, sr };
  }

  /* trames tonales continues : plus longue suite avec trous ≤ 2 s, fréquence continue */
  function longestRun(frames) {
    const ok = frames.map((f) => Number.isFinite(f.peakHz) && Number.isFinite(f.prom) && f.prom >= 10);
    let best = null, cur = null, lastOk = -1;
    for (let i = 0; i < frames.length; i++) {
      if (!ok[i]) continue;
      const jump = lastOk >= 0 ? Math.abs(frames[i].peakHz - frames[lastOk].peakHz) : 0;
      if (cur && frames[i].t - frames[lastOk].t <= 2.01 && jump <= 25) cur.end = i;
      else { cur = { start: i, end: i }; }
      lastOk = i;
      if (!best || cur.end - cur.start > best.end - best.start) best = { ...cur };
    }
    return best;
  }
  /* Ajustement polynomial par moindres carrés (degré 1 ou 2), résolu par élimination de
   * Gauss-Jordan. Sert à repérer les points aberrants du suivi de fréquence. */
  function polyfit(ts, ys, deg) {
    const n = deg + 1, A = Array.from({ length: n }, () => new Float64Array(n + 1));
    ts.forEach((t, i) => { for (let r = 0; r < n; r++) { for (let c = 0; c < n; c++) A[r][c] += Math.pow(t, r + c); A[r][n] += ys[i] * Math.pow(t, r); } });
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      for (let r = 0; r < n; r++) if (r !== c) { const m = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= m * A[c][k]; }
    }
    return Array.from({ length: n }, (_, i) => A[i][n] / A[i][i]);
  }

  /* ---------- 2. spectre en ordres (vitesse compensée) ---------- */
  /* suivi lissé de la fréquence : interpolation linéaire, phase intégrée exactement par segment */
  /* Courbe de fréquence et PHASE du sifflement.
   * La fréquence mesurée est lissée (moyenne glissante sur 5 points) puis interpolée
   * linéairement entre les points. La phase φ(t) = nombre de « cycles » d'engrènement
   * écoulés = intégrale de la fréquence ; elle est calculée exactement sur chaque segment
   * (fréquence linéaire → phase du second degré). */
  function buildTrack(ts, fs, tA, tB) {
    const sm = fs.map((_, i) => { const a = fs.slice(Math.max(0, i - 2), i + 3); return a.reduce((p, q) => p + q, 0) / a.length; });
    const T = [tA, ...ts, tB], F = [sm[0], ...sm, sm.at(-1)];
    const cum = [0];
    for (let j = 1; j < T.length; j++) cum.push(cum[j - 1] + ((F[j - 1] + F[j]) / 2) * (T[j] - T[j - 1]));
    const seg = (t) => { let lo = 0, hi = T.length - 2; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m] <= t) lo = m; else hi = m - 1; } return lo; };
    const fAt = (t) => { if (t <= T[0]) return F[0]; if (t >= T.at(-1)) return F.at(-1); const j = seg(t), u = (t - T[j]) / (T[j + 1] - T[j] || 1); return F[j] + (F[j + 1] - F[j]) * u; };
    const phiAt = (t) => { const tt = Math.max(T[0], Math.min(T.at(-1), t)), j = seg(tt), dt = tt - T[j], k = (F[j + 1] - F[j]) / (T[j + 1] - T[j] || 1); return cum[j] + F[j] * dt + 0.5 * k * dt * dt; };
    return { fAt, phiAt, smoothed: sm };
  }

  /* Étape 4 — spectre en ordres (« order tracking »).
   * Principe : au lieu de prélever le signal à intervalle de TEMPS régulier, on le prélève
   * à intervalle de PHASE régulier (un nombre fixe d'échantillons par cycle du sifflement).
   * Le sifflement devient alors parfaitement stationnaire, même si le train accélère.
   * Les valeurs entre deux échantillons sont obtenues par interpolation linéaire.
   * La FFT de ce signal donne un spectre gradué en ORDRES : ordre 1 = le sifflement,
   * ordre 2 = son harmonique, ordre 1 ± 1/27 = bandes latérales de l'arbre moteur, etc. */
  async function orderSpectrum(record, tA, tB, track) {
    const x = record.samples, sr = record.sampleRate;
    const { fAt, phiAt } = track;
    const iA = Math.max(0, Math.ceil(tA * sr)), iB = Math.min(x.length - 1, Math.floor(tB * sr));
    const phiEnd = phiAt(iB / sr);
    let M = 1; while (M * 2 <= iB - iA && M * 2 <= 1 << 20) M *= 2;
    const dphi = phiEnd / M, out = new Float64Array(M);
    let k = iA, phiK = phiAt(k / sr), phiK1 = phiAt((k + 1) / sr);
    for (let j = 0; j < M; j++) {
      const target = j * dphi;
      while (phiK1 < target && k < iB - 1) { k++; phiK = phiK1; phiK1 = phiAt((k + 1) / sr); }
      const u = phiK1 > phiK ? (target - phiK) / (phiK1 - phiK) : 0;
      out[j] = (x[k] * (1 - u) + x[k + 1] * u) * hann(j, M);
    }
    await pause();
    const F = fftReal(out), half = M >> 1, db = new Float32Array(half);
    for (let i = 0; i < half; i++) db[i] = 10 * Math.log10(F.re[i] * F.re[i] + F.im[i] * F.im[i] + 1e-30);
    const orderStep = 1 / (M * dphi); // ordre de la fréquence par case
    const fMid = fAt((tA + tB) / 2);
    return { db, orderStep, fMid, duration: tB - tA, cycles: phiEnd };
  }
  function levelAtOrder(os, order, halfWidth) {
    const a = Math.max(0, Math.floor((order - halfWidth) / os.orderStep)), b = Math.min(os.db.length - 1, Math.ceil((order + halfWidth) / os.orderStep));
    let best = -Infinity, at = null;
    for (let i = a; i <= b; i++) if (os.db[i] > best) { best = os.db[i]; at = i * os.orderStep; }
    return { db: best, order: at };
  }
  /* Étape 5 — lecture du spectre en ordres.
   * Fond de référence = médiane des niveaux entre les ordres 0,9 et 1,1.
   * Pour chaque arbre (27, 41, 51 dents) : niveau des bandes à 1 − 1/z et 1 + 1/z, et leur
   * émergence au-dessus du fond ; idem autour de l'harmonique 2 (ordre 2 ± 1/z).
   * Recherche aussi d'autres modulations SYMÉTRIQUES non prévues (les deux côtés à plus de
   * 15 dB du fond, écart entre eux ≤ 8 dB) : elles peuvent venir d'un autre organe
   * (roulement, pont…). */
  function analyseOrders(os) {
    const res = Math.max(4 * os.orderStep, 0.0004);
    const tone = levelAtOrder(os, 1, res);
    const floorBins = [];
    for (let i = Math.floor(0.9 / os.orderStep); i <= Math.ceil(1.1 / os.orderStep) && i < os.db.length; i++) floorBins.push(os.db[i]);
    const floor = median(floorBins);
    const rel = (db) => db - tone.db;
    const sb = SIDEBANDS.map((b) => {
      const o = 1 / b.teeth, lo = levelAtOrder(os, 1 - o, res), hi = levelAtOrder(os, 1 + o, res);
      const h2lo = levelAtOrder(os, 2 - o, res), h2hi = levelAtOrder(os, 2 + o, res);
      return { ...b, spacingHz: os.fMid / b.teeth, lowRel: rel(lo.db), highRel: rel(hi.db), emergence: powToDb((dbToPow(lo.db) + dbToPow(hi.db)) / 2) - floor, h2: powToDb((dbToPow(h2lo.db) + dbToPow(h2hi.db)) / 2) };
    });
    const h2 = levelAtOrder(os, 2, 2 * res);
    const floor2Bins = []; for (let i = Math.floor(1.9 / os.orderStep); i <= Math.ceil(2.1 / os.orderStep) && i < os.db.length; i++) floor2Bins.push(os.db[i]);
    const floor2 = median(floor2Bins);
    sb.forEach((b) => (b.h2Emergence = Number.isFinite(floor2) ? b.h2 - floor2 : null));
    // autres modulations symétriques non identifiées
    const others = [];
    const lim = Math.round(0.08 / os.orderStep), c = Math.round(1 / os.orderStep), excl = Math.round(res / os.orderStep) + 2;
    for (let k = excl; k <= lim; k++) {
      const a = os.db[c - k], b = os.db[c + k];
      const isMax = (i) => os.db[i] >= os.db[i - 1] && os.db[i] >= os.db[i + 1];
      if (!isMax(c - k) && !isMax(c + k)) continue;
      const e = powToDb((dbToPow(a) + dbToPow(b)) / 2) - floor;
      if (Math.min(a, b) - floor < 15 || Math.abs(a - b) > 8) continue;
      const off = k * os.orderStep;
      if (off * os.fMid < 3) continue;
      if (SIDEBANDS.some((s) => Math.abs(off - 1 / s.teeth) < 3 * res || Math.abs(off - 2 / s.teeth) < 3 * res)) continue;
      if (others.every((o) => Math.abs(o.off - off) > 4 * res)) others.push({ off, e, hz: off * os.fMid, lowRel: rel(a), highRel: rel(b) });
    }
    others.sort((p, q) => q.e - p.e);
    return { toneDb: tone.db, floor, toneEmergence: tone.db - floor, sb, h2Rel: rel(h2.db), h2Emergence: Number.isFinite(floor2) ? h2.db - floor2 : null, others: others.slice(0, 3) };
  }

  /* ---------- analyse complète ---------- */
  async function run() {
    const record = currentRecord();
    if (!record?.samples) { setInfo("Chargez un fichier audio.", true); return; }
    const fLo = Math.max(100, parseFloat($id("toneLo").value) || 1300), fHi = Math.min(record.sampleRate / 2 - 50, parseFloat($id("toneHi").value) || 1900);
    if (fHi - fLo < 50) { setInfo("Plage de recherche invalide.", true); return; }
    state.busy = true; $id("toneRun").disabled = true;
    try {
      const tr = await trackTone(record, fLo, fHi);
      const runIdx = longestRun(tr.frames);
      if (!runIdx || runIdx.end - runIdx.start < 6) {
        state.result = { record, tr, error: `Aucun sifflement continu trouvé entre ${fLo} et ${fHi} Hz (émergence ≥ 10 dB au-dessus du bruit voisin pendant au moins 1,5 s). Élargissez la plage de recherche ou vérifiez le spectre individuel.` };
        render(); setInfo("Analyse terminée : pas de sifflement exploitable."); return;
      }
      let runFrames = tr.frames.slice(runIdx.start, runIdx.end + 1).filter((f) => Number.isFinite(f.peakHz) && f.prom >= 10);
      // fenêtre de 120 s maximum, centrée sur le niveau de bande le plus fort
      if (runFrames.at(-1).t - runFrames[0].t > 120) {
        const peak = runFrames.reduce((a, b) => (b.bandDb > a.bandDb ? b : a));
        const t0 = Math.max(runFrames[0].t, Math.min(peak.t - 60, runFrames.at(-1).t - 120));
        runFrames = runFrames.filter((f) => f.t >= t0 && f.t <= t0 + 120);
      }
      const ts = runFrames.map((f) => f.t), fs = runFrames.map((f) => f.peakHz);
      const tc = (ts[0] + ts.at(-1)) / 2, span = ts.at(-1) - ts[0];
      let coef = polyfit(ts.map((t) => t - tc), fs, span > 20 ? 2 : 1);
      const resid = () => fs.map((f, i) => f - coef.reduce((s, c, k) => s + c * Math.pow(ts[i] - tc, k), 0));
      let r = resid(), sd = Math.sqrt(r.reduce((s, v) => s + v * v, 0) / r.length);
      // rejet des points aberrants puis nouvel ajustement
      const keep = r.map((v) => Math.abs(v) <= Math.max(3, 3 * sd));
      if (keep.filter(Boolean).length >= 6 && keep.some((k) => !k)) {
        const ts2 = ts.filter((_, i) => keep[i]), fs2 = fs.filter((_, i) => keep[i]);
        coef = polyfit(ts2.map((t) => t - tc), fs2, span > 20 ? 2 : 1);
        const r2 = fs2.map((f, i) => f - coef.reduce((s, c, k) => s + c * Math.pow(ts2[i] - tc, k), 0));
        sd = Math.sqrt(r2.reduce((s, v) => s + v * v, 0) / r2.length);
      }
      const half = tr.N / 2 / tr.sr, tA = Math.max(0, ts[0] - half), tB = Math.min(record.duration, ts.at(-1) + half);
      // suivi mesuré lissé (s'adapte à une montée puis un palier), points aberrants exclus
      const r3 = fs.map((f, i) => f - coef.reduce((s2, c, k) => s2 + c * Math.pow(ts[i] - tc, k), 0));
      const keep3 = r3.map((v) => Math.abs(v) <= Math.max(6, 4 * sd));
      const tk = ts.filter((_, i) => keep3[i]), fk = fs.filter((_, i) => keep3[i]);
      const track = buildTrack(tk, fk, tA, tB);
      sd = Math.sqrt(fk.reduce((a, f, i) => a + (f - track.smoothed[i]) ** 2, 0) / fk.length);
      setInfo("Spectre en ordres (vitesse compensée)…"); await pause();
      const os = await orderSpectrum(record, tA, tB, track);
      const ord = analyseOrders(os);
      state.result = { record, tr, runFrames, coef, tc, sd, tA, tB, os, ord, fLo, fHi, track, speedSource: speedSourceLabel() };
      render();
      setInfo(`Analyse terminée : sifflement suivi sur ${fmt(tB - tA, 1)} s.`);
    } catch (error) {
      console.error("Analyse fréquence", error); setInfo("Erreur pendant l’analyse : " + (error?.message || error), true);
    } finally { state.busy = false; $id("toneRun").disabled = !records.length; }
  }

  /* ---------- diagnostic ---------- */
  function diagnosis() {
    const R = state.result, lines = [];
    if (!R) return lines;
    if (R.error) { lines.push(esc(R.error)); return lines; }
    const { runFrames, coef, tc, sd, tA, tB, os, ord, record } = R;
    const fAt = R.track.fAt;
    const f0 = fAt(runFrames[0].t), f1 = fAt(runFrames.at(-1).t), slope = (f1 - f0) / Math.max(0.1, runFrames.at(-1).t - runFrames[0].t);
    const trend = Math.abs(slope) < 0.05 ? "stable (vitesse constante)" : slope > 0 ? "en hausse (accélération)" : "en baisse (décélération)";
    const tnr = median(runFrames.map((f) => f.tnr)), bandMax = runFrames.reduce((a, b) => (b.bandDb > a.bandDb ? b : a));
    lines.push(`Sifflement suivi de <b>${fmt(f0)} à ${fmt(f1)} Hz</b> sur ${fmt(tB - tA, 1)} s (${fmt(tA, 1)}–${fmt(tB, 1)} s) : ${trend}, ${fmt(slope, 2)} Hz/s. Écart des mesures au suivi lissé : ${fmt(sd, 1)} Hz.`);
    lines.push(`Émergence du sifflement : ${fmt(median(runFrames.map((f) => f.prom)), 0)} dB au-dessus du bruit voisin (trames de 1 s), ${fmt(ord.toneEmergence, 0)} dB dans le spectre en ordres ; rapport tonal ISO 1996-2 simplifié ${fmt(tnr, 1)} dB` + (tnr >= 8 ? " (tonalité nettement émergente)." : tnr < 3 ? " (fréquence fine dans un bruit large bande fort : l’oreille la perçoit surtout si le bruit de fond baisse)." : ".") + ` Niveau maximal de la bande 1 500–1 700 Hz à ${fmt(bandMax.t, 1)} s.`);

    // identification par la vitesse
    const cfg = getTransmissionConfig();
    const tMid = (tA + tB) / 2, sp = speedAt(tMid, record).v, fMid = fAt(tMid);
    if (Number.isFinite(sp) && sp > 20) {
      const ratio = fMid / sp, cands = [];
      CHAINS.forEach((ch) => cfg.axles.forEach((ax) => { const s = chainSlope(ch.key, ax.diameter); cands.push({ ch, ax, s, err: (ratio - s) / s }); }));
      cands.sort((a, b) => Math.abs(a.err) - Math.abs(b.err));
      const b = cands[0];
      lines.push(`Vitesse retenue au milieu de la zone : <b>${fmt(sp)} km/h</b> (${esc(speedSourceLabel())}) → ${fmt(ratio, 3)} Hz par km/h, soit l’ordre ${fmt(fMid / (sp * chainSlope("axle", cfg.diameter1)), 1)} de la rotation d’essieu.`);
      if (Math.abs(b.err) <= 0.06) lines.push(`→ Compatible avec l’<b>${b.ch.label}</b> (${b.ax.id} Ø${fmt(b.ax.diameter)} mm, écart ${b.err >= 0 ? "+" : ""}${fmt(100 * b.err, 1)} %). Diamètre de roue équivalent : <b>${fmt(b.ax.diameter * (b.s / ratio))} mm</b>. Une erreur de vitesse de 1 % décale ce diamètre d’environ 9 mm.`);
      else lines.push(`→ Ne correspond à aucun engrènement configuré (écart minimal ${fmt(100 * b.err, 1)} %). Vérifier la vitesse saisie ou chercher une autre source (électrique, auxiliaire).`);
    } else {
      const hyp = [];
      CHAINS.forEach((ch) => [cfg.diameter1, cfg.diameter2].forEach((d) => { const v = fMid / chainSlope(ch.key, d); hyp.push(`${ch.label} Ø${fmt(d)} : ${fmt(v)} km/h${v > 330 ? " (impossible)" : ""}`); }));
      lines.push(`Vitesse non renseignée. Vitesse qu’il faudrait pour ${fmt(fMid)} Hz — ${hyp.join(" ; ")}. Renseignez la vitesse (ou associez le CSV) pour trancher.`);
    }

    // bandes latérales
    const sbs = [...ord.sb].sort((a, b) => b.emergence - a.emergence);
    lines.push("Bandes latérales (−/+ par rapport au sifflement ; émergence au-dessus du plancher) : " + ord.sb.map((b) => `±${fmt(b.spacingHz, 1)} Hz (1/${b.teeth}) ${fmt(b.lowRel)} / ${fmt(b.highRel)} dB, émergence ${fmt(b.emergence)} dB`).join(" ; ") + ".");
    const top = sbs[0], second = sbs[1];
    if (top.emergence >= 10 && top.emergence - second.emergence >= 4) {
      lines.push(`→ <b>Modulation dominante à ±${fmt(top.spacingHz, 1)} Hz : ${top.label}</b>.` + (Number.isFinite(top.h2Emergence) && top.h2Emergence >= 8 ? " Les mêmes bandes latérales existent autour de l’harmonique 2 : c’est bien une modulation de la fréquence, pas une fréquence d’un autre essieu." : ""));
    } else if (top.emergence >= 10) lines.push("→ Plusieurs familles de bandes latérales d’émergence voisine : modulation non attribuable à un seul arbre.");
    else lines.push("→ Pas de bande latérale marquée: sifflement d’engrènement peu modulé.");
    if (Number.isFinite(ord.h2Emergence)) lines.push(`Harmonique 2 (${fmt(2 * os.fMid)} Hz) : ${fmt(ord.h2Rel)} dB par rapport au sifflement, émergence ${fmt(ord.h2Emergence)} dB.`);
    if (ord.others.length) lines.push("Autres modulations symétriques non identifiées : " + ord.others.map((o) => `±${fmt(o.hz, 1)} Hz (${fmt(o.lowRel)} / ${fmt(o.highRel)} dB)`).join(" ; ") + ". Origine à rechercher (suspension, structure, autre arbre).");

    // relation fréquence / vitesse si la vitesse varie (CSV ou rampe)
    const pts = runFrames.map((f) => ({ f: f.peakHz, v: speedAt(f.t, record).v })).filter((p) => Number.isFinite(p.v) && p.v >= 30);
    if (pts.length >= 10) {
      const vs = pts.map((p) => p.v), spanV = Math.max(...vs) - Math.min(...vs);
      if (spanV >= 10) {
        const mv = vs.reduce((a, b) => a + b, 0) / vs.length, mf = pts.reduce((a, p) => a + p.f, 0) / pts.length;
        let sxy = 0, sxx = 0, syy = 0; pts.forEach((p) => { sxy += (p.v - mv) * (p.f - mf); sxx += (p.v - mv) ** 2; syy += (p.f - mf) ** 2; });
        const a = sxy / sxx, rr = sxy / Math.sqrt(sxx * syy || 1);
        lines.push(`Fréquence / vitesse sur ${pts.length} points (${fmt(Math.min(...vs))}–${fmt(Math.max(...vs))} km/h) : pente ${fmt(a, 2)} Hz par km/h (r = ${fmt(rr, 2)}) — théorie réducteur ${fmt(chainSlope("meshReducer", cfg.diameter1), 2)}, pont ${fmt(chainSlope("meshBridge", cfg.diameter1), 2)} (Ø${fmt(cfg.diameter1)}).` + (Math.abs(a) < 0.8 ? " → Fréquence quasi fixe : piste électrique ou structure." : ""));
      }
    }
    lines.push("<i>Spectre en ordres : le signal est rééchantillonné en suivant le sifflement, ce qui annule l’effet de la variation de vitesse et donne une résolution d’environ " + fmt(os.fMid * os.orderStep, 2) + " Hz. Niveaux relatifs non calibrés.</i>");
    return lines;
  }

  /* ---------- dessin ---------- */
  function prep(canvas, height) {
    const ratio = window.devicePixelRatio || 1, w = Math.max(320, canvas.clientWidth || 800);
    canvas.width = Math.floor(w * ratio); canvas.height = Math.floor(height * ratio); canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d"); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, w, height); ctx.font = "12px Segoe UI, system-ui, sans-serif";
    return { ctx, w, h: height };
  }
  function blank(canvas, h, text) { const { ctx, w } = prep(canvas, h); ctx.fillStyle = "#4D4F53"; ctx.textAlign = "center"; ctx.fillText(text, w / 2, h / 2); ctx.textAlign = "left"; }

  /* Suivi du sifflement, version lisible (v1.2) :
   *  - le niveau de bande est LISSÉ (moyenne glissante ~20 s) ; le brut reste en filigrane ;
   *  - les points de fréquence aberrants (loin de la médiane locale) sont écartés ; une courbe médiane montre la tendance ;
   *  - une bande de vitesse + régime (traction / érre / freinage) est tracée sous le graphique, sur le même axe de temps. */
  function drawTrack() {
    const canvas = $id("toneTrackCanvas"), H = 400, R = state.result;
    if (!R || !R.tr) { blank(canvas, H, "Suivi du sifflement : lancez l’analyse."); return; }
    const { ctx, w, h } = prep(canvas, H);
    const L = 58, Rr = 58, T = 40, pw = w - L - Rr, ph = 230, sy0 = T + ph + 34, sh = 56;
    const fr = R.tr.frames, tMax = fr.at(-1)?.t || 1, X = (t) => L + (t / tMax) * pw;
    const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : NaN; };
    const dt = fr.length > 1 ? (fr.at(-1).t - fr[0].t) / (fr.length - 1) : 1;
    const win = (sec) => Math.max(1, Math.round(sec / Math.max(0.05, dt)));
    // niveau lissé
    const bd = fr.map((f) => f.bandDb), wl = win(20), lvl = bd.map((_, i) => { let a = 0, n = 0; for (let k = Math.max(0, i - wl); k <= Math.min(bd.length - 1, i + wl); k++) { if (Number.isFinite(bd[k])) { a += Math.pow(10, bd[k] / 10); n++; } } return n ? 10 * Math.log10(a / n) : NaN; });
    const fin = lvl.filter(Number.isFinite), bMax = Math.ceil(Math.max(...fin) / 5) * 5, bMin = Math.floor(Math.min(...fin) / 5) * 5 - 2;
    const Yb = (b) => T + ph - ((Math.max(bMin, Math.min(bMax, b)) - bMin) / (bMax - bMin)) * ph;
    // points de fréquence nets, puis écart aux voisins (médiane locale ± 3 × écart médian)
    // en dessous de 60 km/h le sifflement d'engrènement n'est pas exploitable : on ne trace que les points au-dessus (si la vitesse est connue)
    const spRows = (window.CampbellTGV?._state?.rows || []).filter((r) => Number.isFinite(r.t) && Number.isFinite(r.speed));
    const spAt = (t) => { if (spRows.length < 4) return null; let lo = 0, hi = spRows.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (spRows[m].t < t) lo = m + 1; else hi = m; } return spRows[lo].speed; };
    const tonal = fr.filter((f) => { if (!(Number.isFinite(f.peakHz) && f.prom >= 10)) return false; const v = spAt(f.t); return v === null || v >= 60; }), wf = win(30);
    const good = [], trend = [];
    tonal.forEach((f, i) => {
      const nb = []; for (let k = Math.max(0, i - 12); k <= Math.min(tonal.length - 1, i + 12); k++) if (Math.abs(tonal[k].t - f.t) <= wf * dt) nb.push(tonal[k].peakHz);
      if (nb.length < 4) return;
      const m = med(nb), mad = med(nb.map((v) => Math.abs(v - m))) || 1;
      if (Math.abs(f.peakHz - m) <= Math.max(6, 3 * 1.4826 * mad)) good.push(f);
      trend.push({ t: f.t, f: m });
    });
    const fs = (good.length ? good : tonal).map((f) => f.peakHz).sort((a, b) => a - b);
    let fMin = fs.length ? fs[Math.floor(0.02 * (fs.length - 1))] : R.fLo, fMax = fs.length ? fs[Math.ceil(0.98 * (fs.length - 1))] : R.fLo + 50;
    if (R.runFrames && R.runFrames.length) { const rf = R.runFrames.map((f) => f.peakHz); fMin = Math.min(fMin, ...rf); fMax = Math.max(fMax, ...rf); }
    const pad = Math.max(4, (fMax - fMin) * 0.12); fMin -= pad; fMax += pad;
    const Y = (f) => T + ph - ((f - fMin) / (fMax - fMin)) * ph;
    // fond et grille
    ctx.strokeStyle = "#E1E1E1"; ctx.fillStyle = "#0088CE";
    for (let i = 0; i <= 4; i++) { const y = T + (ph * i) / 4; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke(); ctx.fillStyle = "#0088CE"; ctx.textAlign = "right"; ctx.fillText(fmt(fMax - ((fMax - fMin) * i) / 4), L - 6, y + 4); ctx.fillStyle = "#E05206"; ctx.textAlign = "left"; ctx.fillText(fmt(bMax - ((bMax - bMin) * i) / 4), L + pw + 6, y + 4); }
    ctx.textAlign = "left";
    if (R.tA !== undefined) { ctx.fillStyle = "rgba(110,30,120,.10)"; ctx.fillRect(X(R.tA), T, Math.max(2, X(R.tB) - X(R.tA)), ph + 34 + sh); ctx.fillStyle = "#6E1E78"; ctx.fillText("passage analysé", Math.min(L + pw - 90, X(R.tA)), T - 6); }
    // niveau : brut en filigrane, lissé en trait épais
    ctx.strokeStyle = "rgba(224,82,6,.22)"; ctx.lineWidth = 1; ctx.beginPath(); fr.forEach((f, i) => (i ? ctx.lineTo(X(f.t), Yb(f.bandDb)) : ctx.moveTo(X(f.t), Yb(f.bandDb)))); ctx.stroke();
    ctx.strokeStyle = "#E05206"; ctx.lineWidth = 2.6; ctx.beginPath(); fr.forEach((f, i) => { if (!Number.isFinite(lvl[i])) return; i ? ctx.lineTo(X(f.t), Yb(lvl[i])) : ctx.moveTo(X(f.t), Yb(lvl[i])); }); ctx.stroke();
    // fréquence : points nets (transparents) + tendance
    ctx.fillStyle = "rgba(0,136,206,.40)"; good.forEach((f) => { if (f.peakHz >= fMin && f.peakHz <= fMax) { ctx.beginPath(); ctx.arc(X(f.t), Y(f.peakHz), 2, 0, Math.PI * 2); ctx.fill(); } });
    if (trend.length > 1) { ctx.strokeStyle = "#0066A1"; ctx.lineWidth = 2; ctx.beginPath(); let st = false, last = -1e9; trend.forEach((q) => { const x = X(q.t); if (q.t - last > 60) st = false; st ? ctx.lineTo(x, Y(q.f)) : (ctx.moveTo(x, Y(q.f)), st = true); last = q.t; }); ctx.stroke(); }
    if (R.track) { ctx.strokeStyle = "#6E1E78"; ctx.lineWidth = 2.4; ctx.beginPath(); for (let i = 0; i <= 200; i++) { const t = R.tA + ((R.tB - R.tA) * i) / 200, f = R.track.fAt(t); i ? ctx.lineTo(X(t), Y(f)) : ctx.moveTo(X(t), Y(f)); } ctx.stroke(); }
    ctx.lineWidth = 1; ctx.strokeStyle = "#3C3732"; ctx.strokeRect(L, T, pw, ph);
    // bande vitesse + régime
    const rows = (window.CampbellTGV?._state?.rows || []).filter((r) => Number.isFinite(r.t) && Number.isFinite(r.speed));
    ctx.fillStyle = "#4D4F53"; ctx.font = "11px Segoe UI, system-ui, sans-serif";
    if (rows.length > 3) {
      const vMax = Math.max(60, Math.ceil(Math.max(...rows.map((r) => r.speed)) / 50) * 50), Yv = (v) => sy0 + sh - (v / vMax) * sh;
      const col = { Traction: "#D52B1E", Erre: "#0088CE", Freinage: "#82BE00" };
      ctx.strokeStyle = "#E1E1E1"; ctx.strokeRect(L, sy0, pw, sh);
      rows.forEach((r, i) => { const nx = rows[i + 1] ? rows[i + 1].t : r.t + 1, x0 = X(r.t), x1 = Math.max(x0 + 1, X(nx)); ctx.fillStyle = col[r.regime] || "#A0A0A0"; ctx.globalAlpha = 0.28; ctx.fillRect(x0, Yv(r.speed), x1 - x0, sy0 + sh - Yv(r.speed)); ctx.globalAlpha = 1; });
      ctx.strokeStyle = "#3C3732"; ctx.lineWidth = 1.2; ctx.beginPath(); rows.forEach((r, i) => (i ? ctx.lineTo(X(r.t), Yv(r.speed)) : ctx.moveTo(X(r.t), Yv(r.speed)))); ctx.stroke();
      ctx.fillStyle = "#4D4F53"; ctx.textAlign = "right"; ctx.fillText(vMax + " km/h", L - 6, sy0 + 8); ctx.fillText("0", L - 6, sy0 + sh); ctx.textAlign = "left";
      let lx = L; [["Traction", "#D52B1E"], ["Érre", "#0088CE"], ["Freinage", "#82BE00"]].forEach(([t, c]) => { ctx.fillStyle = c; ctx.globalAlpha = 0.5; ctx.fillRect(lx, sy0 + sh + 8, 12, 8); ctx.globalAlpha = 1; ctx.fillStyle = "#4D4F53"; ctx.fillText(t, lx + 16, sy0 + sh + 16); lx += 84; });
      ctx.fillText("vitesse (ligne noire) et régime (couleur)", lx + 10, sy0 + sh + 16);
    } else { ctx.fillStyle = "#747678"; ctx.fillText("Pas de vitesse pour ce fichier : bande vitesse / régime indisponible.", L, sy0 + 20); }
    ctx.font = "12px Segoe UI, system-ui, sans-serif"; ctx.fillStyle = "#4D4F53";
    for (let i = 0; i <= 5; i++) ctx.fillText(fmt((tMax * i) / 5, 0) + " s", X((tMax * i) / 5) - 10, T + ph + 16);
    ctx.font = "13px Segoe UI, system-ui, sans-serif";
    ctx.fillStyle = "#0088CE"; ctx.fillText("● fréquence du sifflement (Hz, gauche), trait bleu foncé = tendance — mesurée au-dessus de 60 km/h", L, 14);
    ctx.fillStyle = "#E05206"; ctx.fillText("▬ niveau lissé 1 500–1 700 Hz (dB, droite)", L, 30);
    ctx.fillStyle = "#6E1E78"; ctx.fillText("▬ courbe retenue pour l’analyse fine", L + 300, 30);
  }

  function drawOrders() {
    const canvas = $id("toneOrderCanvas"), H = 320, R = state.result;
    if (!R?.os) { blank(canvas, H, "Spectre en ordres : disponible après l’analyse d’un sifflement."); return; }
    const { ctx, w, h } = prep(canvas, H);
    const L = 58, Rr = 18, T = 26, B = 36, pw = w - L - Rr, ph = h - T - B;
    const { os, ord } = R, f = os.fMid, span = Math.max(80, (f / 27) * 1.6);
    const oA = 1 - span / f, oB = 1 + span / f, iA = Math.floor(oA / os.orderStep), iB = Math.ceil(oB / os.orderStep);
    const top = 3, bottom = -55;
    const X = (hz) => L + ((hz - (f - span)) / (2 * span)) * pw, Y = (d) => T + ph - ((Math.max(bottom, Math.min(top, d)) - bottom) / (top - bottom)) * ph;
    ctx.strokeStyle = "#E1E1E1";
    for (let d = 0; d >= bottom; d -= 10) { ctx.beginPath(); ctx.moveTo(L, Y(d)); ctx.lineTo(L + pw, Y(d)); ctx.stroke(); ctx.fillStyle = "#4D4F53"; ctx.fillText(String(d), 18, Y(d) + 4); }
    const marks = [{ hz: f, label: "Sifflement", color: "#D52B1E" }];
    SIDEBANDS.forEach((b, i) => [-1, 1].forEach((s) => marks.push({ hz: f + (s * f) / b.teeth, label: `${s < 0 ? "−" : "+"}${fmt(f / b.teeth)} Hz`, sub: `1/${b.teeth}`, color: ["#009AA6", "#0088CE", "#E05206"][i] })));
    ctx.setLineDash([4, 4]);
    marks.forEach((m, i) => { ctx.strokeStyle = m.color; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(X(m.hz), T); ctx.lineTo(X(m.hz), T + ph); ctx.stroke(); ctx.globalAlpha = 1; });
    ctx.setLineDash([]);
    // courbe (max par pixel)
    ctx.strokeStyle = "#3C3732"; ctx.lineWidth = 1; ctx.beginPath();
    const px = Math.max(1, Math.floor((iB - iA) / pw));
    let first = true;
    for (let i = iA; i <= iB; i += px) {
      let m = -Infinity; for (let k = i; k < i + px && k < os.db.length; k++) m = Math.max(m, os.db[k]);
      const x = X(i * os.orderStep * f), y = Y(m - ord.toneDb);
      first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false;
    }
    ctx.stroke();
    ctx.font = "11px Segoe UI, system-ui, sans-serif";
    marks.forEach((m, i) => { ctx.fillStyle = m.color; ctx.textAlign = "center"; const row = i === 0 ? 0 : 1 + ((i - 1) >> 1); ctx.fillText(m.label + (m.sub ? " " + m.sub : ""), X(m.hz), T + 12 + row * 12); });
    ctx.textAlign = "left"; ctx.strokeStyle = "#3C3732"; ctx.strokeRect(L, T, pw, ph);
    ctx.font = "12px Segoe UI, system-ui, sans-serif"; ctx.fillStyle = "#4D4F53";
    for (let k = -2; k <= 2; k++) { const hz = f + (k * span) / 2; ctx.fillText(fmt(hz), X(hz) - 14, T + ph + 16); }
    ctx.fillStyle = "#3C3732"; ctx.font = "13px Segoe UI, system-ui, sans-serif";
    ctx.fillText(`Spectre en ordres autour du sifflement (vitesse compensée, ramené à ${fmt(f)} Hz) — dB par rapport au sifflement`, L, T - 9);
  }

  function render() {
    const R = state.result;
    $id("toneDiagnosis").innerHTML = R ? "<ul>" + diagnosis().map((l) => `<li>${l}</li>`).join("") + "</ul>" : "Lancez l’analyse du sifflement sur un fichier chargé.";
    drawTrack(); drawOrders();
    const can = R && R.tr && !R.error;
    $id("toneReport").disabled = !can;
    $id("toneCampbell").disabled = !R?.tr;
  }

  /* ---------- rapport HTML simple ---------- */
  function exportReport() {
    const R = state.result; if (!R || R.error) return;
    const rame = $id("rame")?.value || "", motrice = $id("motrice")?.value || "", train = $id("train")?.value || "", date = $id("date")?.value || "";
    const strip = (s) => s.replace(/<i>|<\/i>/g, "");
    const lines = diagnosis().map(strip);
    const sbRows = R.ord.sb.map((b) => `<tr><td>±${fmt(b.spacingHz, 1)} Hz (1/${b.teeth}) — ${esc(b.short)}</td><td>${fmt(b.lowRel)} / ${fmt(b.highRel)} dB</td><td>${fmt(b.emergence)} dB</td></tr>`).join("\n");
    const html = `<html><head><meta charset="utf-8"><title>Analyse du sifflement - ${esc(R.record.name)}</title></head><body>
<h2>Analyse du sifflement gênant — ${esc(R.record.name)}</h2>
<p><b>Rame :</b> ${esc(rame)} &nbsp; <b>Motrice :</b> ${esc(motrice)} &nbsp; <b>Train :</b> ${esc(train)} &nbsp; <b>Date :</b> ${esc(date)} &nbsp; <b>Régime :</b> ${esc(R.record.regime || "")}</p>
<h3>Diagnostic</h3>
<ul>
${lines.map((l) => "<li>" + l + "</li>").join("\n")}
</ul>
<h3>Bandes latérales</h3>
<table border="1" cellpadding="4">
<tr><th>Espacement</th><th>Niveau − / + (par rapport au sifflement)</th><th>Émergence</th></tr>
${sbRows}
</table>
<p><i>Analyse Acoustique TGV v0.9.6 — niveaux relatifs non calibrés, aide au diagnostic à confirmer par les contrôles de maintenance.</i></p>
</body></html>`;
    downloadText(`Analyse_sifflement_${safeFilenamePart(rame || R.record.name, "fichier")}_${fileStamp()}.html`, html, "text/html;charset=utf-8");
  }

  /* ---------- envoi vers le diagramme de Campbell ---------- */
  function sendToCampbell() {
    const R = state.result; if (!R?.tr || !window.CampbellTGV) return;
    const cfg = getTransmissionConfig();
    const rows = R.tr.frames.filter((_, i) => i % 2 === 0).map((f) => {
      const s = speedAt(f.t, R.record);
      const orders = {};
      CHAINS.forEach((ch) => cfg.axles.forEach((ax) => {
        let v = null;
        if (Number.isFinite(s.v) && s.v > 20) {
          const fx = transmissionFrequencies(s.v, ax.diameter)[ch.key], g0 = Math.round((fx * 0.988) / GRID_STEP), g1 = Math.round((fx * 1.012) / GRID_STEP);
          v = -160; for (let g = Math.max(0, g0); g <= Math.min(GRID_N - 1, g1); g++) v = Math.max(v, f.spec[g]);
        }
        orders[ch.key + ax.id] = v;
      }));
      const reg = ["Traction", "Erre", "Freinage", "Statique"].includes(s.regime) ? s.regime : ["Traction", "Erre", "Freinage", "Statique"].includes(R.record.regime) ? R.record.regime : "Non renseigné";
      return { t: Number(f.t.toFixed(2)), speed: Number.isFinite(s.v) ? Number(s.v.toFixed(2)) : null, regime: reg, bandDb: f.bandDb, bandPeakHz: f.peakHz, bandPeakDb: f.peakDb, tnrDb: f.tnr, promDb: f.prom,
        meshReducerE1Db: orders.meshReducerE1, meshReducerE2Db: orders.meshReducerE2, meshBridgeE1Db: orders.meshBridgeE1, meshBridgeE2Db: orders.meshBridgeE2, spec: Array.from(f.spec, (v) => Math.round(v)) };
    });
    const withSpeed = rows.filter((r) => Number.isFinite(r.speed)), vs = withSpeed.map((r) => r.speed);
    if (!withSpeed.length) { setInfo("Pas de vitesse : renseignez une rampe (début / fin) ou associez le CSV d’acquisition avant l’envoi vers Campbell.", true); return; }
    if (Math.max(...vs) - Math.min(...vs) < 5) setInfo("Attention : vitesse quasi constante, le diagramme de Campbell sera une colonne étroite. Une rampe ou un CSV donne un résultat exploitable.");
    window.CampbellTGV.importData({ campbell: { format: "campbell_tgv", version: 1, gridStepHz: GRID_STEP, gridMaxHz: GRID_MAX, rows }, identity: { rame: $id("rame")?.value, motrice: $id("motrice")?.value } }, R.record.name);
    setAppMode("diagnostic");
    setTimeout(() => { window.CampbellTGV.render(); $id("campbellSection")?.scrollIntoView({ behavior: "smooth", block: "start" }); }, 80);
  }

  /* ---------- initialisation ---------- */
  function init() {
    if (!$id("toneSection")) return;
    $id("toneRun").addEventListener("click", run);
    $id("toneReport").addEventListener("click", exportReport);
    $id("toneCampbell").addEventListener("click", sendToCampbell);
    $id("toneCsvButton").addEventListener("click", () => $id("toneCsvFile").click());
    $id("toneCsvFile").addEventListener("change", async (e) => {
      const file = e.target.files[0]; e.target.value = ""; if (!file) return;
      try { await loadSpeedFile(file); if (state.result?.tr) render(); }
      catch (error) { console.error(error); $id("toneCsvState").textContent = "Lecture impossible : " + (error?.message || error); }
    });
    $id("toneCsvClear").addEventListener("click", () => { state.speedTrack = null; $id("toneCsvState").textContent = "Aucun CSV associé."; $id("toneCsvClear").disabled = true; if (state.result) render(); });
    ["toneSpeedStart", "toneSpeedEnd", "toneCsvOffset", "transWheelDiameter1", "transWheelDiameter2"].forEach((id) => $id(id)?.addEventListener("change", () => { if (state.result) render(); }));
    $id("toneRecord").addEventListener("change", () => { state.result = null; render(); });
    // changement du classement ou du nombre de pics : recalcul immédiat des tableaux
    ["peakRanking", "peakCount"].forEach((id) => $id(id)?.addEventListener("change", () => {
      if (!records.some((r) => r.spectrum)) return;
      records.forEach((r) => r.spectrum && findPeaks(r));
      refreshAnalysisOutputs();
    }));
    new MutationObserver(refreshSelector).observe($id("fileList"), { childList: true, subtree: true });
    // lancement automatique après « Analyser tous les fichiers »
    new MutationObserver(() => { if ($id("metricState").textContent === "Analyse terminée" && records.length && !state.busy) run(); }).observe($id("metricState"), { childList: true, characterData: true, subtree: true });
    window.addEventListener("resize", () => { drawTrack(); drawOrders(); });
    $id("modeDiagnostic")?.addEventListener("click", () => setTimeout(() => { drawTrack(); drawOrders(); }, 50));
    refreshSelector(); render();
  }
  window.AnalyseRaieTGV = {
    run, state, refresh: () => refreshSelector(),
    associateSpeedFile: async (file) => { await loadSpeedFile(file); if (state.result?.tr) render(); },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
