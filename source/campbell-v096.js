/* Analyse Acoustique TGV — v0.9.6
 * Diagramme de Campbell (fréquence × vitesse), courbes niveau / vitesse,
 * spectre différentiel traction − erre, diagnostic automatique de pente,
 * rapport tonal, régime horodaté, maintien de l'écran allumé.
 * Dépend des variables globales du moteur (acqRunning, acqAnalyser, …).
 */
"use strict";
/* MÉTHODE — DIAGRAMME DE CAMPBELL
 * Un diagramme de Campbell place chaque spectre mesuré dans la colonne de la vitesse du
 * moment : axe horizontal = vitesse (km/h), axe vertical = fréquence (Hz), couleur =
 * niveau. Sur un trajet complet on obtient une carte de tous les sons :
 *   - une DROITE PARTANT DE ZÉRO = son d'un organe tournant (sa fréquence est
 *     proportionnelle à la vitesse) ; sa PENTE (Hz par km/h) désigne l'organe ;
 *   - une LIGNE HORIZONTALE = son à fréquence fixe (résonance de structure, électronique
 *     de puissance) qui ne dépend pas de la vitesse.
 * Déroulement :
 *   1. toutes les 0,5 s pendant l'acquisition, captureRow() prélève le spectre du micro,
 *      le range sur une grille de 5 Hz (0–2 500 Hz) et calcule les indicateurs ;
 *   2. chaque ligne garde la vitesse GPS et le RÉGIME saisi (Traction / Erre / Freinage) ;
 *   3. drawCampbell() moyenne en énergie toutes les lignes d'une même tranche de vitesse ;
 *   4. diagnose() compare traction et erre à vitesse égale, mesure la pente du pic tonal,
 *      cherche les bandes latérales et la vitesse d'apparition du bruit. */

(() => {
  const GRID_STEP = 5;          // Hz entre deux points stockés
  const GRID_MAX = 2500;        // Hz
  const GRID_N = GRID_MAX / GRID_STEP + 1;
  const CAPTURE_MS = 500;       // une ligne Campbell toutes les 0,5 s
  const BAND = [1500, 1700];    // bande de gêne conducteurs
  const SEARCH = [1300, 1900];  // zone de recherche du pic tonal
  const REGIMES = ["Traction", "Erre", "Freinage", "Statique"];
  const REGIME_COLORS = { Traction: "#D52B1E", Erre: "#0088CE", Freinage: "#82BE00", Statique: "#747678" };
  const SIDEBANDS = [
    { teeth: 27, key: "sb27Db", label: "rotation moteur (pignon 27 dents)" },
    { teeth: 41, key: "sb41Db", label: "rotation de la roue intermédiaire (41 dents)" },
    { teeth: 51, key: "sb51Db", label: "rotation de la roue de sortie du réducteur (51 dents)" },
  ];
  const CHAINS = [
    { key: "meshReducer", label: "Engrènement réducteur" },
    { key: "meshBridge", label: "Engrènement pont" },
  ];

  const $id = (id) => document.getElementById(id);
  const state = { rows: [], source: "live", wasRunning: false, lastRender: 0, buf: null, wakeLock: null, diag: null, importedName: "" };

  /* ---------- utilitaires ---------- */
  const dbToPow = (db) => Math.pow(10, db / 10);
  const powToDb = (p) => (p > 0 ? 10 * Math.log10(p) : -160);
  const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "—");
  const esc = (t) => (typeof escapeHtml === "function" ? escapeHtml(String(t)) : String(t).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";"));
  const median = (arr) => {
    const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : null;
  };
  /* Largeur de bande critique de l'oreille (formule de Zwicker).
   * L'oreille regroupe les fréquences proches dans des « bandes critiques » : un bruit n'en
   * masque un autre que s'il est dans la même bande. Vers 1 600 Hz la bande fait ≈ 260 Hz.
   * Sert au rapport tonal : on compare le son pur au bruit contenu dans sa bande critique. */
  function criticalBandHz(f) { return 25 + 75 * Math.pow(1 + 1.4 * Math.pow(f / 1000, 2), 0.69); }
  function cfg() { return getTransmissionConfig(); }
  /* Pente théorique d'un organe en Hz par km/h : fréquence à 100 km/h divisée par 100.
   * Exemple : engrènement réducteur, roue de 900 mm → 5,81 Hz par km/h. */
  function chainSlope(key, diameter) {
    const f = transmissionFrequencies(100, diameter);
    return f ? f[key] / 100 : null; // Hz par km/h
  }
  // fréquence tonale : émergence ≥ 10 dB au-dessus du bruit voisin (ou, pour les anciens fichiers, rapport tonal ≥ 6 dB)
  const isTonal = (r) => Number.isFinite(r.bandPeakHz) && (Number.isFinite(r.promDb) ? r.promDb >= 10 : Number.isFinite(r.tnrDb) && r.tnrDb >= 6);
  function currentRegime() { return $id("acqRegime")?.value || "Non renseigné"; }

  /* ---------- capture temps réel ---------- */
  /* Capture d'une ligne du diagramme (toutes les 0,5 s).
   * Le spectre vient de l'AnalyserNode du navigateur (FFT en continu sur le micro).
   * Indicateurs calculés pour chaque ligne :
   *   bandDb      : énergie totale de la bande 1 500–1 700 Hz (somme des puissances) ;
   *   bandPeakHz  : fréquence du pic le plus fort entre 1 300 et 1 900 Hz (interpolée) ;
   *   promDb      : émergence de ce pic au-dessus du fond local (médiane ±120 Hz) ;
   *                 ≥ 10 dB = son tonal net (sifflement) ;
   *   tnrDb       : rapport tonal simplifié (ISO 1996-2) : énergie du pic / énergie du
   *                 bruit dans sa bande critique ;
   *   meshReducer/meshBridge E1/E2 : niveau mesuré exactement à la fréquence théorique
   *                 d'engrènement (±1,2 %) calculée avec la vitesse GPS de l'instant ;
   *   sb27/41/51  : bandes latérales (voir plus bas). */
  function captureRow() {
    if (!acqAnalyser || !acqAudioContext) return;
    const n = acqAnalyser.frequencyBinCount;
    if (!state.buf || state.buf.length !== n) state.buf = new Float32Array(n);
    const buf = state.buf;
    acqAnalyser.getFloatFrequencyData(buf);
    const sr = acqAudioContext.sampleRate;
    const binHz = (sr / 2 / n) * frequencyCalibrationFactorFor(sr);
    const level = (i) => (Number.isFinite(buf[i]) ? buf[i] : -160);

    // 1. spectre ramené sur une grille fixe de 5 Hz (max des fréquences dans chaque case)
    const spec = new Float32Array(GRID_N);
    for (let g = 0; g < GRID_N; g++) {
      const f = g * GRID_STEP, half = Math.max(GRID_STEP / 2, binHz / 2);
      const lo = Math.max(0, Math.ceil((f - half) / binHz)), hi = Math.min(n - 1, Math.floor((f + half) / binHz));
      let v = -160;
      if (hi >= lo) for (let i = lo; i <= hi; i++) v = Math.max(v, level(i));
      else {
        const x = f / binHz, i0 = Math.min(n - 2, Math.floor(x)), t = x - i0;
        v = level(i0) * (1 - t) + level(i0 + 1) * t;
      }
      spec[g] = v;
    }

    // Les dB ne s'additionnent pas : on repasse en puissance (10^(dB/10)), on additionne,
    // puis on reconvertit en dB. Le résultat représente toute l'énergie de la bande gênante.
    // 2. niveau de bande 1 500–1 700 Hz (somme énergétique)
    let bandPow = 0;
    for (let i = Math.ceil(BAND[0] / binHz); i <= Math.floor(BAND[1] / binHz) && i < n; i++) bandPow += dbToPow(level(i));

    // Recherche élargie à 1 300–1 900 Hz pour suivre le sifflement avant qu'il entre dans la
    // bande gênante et après qu'il en sort (il monte avec la vitesse).
    // 3. pic tonal dans 1 300–1 900 Hz + rapport tonal simplifié (ISO 1996-2)
    let best = -1;
    for (let i = Math.ceil(SEARCH[0] / binHz); i <= Math.floor(SEARCH[1] / binHz) && i < n - 1; i++) {
      if (best < 0 || level(i) > level(best)) best = i;
    }
    let peakHz = null, peakDb = null, tnr = null, prom = null;
    const sb = { sb27Db: null, sb41Db: null, sb51Db: null };
    if (best > 0) {
      const l = level(best - 1), c = level(best), r = level(best + 1), den = l - 2 * c + r;
      const delta = Math.abs(den) > 1e-9 ? Math.max(-1, Math.min(1, (0.5 * (l - r)) / den)) : 0;
      peakHz = (best + delta) * binHz;
      peakDb = c - 0.25 * (l - r) * delta;
      const toneHalf = 3, cb = criticalBandHz(peakHz);
      let toneP = 0, noiseP = 0, noiseBins = 0;
      const lo = Math.max(1, Math.round((peakHz - cb / 2) / binHz)), hi = Math.min(n - 1, Math.round((peakHz + cb / 2) / binHz));
      for (let i = lo; i <= hi; i++) {
        if (Math.abs(i - best) <= toneHalf) toneP += dbToPow(level(i));
        else { noiseP += dbToPow(level(i)); noiseBins++; }
      }
      if (noiseBins > 0 && toneP > 0) {
        const noiseInBand = (noiseP / noiseBins) * (hi - lo + 1);
        tnr = 10 * Math.log10(toneP / noiseInBand);
      }
      // BANDES LATÉRALES : si un arbre tourne avec un léger faux-rond ou un défaut localisé,
      // il module l'engrènement une fois par tour. Le spectre montre alors, de part et
      // d'autre du pic, des pics secondaires écartés de la fréquence de rotation de cet arbre :
      //   écart = f_engrènement / nombre de dents du pignon porté par l'arbre.
      //   1/27 → arbre moteur ; 1/41 → roue intermédiaire ; 1/51 → roue de sortie.
      // Chaque maximum local trouvé à côté du pic est attribué à l'écart théorique le plus
      // proche (tolérance 12 %), puis on calcule son émergence au-dessus du fond.
      // bandes latérales : émergence au-dessus du plancher local (médiane ±120 Hz)
      const fl = [];
      for (let i = Math.max(1, Math.round((peakHz - 120) / binHz)); i <= Math.min(n - 1, Math.round((peakHz + 120) / binHz)); i++) fl.push(level(i));
      fl.sort((x, y) => x - y);
      const floor = fl[Math.floor(fl.length / 2)];
      prom = peakDb - floor;
      // maxima locaux de part et d'autre du pic, attribués à l'espacement théorique le plus proche
      const offsets = SIDEBANDS.map((band) => peakHz / band.teeth);
      const claimed = SIDEBANDS.map(() => []);
      [-1, 1].forEach((side) => {
        const lo = Math.round(Math.min(...offsets) * 0.75 / binHz), hi = Math.round(Math.max(...offsets) * 1.25 / binHz);
        for (let k = lo; k <= hi; k++) {
          const i = best + side * k;
          if (i <= 1 || i >= n - 1 || !(level(i) > level(i - 1) && level(i) >= level(i + 1))) continue;
          const off = k * binHz;
          let j = 0;
          offsets.forEach((o, idx) => { if (Math.abs(off - o) < Math.abs(off - offsets[j])) j = idx; });
          if (Math.abs(off - offsets[j]) <= Math.max(binHz, 0.12 * offsets[j])) claimed[j].push({ side, db: level(i) });
        }
      });
      SIDEBANDS.forEach((band, j) => {
        if (offsets[j] < 2.5 * binHz) return;
        let p = 0;
        [-1, 1].forEach((side) => {
          const list = claimed[j].filter((c) => c.side === side);
          const m = list.length ? Math.max(...list.map((c) => c.db)) : floor;
          p += dbToPow(m) / 2;
        });
        sb[band.key] = powToDb(p) - floor;
      });
    }

    // Suivi « par ordre » : au lieu de chercher le pic le plus fort, on lit le niveau
    // exactement là où l'engrènement DOIT se trouver à cette vitesse, pour chaque essieu
    // (diamètres E1 et E2). La fenêtre ±1,2 % couvre l'incertitude de la vitesse GPS.
    // 4. niveau autour des fréquences d'engrènement prédites (E1 et E2)
    const speed = Number.isFinite(acqCurrentSpeed) ? acqCurrentSpeed : null;
    const orders = {};
    const c0 = cfg();
    for (const chain of CHAINS) {
      for (const axle of c0.axles) {
        let v = null;
        if (speed !== null && speed > 20) {
          const fx = transmissionFrequencies(speed, axle.diameter)?.[chain.key];
          if (Number.isFinite(fx) && fx < sr / 2) {
            const half = Math.max(2 * binHz, 0.012 * fx);
            const lo = Math.max(0, Math.floor((fx - half) / binHz)), hi = Math.min(n - 1, Math.ceil((fx + half) / binHz));
            v = -160;
            for (let i = lo; i <= hi; i++) v = Math.max(v, level(i));
          }
        }
        orders[chain.key + axle.id] = v;
      }
    }

    const round = (v, d = 1) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
    state.rows.push({
      t: round((performance.now() - acqStartTime) / 1000, 2),
      speed: round(speed, 2),
      regime: currentRegime(),
      bandDb: round(powToDb(bandPow)),
      bandPeakHz: round(peakHz, 1),
      bandPeakDb: round(peakDb),
      tnrDb: round(tnr),
      promDb: round(prom),
      meshReducerE1Db: round(orders.meshReducerE1),
      meshReducerE2Db: round(orders.meshReducerE2),
      meshBridgeE1Db: round(orders.meshBridgeE1),
      meshBridgeE2Db: round(orders.meshBridgeE2),
      sb27Db: round(sb.sb27Db),
      sb41Db: round(sb.sb41Db),
      sb51Db: round(sb.sb51Db),
      spec,
    });
  }

  /* indicateurs de la ligne la plus proche, utilisés par le CSV synchronisé */
  function indicatorsAt(elapsed) {
    const empty = { bandDb: null, bandPeakHz: null, bandPeakDb: null, tnrDb: null, meshReducerE1Db: null, meshReducerE2Db: null, meshBridgeE1Db: null, meshBridgeE2Db: null, sb27Db: null, sb41Db: null, sb51Db: null };
    if (state.source !== "live" || !state.rows.length) return empty;
    let best = null;
    for (let i = state.rows.length - 1; i >= 0 && i >= state.rows.length - 8; i--) {
      const r = state.rows[i];
      if (!best || Math.abs(r.t - elapsed) < Math.abs(best.t - elapsed)) best = r;
    }
    if (!best || Math.abs(best.t - elapsed) > 1.5) return empty;
    const { bandDb, bandPeakHz, bandPeakDb, tnrDb, meshReducerE1Db, meshReducerE2Db, meshBridgeE1Db, meshBridgeE2Db, sb27Db, sb41Db, sb51Db } = best;
    return { bandDb, bandPeakHz, bandPeakDb, tnrDb, meshReducerE1Db, meshReducerE2Db, meshBridgeE1Db, meshBridgeE2Db, sb27Db, sb41Db, sb51Db };
  }

  /* ---------- export / import ---------- */
  function exportData() {
    if (!state.rows.length) return null;
    return {
      format: "campbell_tgv",
      version: 1,
      gridStepHz: GRID_STEP,
      gridMaxHz: GRID_MAX,
      band: BAND,
      levelUnit: "dB relatif (dBFS navigateur, non calibré)",
      rows: state.rows.map((r) => ({ ...r, spec: Array.from(r.spec, (v) => Math.round(Math.max(-160, v))) })),
    };
  }
  function importData(obj, name) {
    const data = obj?.campbell ?? obj;
    if (!data || data.format !== "campbell_tgv" || !Array.isArray(data.rows)) throw new Error("Ce fichier ne contient pas de données Campbell (acquisition v0.9.6 ou plus récente requise).");
    if (data.gridStepHz !== GRID_STEP || data.gridMaxHz !== GRID_MAX) throw new Error("Grille fréquentielle non prise en charge.");
    const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    const rows = data.rows.slice(0, 20000).map((r) => {
      const spec = new Float32Array(GRID_N);
      const src = Array.isArray(r.spec) ? r.spec : [];
      for (let g = 0; g < GRID_N; g++) spec[g] = Number.isFinite(Number(src[g])) ? Number(src[g]) : -160;
      return {
        t: num(r.t) ?? 0, speed: num(r.speed), regime: REGIMES.includes(r.regime) ? r.regime : "Non renseigné",
        bandDb: num(r.bandDb), bandPeakHz: num(r.bandPeakHz), bandPeakDb: num(r.bandPeakDb), tnrDb: num(r.tnrDb), promDb: num(r.promDb),
        meshReducerE1Db: num(r.meshReducerE1Db), meshReducerE2Db: num(r.meshReducerE2Db),
        meshBridgeE1Db: num(r.meshBridgeE1Db), meshBridgeE2Db: num(r.meshBridgeE2Db),
        sb27Db: num(r.sb27Db), sb41Db: num(r.sb41Db), sb51Db: num(r.sb51Db), spec,
      };
    });
    state.rows = rows;
    state.source = "import";
    state.importedName = name || "";
    if (obj?.identity) {
      const id = obj.identity;
      setInfo(`Acquisition importée : ${name || ""} — rame ${id.rame || "?"}, motrice ${id.motrice || "?"}, ${rows.length} lignes. Les repères théoriques utilisent les diamètres E1/E2 actuellement réglés.`);
    } else setInfo(`Acquisition importée : ${rows.length} lignes.`);
    renderAll(true);
  }
  function exportIndicatorsCsv() {
    if (!state.rows.length) { setInfo("Aucune donnée Campbell à exporter.", true); return; }
    const head = ["temps_s", "vitesse_kmh", "regime", "niveau_bande_1500_1700_db", "pic_bande_hz", "pic_bande_db", "rapport_tonal_db", "ordre_reducteur_E1_db", "ordre_reducteur_E2_db", "ordre_pont_E1_db", "ordre_pont_E2_db", "bandes_lat_27_db", "bandes_lat_41_db", "bandes_lat_51_db", "rame", "motrice", "train"];
    const ident = [$id("acqRame")?.value || "", $id("acqMotrice")?.value || "", $id("acqTrain")?.value || ""];
    const lines = [head].concat(state.rows.map((r) => [r.t, r.speed ?? "", r.regime, r.bandDb ?? "", r.bandPeakHz ?? "", r.bandPeakDb ?? "", r.tnrDb ?? "", r.meshReducerE1Db ?? "", r.meshReducerE2Db ?? "", r.meshBridgeE1Db ?? "", r.meshBridgeE2Db ?? "", r.sb27Db ?? "", r.sb41Db ?? "", r.sb51Db ?? "", ...ident]));
    downloadText(`${acqSessionBaseName("Indicateurs_Campbell")}.csv`, "﻿" + lines.map((l) => l.map(safeCsvCell).join(";")).join("\r\n"), "text/csv;charset=utf-8");
  }
  function exportPng() {
    const canvas = $id("campbellCanvas");
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${acqSessionBaseName("Campbell")}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, "image/png");
  }

  /* ---------- diagnostic ---------- */
  /* Regroupement par tranches de vitesse (par exemple 5 km/h) avec moyenne ÉNERGÉTIQUE
   * des niveaux (moyenne des puissances, puis conversion en dB). Permet de comparer
   * traction et erre « à vitesse égale », la seule comparaison honnête puisque presque
   * tous les bruits augmentent avec la vitesse. */
  function speedBins(rows, step, key) {
    const bins = new Map();
    rows.forEach((r) => {
      if (!Number.isFinite(r.speed) || !Number.isFinite(r[key])) return;
      const b = Math.round(r.speed / step) * step;
      if (!bins.has(b)) bins.set(b, []);
      bins.get(b).push(r[key]);
    });
    return [...bins.entries()].map(([v, list]) => ({ v, mean: powToDb(list.reduce((s, x) => s + dbToPow(x), 0) / list.length), n: list.length })).sort((a, b) => a.v - b.v);
  }

  /* Diagnostic automatique, en 4 étapes :
   *   a. TRACTION − ERRE à vitesse égale dans la bande 1 500–1 700 Hz :
   *      ≥ 6 dB → le bruit dépend de l'effort transmis (denture chargée en traction,
   *      ou bruit électrique de traction) ; < 3 dB → pas lié à la charge.
   *   b. PENTE fréquence / vitesse du pic tonal (régression linéaire) :
   *      pente ≈ 0 → fréquence fixe, pas un engrènement (piste électrique ou résonance) ;
   *      droite passant par zéro (r > 0,85) → organe tournant ; comparaison avec la pente
   *      théorique de chaque engrènement et de chaque essieu, écart toléré 4 % ;
   *      on en déduit le diamètre de roue équivalent.
   *   b2. BANDES LATÉRALES : la famille la plus émergente (≥ 6 dB, 3 dB devant la suivante)
   *      désigne l'arbre en cause.
   *   c. VITESSE D'APPARITION : première tranche où la bande dépasse de 6 dB la référence
   *      (l'erre à la même vitesse, ou à défaut le niveau des basses vitesses), et vitesse du
   *      MAXIMUM. Si le maximum ne suit pas la vitesse mais reste à une fréquence donnée,
   *      c'est une résonance excitée par l'engrènement qui passe à cette fréquence. */
  function diagnose() {
    const rows = state.rows.filter((r) => Number.isFinite(r.speed));
    const c0 = cfg();
    const out = { lines: [], marks: [], resonance: null, onset: null, diffSpeed: null };
    if (!state.rows.length) { out.lines.push("Aucune donnée. Lancez une acquisition ou importez un JSON d’acquisition v0.9.6."); return out; }
    if (!rows.length) { out.lines.push("<b>Aucune vitesse disponible</b> : le diagramme de Campbell nécessite la vitesse (GPS ou saisie manuelle)."); return out; }
    const counts = {};
    rows.forEach((r) => (counts[r.regime] = (counts[r.regime] || 0) + 1));
    const speeds = rows.map((r) => r.speed);
    out.lines.push(`${rows.length} lignes avec vitesse (${fmt(Math.min(...speeds))}–${fmt(Math.max(...speeds))} km/h) — ` + Object.entries(counts).map(([k, v]) => `${esc(k)} : ${(v * CAPTURE_MS / 1000).toFixed(0)} s`).join(", ") + ".");

    const trac = rows.filter((r) => r.regime === "Traction"), erre = rows.filter((r) => r.regime === "Erre" || r.regime === "Freinage");
    if (!trac.length) out.lines.push("Aucune donnée marquée <b>Traction</b> : utilisez les boutons de régime pendant l’acquisition pour activer la comparaison traction / erre.");

    // a. traction vs erre à vitesse égale
    if (trac.length && erre.length) {
      const bt = speedBins(trac, 5, "bandDb"), be = new Map(speedBins(erre, 5, "bandDb").map((b) => [b.v, b]));
      const pairs = bt.filter((b) => be.has(b.v)).map((b) => ({ v: b.v, d: b.mean - be.get(b.v).mean }));
      if (pairs.length) {
        const mean = pairs.reduce((s, p) => s + p.d, 0) / pairs.length, top = pairs.reduce((a, b) => (b.d > a.d ? b : a));
        out.diffSpeed = top.v;
        out.lines.push(`Bande ${BAND[0]}–${BAND[1]} Hz : traction <b>${mean >= 0 ? "+" : ""}${fmt(mean, 1)} dB</b> par rapport à l’erre/freinage à vitesse égale (${pairs.length} tranche(s) de 5 km/h ; écart maximal ${fmt(top.d, 1)} dB vers ${fmt(top.v)} km/h).` +
          (mean >= 6 ? " → <b>Composante liée à la charge confirmée</b> (flanc traction de denture ou bruit électrique de traction)." : mean >= 3 ? " → Composante liée à la charge probable." : " → Pas de différence nette traction / erre dans cette bande."));
      } else out.lines.push("Traction et erre ne se recouvrent à aucune vitesse (±2,5 km/h) : passez en erre à la vitesse où le bruit est fort pour obtenir la comparaison.");
    }

    // b. pente fréquence / vitesse du pic tonal en traction
    const tonal = (trac.length ? trac : rows).filter((r) => r.speed >= 60 && isTonal(r));
    if (tonal.length >= 10) {
      const v = tonal.map((r) => r.speed), f = tonal.map((r) => r.bandPeakHz);
      const span = Math.max(...v) - Math.min(...v);
      if (span < 15) out.lines.push(`Pic tonal suivi sur ${tonal.length} points, mais variation de vitesse insuffisante (${fmt(span)} km/h, minimum 15) pour calculer la pente.`);
      else {
        const mv = v.reduce((a, b) => a + b, 0) / v.length, mf = f.reduce((a, b) => a + b, 0) / f.length;
        let sxy = 0, sxx = 0, syy = 0;
        v.forEach((x, i) => { sxy += (x - mv) * (f[i] - mf); sxx += (x - mv) ** 2; syy += (f[i] - mf) ** 2; });
        const a = sxy / sxx, b = mf - a * mv, r = sxy / Math.sqrt(sxx * syy || 1);
        const prop = v.reduce((s, x, i) => s + x * f[i], 0) / v.reduce((s, x) => s + x * x, 0);
        const axleSlope = chainSlope("axle", c0.diameter1);
        out.lines.push(`Pic tonal ${SEARCH[0]}–${SEARCH[1]} Hz suivi sur ${tonal.length} points : pente <b>${fmt(a, 2)} Hz par km/h</b> (r = ${fmt(r, 2)}), ordonnée à l’origine ${fmt(b)} Hz.`);
        if (Math.abs(a) < 0.8) {
          out.lines.push(`→ <b>Fréquence quasi fixe</b> (~${fmt(mf)} Hz) alors que la vitesse varie de ${fmt(span)} km/h : ce n’est <b>pas un engrènement</b>. Piste électrique (découpage convertisseur, bruit magnétique moteur) ou résonance de structure excitée par du bruit large bande.`);
        } else if (r > 0.85 && Math.abs(b) < 0.15 * mf) {
          const cands = [];
          CHAINS.forEach((ch) => c0.axles.forEach((ax) => { const s = chainSlope(ch.key, ax.diameter); cands.push({ ch, ax, s, err: (prop - s) / s }); }));
          cands.sort((x, y) => Math.abs(x.err) - Math.abs(y.err));
          const best = cands[0];
          const order = prop / axleSlope;
          out.lines.push(`Fréquence proportionnelle à la vitesse : ordre ≈ <b>${fmt(order, 1)}</b> de la rotation d’essieu (Ø${fmt(c0.diameter1)} mm).`);
          if (Math.abs(best.err) <= 0.04) {
            const dEq = best.ax.diameter * (best.s / prop);
            out.lines.push(`→ Correspond à l’<b>${best.ch.label.toLowerCase()}</b> (pente théorique ${fmt(best.s, 3)} Hz par km/h, écart ${best.err >= 0 ? "+" : ""}${fmt(best.err * 100, 1)} %). Diamètre de roue équivalent : <b>${fmt(dEq)} mm</b> (${best.ax.id} réglé à ${fmt(best.ax.diameter)} mm).` +
              (Math.abs(cands[0].err - cands[1].err) < 0.01 && cands[1].ch.key === best.ch.key ? " Attribution E1/E2 incertaine : écart entre essieux inférieur à la précision de la vitesse." : ""));
          } else out.lines.push(`→ La pente ne correspond à aucun engrènement de la chaîne configurée (écart minimal ${fmt(best.err * 100, 1)} % avec ${best.ch.label.toLowerCase()} ${best.ax.id}). Vérifier les nombres de dents, une harmonique, ou une autre source tournante.`);
        } else out.lines.push("→ Relation fréquence / vitesse peu nette (corrélation faible ou ordonnée à l’origine élevée) : plusieurs sources se succèdent probablement dans la zone. Lisez le diagramme de Campbell.");
      }
    } else out.lines.push(`Pic tonal ${SEARCH[0]}–${SEARCH[1]} Hz : moins de 10 points tonals (émergence ≥ 10 dB, vitesse ≥ 60 km/h) — pente non calculable.`);

    // b2. bandes latérales autour du pic tonal
    const sbRows = (trac.length ? trac : rows).filter(isTonal);
    if (sbRows.length >= 10) {
      const res = SIDEBANDS.map((b) => ({ ...b, med: median(sbRows.map((r) => r[b.key])) })).filter((b) => Number.isFinite(b.med));
      if (res.length) {
        res.sort((a, b) => b.med - a.med);
        const fpk = median(sbRows.map((r) => r.bandPeakHz));
        out.lines.push("Bandes latérales autour du pic (" + fmt(fpk) + " Hz), émergence au-dessus du plancher : " + res.map((b) => `±${fmt(fpk / b.teeth)} Hz (1/${b.teeth}) ${fmt(b.med, 1)} dB`).join(" ; ") + ".");
        const top = res[0], second = res[1];
        if (top.med >= 6 && (!second || top.med - second.med >= 3))
          out.lines.push(`→ Modulation dominante à <b>±${fmt(fpk / top.teeth)} Hz</b>, soit la ${top.label} : piste <b>faux-rond, excentricité, défaut localisé de denture ou roulement de cet arbre</b>.`);
        else if (top.med >= 6) out.lines.push("→ Plusieurs familles de bandes latérales d’émergence voisine : modulation non attribuable à un seul arbre.");
        else out.lines.push("→ Pas de bande latérale marquée (< 6 dB) : sifflement d’engrènement peu modulé.");
      }
    }

    // c. vitesse d'apparition et maximum
    const bt = speedBins(trac.length ? trac : rows, 5, "bandDb");
    if (bt.length >= 4) {
      const beMap = new Map(speedBins(erre, 5, "bandDb").map((b) => [b.v, b.mean]));
      const low = bt.slice(0, Math.max(2, Math.floor(bt.length * 0.25))).map((b) => b.mean);
      const baseline = median(low);
      let onset = null;
      for (let i = 0; i < bt.length - 1; i++) {
        const ref = beMap.has(bt[i].v) ? beMap.get(bt[i].v) : baseline, ref2 = beMap.has(bt[i + 1].v) ? beMap.get(bt[i + 1].v) : baseline;
        if (bt[i].mean >= ref + 6 && bt[i + 1].mean >= ref2 + 6) { onset = bt[i].v; break; }
      }
      const max = bt.reduce((a, b) => (b.mean > a.mean ? b : a));
      const atMax = (trac.length ? trac : rows).filter((r) => Math.abs(r.speed - max.v) <= 2.5);
      const fRes = median(atMax.map((r) => r.bandPeakHz)), tnrMax = median(atMax.map((r) => r.tnrDb));
      out.onset = onset; out.resonance = { v: max.v, f: fRes };
      out.lines.push(`Bande ${BAND[0]}–${BAND[1]} Hz${trac.length ? " en traction" : ""} : ` + (onset !== null ? `apparition (+6 dB) vers <b>${fmt(onset)} km/h</b>, ` : "pas d’apparition nette (+6 dB), ") + `niveau maximal vers <b>${fmt(max.v)} km/h</b>` + (Number.isFinite(fRes) ? `, fréquence du pic à ce point ≈ <b>${fmt(fRes)} Hz</b> (fréquence de résonance probable)` : "") + ".");
      if (Number.isFinite(tnrMax)) out.lines.push(`Rapport tonal au maximum : <b>${fmt(tnrMax, 1)} dB</b>` + (tnrMax >= 8 ? " → tonalité nettement émergente (critère ISO 1996-2 simplifié : ≥ 8 dB au-dessus de 1 kHz), très gênante à l’oreille." : " → tonalité peu émergente."));
      const preds = c0.axles.map((ax) => `${ax.id} Ø${fmt(ax.diameter)} : ${fmt(BAND[0] / chainSlope("meshReducer", ax.diameter))} km/h`).join(" ; ");
      out.lines.push(`Vitesse théorique où l’engrènement réducteur atteint ${BAND[0]} Hz — ${preds}. Si la vitesse d’apparition mesurée suit le diamètre des roues d’une rame à l’autre, le mécanisme « engrènement × résonance » est confirmé.`);
    }
    out.lines.push("<i>Niveaux relatifs non calibrés ; GPS de téléphone indicatif. Aide au diagnostic, à confirmer par les contrôles de maintenance.</i>");
    return out;
  }

  /* ---------- dessin ---------- */
  const CMAP = [[0, [0, 0, 4]], [0.25, [66, 10, 104]], [0.5, [147, 38, 103]], [0.75, [221, 81, 58]], [0.9, [252, 165, 10]], [1, [252, 255, 164]]];
  function cmap(t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < CMAP.length; i++) if (t <= CMAP[i][0]) {
      const [t0, c0] = CMAP[i - 1], [t1, c1] = CMAP[i], u = (t - t0) / (t1 - t0);
      return c0.map((c, k) => Math.round(c + (c1[k] - c) * u));
    }
    return CMAP.at(-1)[1];
  }
  function prepCanvas(canvas, height) {
    const ratio = window.devicePixelRatio || 1, w = Math.max(320, canvas.clientWidth || canvas.parentElement.clientWidth || 800);
    canvas.width = Math.floor(w * ratio); canvas.height = Math.floor(height * ratio);
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, w, height);
    ctx.font = "12px Segoe UI, system-ui, sans-serif";
    return { ctx, w, h: height };
  }
  function message(canvas, h, text) {
    const { ctx, w } = prepCanvas(canvas, h);
    ctx.fillStyle = "#4D4F53"; ctx.textAlign = "center"; ctx.fillText(text, w / 2, h / 2); ctx.textAlign = "left";
  }
  function selectedRows() {
    const filter = $id("campbellRegimeFilter")?.value || "";
    return state.rows.filter((r) => Number.isFinite(r.speed) && (!filter || r.regime === filter));
  }
  function freqRange() {
    const v = $id("campbellRange")?.value || "0-2500";
    const [a, b] = v.split("-").map(Number);
    return [a, b];
  }
  function speedAxis(rows) {
    const all = rows.map((r) => r.speed).sort((a, b) => a - b);
    const moving = all.filter((v) => v > 5);
    const s = moving.length >= all.length * 0.5 ? moving.slice(Math.floor(moving.length * 0.01)) : all;
    let min = Math.max(0, Math.floor(Math.min(...s) / 25) * 25), max = Math.ceil(Math.max(...s) / 25) * 25;
    if (max - min < 25) max = min + 25;
    return [min, max];
  }

  /* Dessin du diagramme : une colonne par km/h. Toutes les lignes tombant dans la même
   * colonne sont moyennées en énergie. Échelle de couleur sur 45 dB sous le niveau le plus
   * fort (99,5e centile, pour ne pas être écrasée par un choc isolé). Les droites théoriques
   * d'engrènement sont tracées par-dessus pour identifier les traces. */
  function drawCampbell() {
    const canvas = $id("campbellCanvas"), H = 440;
    const rows = selectedRows();
    if (!rows.length) { message(canvas, H, state.rows.length ? "Aucune ligne avec vitesse pour ce filtre de régime." : "Diagramme de Campbell : en attente de données (acquisition ou import JSON)."); return; }
    const { ctx, w, h } = prepCanvas(canvas, H);
    const L = 58, R = 74, T = 26, B = 42, pw = w - L - R, ph = h - T - B;
    const [vMin, vMax] = speedAxis(rows), [fMin0, fMax0] = freqRange();
    // axe vertical : fréquence (Hz) ou ORDRE (Hz par km/h) — en ordre, les droites d'engrènement deviennent horizontales
    const ordMode = ($id("campbellAxis")?.value || "freq") === "ordre";
    const K0 = 2, K1 = 14, KSTEP = 0.02;
    const fMin = ordMode ? 0 : fMin0, fMax = ordMode ? 2500 : fMax0;
    const nCol = Math.max(10, Math.min(pw, Math.round((vMax - vMin) / 1)));
    const g0 = Math.round(fMin / GRID_STEP), g1 = Math.round(fMax / GRID_STEP);
    let nRow = g1 - g0 + 1;
    const acc = new Float64Array(nCol * nRow), cnt = new Uint32Array(nCol);
    rows.forEach((r) => {
      if (r.speed < vMin || r.speed > vMax) return;
      const c = Math.min(nCol - 1, Math.max(0, Math.floor(((r.speed - vMin) / (vMax - vMin)) * nCol)));
      cnt[c]++;
      for (let g = g0; g <= g1; g++) acc[(g - g0) * nCol + c] += dbToPow(r.spec[g]);
    });
    // niveau en dB de chaque case, puis pondération des couleurs (v1.5) :
    //  « brut »  = niveau tel que mesuré (les basses fréquences dominent l'image) ;
    //  « A »     = pondération A (réduit surtout < 500 Hz) ;
    //  « fond »  = on retire, dans chaque colonne de vitesse, le fond local (médiane glissante ± 150 Hz) :
    //              une ligne d'engrènement ressort de la même façon à 1 000 Hz et à 2 000 Hz.
    const wmode = $id("campbellWeight")?.value || "fond";
    const lv = new Float32Array(nCol * nRow);
    for (let c = 0; c < nCol; c++) for (let k = 0; k < nRow; k++) lv[k * nCol + c] = cnt[c] ? powToDb(acc[k * nCol + c] / cnt[c]) : NaN;
    if (wmode === "A") {
      const aw = (f) => (typeof aWeightingCorrection === "function" ? aWeightingCorrection(f) : 0);
      for (let k = 0; k < nRow; k++) { const a = aw((g0 + k) * GRID_STEP); for (let c = 0; c < nCol; c++) lv[k * nCol + c] += a; }
    } else if (wmode === "fond") {
      const half = Math.max(8, Math.round(150 / GRID_STEP)), tmp = [];
      for (let c = 0; c < nCol; c++) {
        if (!cnt[c]) continue;
        const col = new Float32Array(nRow), base = new Float32Array(nRow);
        for (let k = 0; k < nRow; k++) col[k] = lv[k * nCol + c];
        for (let k = 0; k < nRow; k++) {
          tmp.length = 0; for (let j = Math.max(0, k - half); j <= Math.min(nRow - 1, k + half); j += 2) if (Number.isFinite(col[j])) tmp.push(col[j]);
          tmp.sort((a, b) => a - b); base[k] = tmp.length ? tmp[tmp.length >> 1] : 0;
        }
        for (let k = 0; k < nRow; k++) lv[k * nCol + c] = col[k] - base[k];
      }
    }
    let lvF = lv;
    if (ordMode) {                                   // rééchantillonnage : ligne = ordre k, fréquence = k × vitesse de la colonne
      const nK = Math.round((K1 - K0) / KSTEP) + 1, lo = new Float32Array(nCol * nK).fill(NaN);
      for (let c = 0; c < nCol; c++) {
        if (!cnt[c]) continue;
        const v = vMin + ((c + 0.5) / nCol) * (vMax - vMin);
        for (let j = 0; j < nK; j++) {
          const x = (K0 + j * KSTEP) * v / GRID_STEP, i0 = Math.floor(x);
          if (i0 < 1 || i0 >= nRow - 1) continue;
          const a = lv[i0 * nCol + c], b2 = lv[(i0 + 1) * nCol + c], wgt = x - i0;
          if (Number.isFinite(a) && Number.isFinite(b2)) lo[j * nCol + c] = a * (1 - wgt) + b2 * wgt;
        }
      }
      lvF = lo; nRow = nK;
    }
    const lv2 = lvF;
    const vals = [];
    for (let i = 0; i < lv2.length; i++) if (Number.isFinite(lv2[i])) vals.push(lv2[i]);
    vals.sort((a, b) => a - b);
    const span = wmode === "fond" ? 30 : 45;
    const vTop = vals[Math.floor(vals.length * 0.995)] ?? 0, vBot = wmode === "fond" ? Math.max(-3, vTop - span) : vTop - span;
    const img = ctx.createImageData(nCol, nRow);
    for (let k = 0; k < nRow; k++) for (let c = 0; c < nCol; c++) {
      const p = ((nRow - 1 - k) * nCol + c) * 4;
      if (!cnt[c] || !Number.isFinite(lv2[k * nCol + c])) { img.data[p] = 229; img.data[p + 1] = 231; img.data[p + 2] = 235; img.data[p + 3] = 255; continue; }
      const col = cmap((lv2[k * nCol + c] - vBot) / (vTop - vBot));
      img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = 255;
    }
    const off = document.createElement("canvas"); off.width = nCol; off.height = nRow;
    off.getContext("2d").putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, L, T, pw, ph);
    const yLo = ordMode ? K0 : fMin, yHi = ordMode ? K1 : fMax;
    const X = (v) => L + ((v - vMin) / (vMax - vMin)) * pw, Y = (u) => T + ph - ((u - yLo) / (yHi - yLo)) * ph;
    const Yf = (f, v) => Y(ordMode ? f / v : f);        // pixel d'une fréquence f observée à la vitesse v
    state.geom = { L, T, pw, ph, vMin, vMax };

    // bande de gêne
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
    ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 1;
    BAND.forEach((f) => {
      if (!ordMode) { if (f >= fMin && f <= fMax) { ctx.beginPath(); ctx.moveTo(L, Y(f)); ctx.lineTo(L + pw, Y(f)); ctx.stroke(); } }
      else { ctx.beginPath(); let st = false; for (let i = 0; i <= 80; i++) { const v = vMin + ((vMax - vMin) * i) / 80, k = f / v; if (k < K0 || k > K1) { st = false; continue; } st ? ctx.lineTo(X(v), Y(k)) : (ctx.moveTo(X(v), Y(k)), st = true); } ctx.stroke(); }
    });
    // droites théoriques d'engrènement
    if ($id("campbellTheory")?.checked !== false) {
      const c0 = cfg();
      // droites d'engrènement et harmoniques : réducteur ×1, ×2 (et ×3, ×4) ; pont ×1 (et ×2, ×3) si « Harmoniques ×1…×4 » est coché
      const harm = $id("campbellHarm")?.checked;
      const items = [];
      c0.axles.forEach((ax) => {
        const sR = chainSlope("meshReducer", ax.diameter), sB = chainSlope("meshBridge", ax.diameter);
        (harm ? [1, 2, 3, 4] : [1, 2]).forEach((m) => items.push({ ax, s: m * sR, m, nm: "Réd.", w: m === 1 ? 2 : 1.5, al: m === 1 ? 0.95 : 0.8 }));
        (harm ? [1, 2, 3] : [1]).forEach((m) => items.push({ ax, s: m * sB, m, nm: "Pont", w: m === 1 ? 1.3 : 1.1, al: 0.6 }));
      });
      items.forEach((it) => {
        const { ax, s } = it, col = ax.id === "E1" ? "#009AA6" : "#E05206";
        ctx.setLineDash(ax.id === "E1" ? [] : [7, 4]); ctx.lineWidth = it.w; ctx.strokeStyle = col; ctx.globalAlpha = it.al;
        ctx.beginPath(); ctx.moveTo(X(vMin), Yf(s * vMin, vMin)); ctx.lineTo(X(vMax), Yf(s * vMax, vMax)); ctx.stroke();
        let lx, ly;
        if (ordMode) { lx = X(vMax) - 4; ly = Y(s); if (s < K0 || s > K1) return; }
        else { const fEnd = s * vMax; if (fEnd <= fMax) { lx = X(vMax) - 4; ly = Y(fEnd); } else { lx = X(fMax / s) - 4; ly = T + 12; } }
        ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.fillStyle = col; ctx.textAlign = "right";
        const ds = c0.axles.map((x) => x.diameter), same = ds.length > 1 && Math.abs(ds[0] - ds[1]) / ((ds[0] + ds[1]) / 2) < 0.015;
        if (same && ax.id === "E2") { ctx.textAlign = "left"; return; }          // deux essieux quasi identiques : une seule étiquette
        const lab = `${it.nm}${it.m > 1 ? " ×" + it.m : ""} ${same ? "E1/E2" : ax.id} Ø${fmt(ax.diameter)}` + (ordMode ? ` (${fmt(s, 2)})` : "");
        ctx.fillText(lab, lx, ly - 4 + (ax.id === "E2" ? 14 : 0)); ctx.textAlign = "left";
      });
      ctx.globalAlpha = 1;
      const calc = window.DiametresTGV?.calculated?.();
      ctx.fillStyle = "#FFFFFF"; ctx.font = "12px Segoe UI, system-ui, sans-serif";
      ctx.fillText(calc ? `Droites tracées avec les diamètres CALCULÉS : E1 Ø${fmt(c0.diameter1)} / E2 Ø${fmt(c0.diameter2)} mm (à vérifier dans SI-Essieux)` : `Droites tracées avec les diamètres de réglage (non calculés) : E1 Ø${fmt(c0.diameter1)} / E2 Ø${fmt(c0.diameter2)} mm`, L + 8, T + ph - 8);
    }
    const d = state.diag;
    if (d?.resonance && Number.isFinite(d.resonance.f) && d.resonance.f >= fMin0 && d.resonance.f <= fMax0 && (!ordMode || (d.resonance.f / d.resonance.v >= K0 && d.resonance.f / d.resonance.v <= K1))) {
      ctx.setLineDash([]); ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X(d.resonance.v), Yf(d.resonance.f, d.resonance.v), 9, 0, Math.PI * 2); ctx.stroke();
      // à quelle droite théorique appartient ce point ? (écart de pente ≤ 2 %)
      try {
        const kk = d.resonance.f / d.resonance.v; let best = null;
        cfg().axles.forEach((ax) => [["meshReducer", 1, "réducteur"], ["meshReducer", 2, "réducteur ×2"], ["meshBridge", 1, "pont"], ["meshBridge", 2, "pont ×2"]].forEach(([key, m, nm]) => {
          const e = Math.abs(kk - m * chainSlope(key, ax.diameter)) / kk; if (e <= 0.02 && (!best || e < best.e)) best = { e, nm };
        }));
        const txt = `niveau max dans la bande : ${fmt(d.resonance.v)} km/h, ${fmt(d.resonance.f)} Hz — ` + (best ? best.nm : "aucun organe connu");
        ctx.font = "12px Segoe UI, system-ui, sans-serif"; ctx.textAlign = "left"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.7)";
        const tx = Math.min(X(d.resonance.v) + 14, L + pw - ctx.measureText(txt).width - 6), ty = Yf(d.resonance.f, d.resonance.v) - 14;
        ctx.strokeText(txt, tx, ty); ctx.fillStyle = "#FFFFFF"; ctx.fillText(txt, tx, ty);
      } catch (e) { /* étiquette facultative */ }
    }
    // vitesse de coupe choisie par un clic : ligne jaune pointillée (le spectre à cette vitesse est dans « Spectre différentiel »)
    { const sv = parseFloat($id("campbellDiffSpeed")?.value); if (Number.isFinite(sv) && sv >= vMin && sv <= vMax) { ctx.setLineDash([3, 3]); ctx.strokeStyle = "#FFB612"; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(X(sv), T); ctx.lineTo(X(sv), T + ph); ctx.stroke(); ctx.setLineDash([]); } }
    ctx.restore();

    // axes
    ctx.setLineDash([]); ctx.strokeStyle = "#3C3732"; ctx.lineWidth = 1; ctx.strokeRect(L, T, pw, ph);
    ctx.fillStyle = "#3C3732";
    const vStep = vMax - vMin > 150 ? 50 : 25;
    for (let v = Math.ceil(vMin / vStep) * vStep; v <= vMax; v += vStep) { ctx.fillText(String(v), X(v) - 10, T + ph + 16); }
    if (ordMode) { for (let k = K0; k <= K1; k += 2) ctx.fillText(String(k), 14, Y(k) + 4); }
    else { const fStep = fMax - fMin > 1200 ? 500 : fMax - fMin > 600 ? 200 : 100;
      for (let f = Math.ceil(fMin / fStep) * fStep; f <= fMax; f += fStep) ctx.fillText(String(f), 8, Y(f) + 4); }
    ctx.fillText("Vitesse (km/h)", L + pw / 2 - 40, h - 8);
    ctx.save(); ctx.translate(14, T + ph / 2 + 30); ctx.rotate(-Math.PI / 2); ctx.fillText(ordMode ? "Ordre (Hz par km/h)" : "Fréquence (Hz)", 0, 0); ctx.restore();
    ctx.font = "13px Segoe UI, system-ui, sans-serif"; ctx.fillStyle = "#3C3732";
    const filt = $id("campbellRegimeFilter")?.value;
    ctx.fillText(w < 560 ? `Campbell — ${filt || "tous régimes"}` : `Diagramme de Campbell — ${filt || "tous régimes"} — ${rows.length} lignes — cliquer = spectre à cette vitesse`, L, T - 9);
    // échelle de couleur
    const cbX = L + pw + 14, cbW = 14;
    for (let y = 0; y < ph; y++) { const col = cmap(1 - y / ph); ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`; ctx.fillRect(cbX, T + y, cbW, 1); }
    ctx.strokeStyle = "#3C3732"; ctx.strokeRect(cbX, T, cbW, ph);
    ctx.font = "11px Segoe UI, system-ui, sans-serif"; ctx.fillStyle = "#3C3732";
    ctx.fillText(fmt(vTop) , cbX + cbW + 3, T + 9); ctx.fillText(fmt(vBot), cbX + cbW + 3, T + ph); ctx.fillText(wmode === "fond" ? "dB / fond" : wmode === "A" ? "dB(A) rel." : "dB rel.", cbX - 4, T - 9);
  }

  function drawLevelSpeed() {
    const canvas = $id("campbellLevelCanvas"), H = 300, key = $id("campbellIndicator")?.value || "bandDb";
    const allRows = state.rows.filter((r) => Number.isFinite(r.speed) && Number.isFinite(r[key]) && r[key] > -159);
    if (!allRows.length) { message(canvas, H, "Courbe niveau / vitesse : en attente de données avec vitesse."); return; }
    const [vMin, vMax] = speedAxis(allRows);
    const rows = allRows.filter((r) => r.speed >= vMin && r.speed <= vMax);
    const { ctx, w, h } = prepCanvas(canvas, H);
    const L = 58, R = 18, T = 26, B = 42, pw = w - L - R, ph = h - T - B;
    const ys = rows.map((r) => r[key]).sort((a, b) => a - b);
    let yMin = Math.floor(ys[Math.floor(ys.length * 0.01)] / 5) * 5 - 5, yMax = Math.ceil(ys[ys.length - 1] / 5) * 5 + 2;
    if (yMax - yMin < 10) yMax = yMin + 10;
    const X = (v) => L + ((v - vMin) / (vMax - vMin)) * pw, Y = (y) => T + ph - ((y - yMin) / (yMax - yMin)) * ph;
    ctx.strokeStyle = "#E1E1E1";
    for (let i = 0; i <= 5; i++) { const y = T + (ph * i) / 5; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke(); ctx.fillStyle = "#4D4F53"; ctx.fillText(fmt(yMax - ((yMax - yMin) * i) / 5), 10, y + 4); }
    const vStep = vMax - vMin > 150 ? 50 : 25;
    for (let v = Math.ceil(vMin / vStep) * vStep; v <= vMax; v += vStep) { ctx.fillStyle = "#4D4F53"; ctx.fillText(String(v), X(v) - 10, T + ph + 16); }
    ctx.strokeStyle = "#3C3732"; ctx.strokeRect(L, T, pw, ph);
    // vitesses théoriques d'apparition (réducteur à 1 500 Hz)
    if (key !== "tnrDb") cfg().axles.forEach((ax) => {
      const v = BAND[0] / chainSlope("meshReducer", ax.diameter);
      if (v > vMin && v < vMax) { ctx.setLineDash([4, 4]); ctx.strokeStyle = ax.id === "E1" ? "#009AA6" : "#E05206"; ctx.beginPath(); ctx.moveTo(X(v), T); ctx.lineTo(X(v), T + ph); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = ctx.strokeStyle; ctx.fillText(`Réd. ${ax.id} → ${BAND[0]} Hz`, X(v) + 3, T + 12 + (ax.id === "E2" ? 13 : 0)); }
    });
    const groups = {};
    rows.forEach((r) => { (groups[r.regime] = groups[r.regime] || []).push(r); });
    Object.entries(groups).forEach(([reg, list]) => {
      const color = REGIME_COLORS[reg] || "#747678";
      ctx.fillStyle = color; ctx.globalAlpha = 0.28;
      list.forEach((r) => { ctx.beginPath(); ctx.arc(X(r.speed), Y(r[key]), 2, 0, Math.PI * 2); ctx.fill(); });
      ctx.globalAlpha = 1;
      const bins = key === "tnrDb"
        ? (() => { const m = new Map(); list.forEach((r) => { const b = Math.round(r.speed / 5) * 5; (m.get(b) || m.set(b, []).get(b)).push(r[key]); }); return [...m.entries()].map(([v, l]) => ({ v, mean: l.reduce((a, b) => a + b, 0) / l.length })).sort((a, b) => a.v - b.v); })()
        : speedBins(list, 5, key);
      ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.beginPath();
      bins.forEach((b, i) => (i ? ctx.lineTo(X(b.v), Y(b.mean)) : ctx.moveTo(X(b.v), Y(b.mean))));
      ctx.stroke(); ctx.lineWidth = 1;
    });
    const label = $id("campbellIndicator")?.selectedOptions?.[0]?.textContent || key;
    ctx.fillStyle = "#3C3732"; ctx.font = "13px Segoe UI, system-ui, sans-serif"; ctx.fillText(`${label} en fonction de la vitesse (points : 0,5 s ; lignes : moyenne par 5 km/h)`, L, T - 9);
    ctx.font = "12px Segoe UI, system-ui, sans-serif";
    let lx = L + 6;
    Object.keys(groups).forEach((reg) => { ctx.fillStyle = REGIME_COLORS[reg] || "#747678"; ctx.fillRect(lx, h - 14, 10, 10); ctx.fillStyle = "#3C3732"; ctx.fillText(reg, lx + 14, h - 5); lx += ctx.measureText(reg).width + 34; });
    ctx.fillText("km/h", L + pw - 30, h - 5);
  }

  function drawDifferential() {
    const canvas = $id("campbellDiffCanvas"), H = 340, info = $id("campbellDiffInfo");
    const tol = Math.max(1, parseFloat($id("campbellDiffTol")?.value) || 3);
    let v0 = parseFloat($id("campbellDiffSpeed")?.value);
    if (!Number.isFinite(v0) && state.diag?.diffSpeed) { v0 = state.diag.diffSpeed; $id("campbellDiffSpeed").value = String(v0); }
    if (!Number.isFinite(v0)) { message(canvas, H, "Spectre différentiel : indiquez une vitesse (traction et erre doivent exister à cette vitesse)."); info.textContent = ""; return; }
    const near = state.rows.filter((r) => Number.isFinite(r.speed) && Math.abs(r.speed - v0) <= tol);
    const tr = near.filter((r) => r.regime === "Traction"), er = near.filter((r) => r.regime === "Erre");
    if (!tr.length || !er.length) { message(canvas, H, `À ${fmt(v0)} ± ${fmt(tol)} km/h : ${tr.length} ligne(s) traction, ${er.length} ligne(s) erre — il faut les deux.`); info.textContent = ""; return; }
    const avg = (list) => { const a = new Float64Array(GRID_N); list.forEach((r) => { for (let g = 0; g < GRID_N; g++) a[g] += dbToPow(r.spec[g]); }); return Array.from(a, (p) => powToDb(p / list.length)); };
    const st = avg(tr), se = avg(er), diff = st.map((v, i) => v - se[i]);
    const [fMin, fMax] = freqRange(), g0 = Math.round(fMin / GRID_STEP), g1 = Math.round(fMax / GRID_STEP);
    const { ctx, w, h } = prepCanvas(canvas, H);
    const L = 58, R = 18, T = 26, gap = 34, B = 36, pw = w - L - R, ph1 = (h - T - B - gap) * 0.6, ph2 = h - T - B - gap - ph1, T2 = T + ph1 + gap;
    const X = (f) => L + ((f - fMin) / (fMax - fMin)) * pw;
    const slice = (arr) => arr.slice(g0, g1 + 1).filter((v) => v > -159);
    const all = slice(st).concat(slice(se));
    const yMax = Math.ceil(Math.max(...all) / 5) * 5, yMin = yMax - 60;
    const Y1 = (y) => T + ph1 - ((Math.max(yMin, y) - yMin) / (yMax - yMin)) * ph1;
    const dAbs = Math.max(6, Math.ceil(Math.max(...diff.slice(g0, g1 + 1).map(Math.abs)) / 3) * 3);
    const Y2 = (d) => T2 + ph2 / 2 - (Math.max(-dAbs, Math.min(dAbs, d)) / dAbs) * (ph2 / 2);
    ctx.fillStyle = "rgba(213,43,30,.07)"; ctx.fillRect(X(Math.max(fMin, BAND[0])), T, X(Math.min(fMax, BAND[1])) - X(Math.max(fMin, BAND[0])), h - T - B);
    ctx.strokeStyle = "#3C3732"; ctx.strokeRect(L, T, pw, ph1); ctx.strokeRect(L, T2, pw, ph2);
    const line = (arr, Yf, color, width) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); for (let g = g0; g <= g1; g++) { const x = X(g * GRID_STEP), y = Yf(arr[g]); g === g0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke(); ctx.lineWidth = 1; };
    line(se, Y1, REGIME_COLORS.Erre, 1.4); line(st, Y1, REGIME_COLORS.Traction, 1.4);
    ctx.strokeStyle = "#A0A0A0"; ctx.beginPath(); ctx.moveTo(L, Y2(0)); ctx.lineTo(L + pw, Y2(0)); ctx.stroke();
    line(diff, Y2, "#6E1E78", 1.6);
    ctx.fillStyle = "#4D4F53";
    for (let i = 0; i <= 4; i++) { const y = yMax - ((yMax - yMin) * i) / 4; ctx.fillText(fmt(y), 10, Y1(y) + 4); }
    [dAbs, 0, -dAbs].forEach((d) => ctx.fillText((d > 0 ? "+" : "") + d, 18, Y2(d) + 4));
    const fStep = fMax - fMin > 1200 ? 500 : fMax - fMin > 600 ? 200 : 100;
    for (let f = Math.ceil(fMin / fStep) * fStep; f <= fMax; f += fStep) ctx.fillText(String(f), X(f) - 12, h - B + 16);
    ctx.fillText("Hz", L + pw - 16, h - 6);
    ctx.fillStyle = "#3C3732"; ctx.font = "13px Segoe UI, system-ui, sans-serif";
    ctx.fillText(`Spectres moyens à ${fmt(v0)} ± ${fmt(tol)} km/h — traction (${tr.length}) / erre (${er.length})`, L, T - 9);
    ctx.fillText("Différence traction − erre (dB)", L, T2 - 9);
    ctx.font = "12px Segoe UI, system-ui, sans-serif";
    // principaux écarts
    const peaks = [];
    for (let g = Math.max(g0, Math.round(200 / GRID_STEP)); g <= g1; g++) if (diff[g] > 3 && diff[g] >= (diff[g - 1] ?? -1e9) && diff[g] >= (diff[g + 1] ?? -1e9)) peaks.push({ f: g * GRID_STEP, d: diff[g] });
    peaks.sort((a, b) => b.d - a.d);
    const chosen = [];
    peaks.forEach((p) => { if (chosen.length < 5 && chosen.every((c) => Math.abs(c.f - p.f) > 25)) chosen.push(p); });
    const bandPow = (arr) => { let s = 0; for (let g = BAND[0] / GRID_STEP; g <= BAND[1] / GRID_STEP; g++) s += dbToPow(arr[g]); return powToDb(s); };
    const c0 = cfg();
    const theo = CHAINS.map((ch) => `${ch.label.toLowerCase()} ${c0.axles.map((ax) => ax.id + " " + fmt(transmissionFrequencies(v0, ax.diameter)[ch.key]) + " Hz").join(" / ")}`).join(" ; ");
    info.innerHTML = `<b>Bande ${BAND[0]}–${BAND[1]} Hz : ${fmt(bandPow(st) - bandPow(se), 1)} dB</b> de plus en traction. ` +
      (chosen.length ? "Principales composantes liées à la charge : " + chosen.map((p) => `${fmt(p.f)} Hz (+${fmt(p.d, 1)} dB)`).join(", ") + ". " : "Aucune composante ne dépasse +3 dB. ") +
      `Repères théoriques à ${fmt(v0)} km/h : ${esc(theo)}. Grille 5 Hz : précision ±2,5 Hz.`;
  }

  function renderDiagnosis() {
    state.diag = diagnose();
    $id("campbellDiagnosis").innerHTML = "<ul>" + state.diag.lines.map((l) => `<li>${l}</li>`).join("") + "</ul>";
    // v0.9.8 : fréquences dominantes, vitesse et cause possible
    try { window.DominanteTGV?.render(state.rows, $id("dominantePanel")); } catch (e) { console.warn("Fréquences dominantes", e); }
  }
  function renderAll(force = false) {
    const section = $id("campbellSection");
    if (!section) return;
    if (!force && section.classList.contains("mobile-collapsed")) return;
    try {
      renderDiagnosis();
      drawCampbell();
      drawLevelSpeed();
      drawDifferential();
      $id("campbellExportCsv").disabled = $id("campbellExportPng").disabled = !state.rows.length;
    } catch (error) { console.error("Campbell", error); setInfo("Erreur d’affichage Campbell : " + (error?.message || error), true); }
    state.lastRender = performance.now();
  }
  /* coupe : un clic sur le diagramme fixe la vitesse du « Spectre différentiel » (traction / érre / différence) */
  function initSectionClick() {
    const cv = $id("campbellCanvas"); if (!cv || cv._sectionOk) return; cv._sectionOk = true;
    cv.style.cursor = "crosshair";
    cv.addEventListener("click", (ev) => {
      const g = state.geom; if (!g) return;
      const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
      if (x < g.L || x > g.L + g.pw || y < g.T || y > g.T + g.ph) return;
      const v = Math.round(g.vMin + ((x - g.L) / g.pw) * (g.vMax - g.vMin));
      const inp = $id("campbellDiffSpeed"); if (inp) inp.value = String(v);
      renderAll(true);
      try { $id("campbellDiffCanvas")?.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (e) { /* ignore */ }
    });
  }
  function setInfo(text, error = false) { const el = $id("campbellInfo"); if (el) { el.textContent = text; el.classList.toggle("status-error", error); } }

  /* ---------- régime horodaté ---------- */
  function setRegime(regime, fromSelect = false) {
    const sel = $id("acqRegime");
    if (!fromSelect && sel) sel.value = regime;
    document.querySelectorAll("[data-regime-btn]").forEach((b) => { const on = b.dataset.regimeBtn === regime; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
    if (typeof acqRunning !== "undefined" && acqRunning && Array.isArray(acqMarkers)) {
      acqMarkers.push({
        elapsed: (performance.now() - acqStartTime) / 1000, timestamp: new Date().toISOString(), label: "Régime : " + regime,
        speed: Number.isFinite(acqCurrentSpeed) ? acqCurrentSpeed : null, dominant: acqLastPeaks?.[0]?.f ?? null, fundamental: acqLastWork?.primary ?? null,
        latitude: acqLastPosition?.coords?.latitude ?? null, longitude: acqLastPosition?.coords?.longitude ?? null,
      });
      if (typeof renderAcqMarkers === "function") renderAcqMarkers();
      if (typeof setAcqStatus === "function") setAcqStatus(`Régime « ${regime} » enregistré à ${((performance.now() - acqStartTime) / 1000).toFixed(1)} s.`);
    }
  }

  /* ---------- écran maintenu allumé ---------- */
  async function requestWakeLock() {
    const el = $id("acqWakeState");
    if (!("wakeLock" in navigator)) { if (el) el.textContent = "Écran : maintien allumé non pris en charge par ce navigateur — désactivez la mise en veille pendant l’essai."; return; }
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
      if (el) el.textContent = "Écran maintenu allumé pendant l’acquisition.";
      state.wakeLock.addEventListener("release", () => { if (el && !acqRunning) el.textContent = ""; });
    } catch (error) { if (el) el.textContent = "Écran : maintien allumé refusé (" + (error?.message || error) + ")."; }
  }
  function releaseWakeLock() { try { state.wakeLock?.release(); } catch (e) {} state.wakeLock = null; }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && typeof acqRunning !== "undefined" && acqRunning) requestWakeLock(); });

  /* ---------- boucle ---------- */
  let lastCapture = 0;
  setInterval(() => {
    const running = typeof acqRunning !== "undefined" && acqRunning;
    if (running && !state.wasRunning) {
      state.rows = []; state.source = "live"; state.diag = null; lastCapture = 0;
      requestWakeLock();
      setInfo("Acquisition en cours : une ligne Campbell toutes les 0,5 s. Utilisez les boutons de régime à chaque changement.");
    }
    if (!running && state.wasRunning) {
      releaseWakeLock();
      setInfo(`Acquisition arrêtée : ${state.rows.length} lignes Campbell (incluses dans l’export JSON).`);
      renderAll(true);
    }
    state.wasRunning = running;
    if (!running) return;
    const now = performance.now();
    if (now - lastCapture >= CAPTURE_MS) {
      lastCapture = now;
      try { captureRow(); } catch (error) { console.error("Capture Campbell", error); }
    }
    if (now - state.lastRender > 3000) renderAll();
  }, 100);

  /* ---------- interface ---------- */
  function init() {
    document.querySelectorAll("[data-regime-btn]").forEach((b) => b.addEventListener("click", () => setRegime(b.dataset.regimeBtn)));
    $id("acqRegime")?.addEventListener("change", (e) => setRegime(e.target.value, true));
    setRegime(currentRegime(), true);
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")) return;
      if ($id("acquisitionMode")?.classList.contains("hidden")) return;
      const map = { t: "Traction", e: "Erre", f: "Freinage", s: "Statique" }, reg = map[e.key?.toLowerCase()];
      if (reg) { setRegime(reg); e.preventDefault(); }
    });
    ["campbellRegimeFilter", "campbellRange", "campbellWeight", "campbellAxis", "campbellHarm", "campbellTheory", "campbellIndicator", "campbellDiffSpeed", "campbellDiffTol"].forEach((id) => $id(id)?.addEventListener("change", () => renderAll(true)));
    ["transWheelDiameter1", "transWheelDiameter2", "transReference"].forEach((id) => $id(id)?.addEventListener("change", () => renderAll(true)));
    $id("campbellRefresh")?.addEventListener("click", () => renderAll(true));
    initSectionClick();
    $id("campbellExportCsv")?.addEventListener("click", exportIndicatorsCsv);
    $id("campbellExportPng")?.addEventListener("click", exportPng);
    $id("campbellImportButton")?.addEventListener("click", () => $id("campbellImportFile").click());
    $id("campbellImportFile")?.addEventListener("change", async (e) => {
      const file = e.target.files[0]; e.target.value = "";
      if (!file) return;
      if (typeof acqRunning !== "undefined" && acqRunning) { setInfo("Arrêtez l’acquisition avant d’importer un fichier.", true); return; }
      try {
        if (file.size > 80 * 1024 * 1024) throw new Error("Fichier trop volumineux (80 Mo maximum).");
        importData(JSON.parse(await file.text()), file.name);
      } catch (error) { console.error(error); setInfo("Import impossible : " + (error?.message || error), true); }
    });
    window.addEventListener("resize", () => renderAll(true));
    $id("modeDiagnostic")?.addEventListener("click", () => setTimeout(() => renderAll(true), 50));
    document.querySelector("#campbellSection .mobile-section-toggle")?.addEventListener("click", () => setTimeout(() => renderAll(true), 30));
    renderAll(true);
  }

  window.CampbellTGV = { indicatorsAt, exportData, importData, render: () => renderAll(true), _state: state, _diagnose: diagnose };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
