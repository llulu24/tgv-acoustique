/* Analyse Acoustique TGV — v0.9.7 RC
 * 1. Onglet Diagnostic : état des sources de données (acquisition, fichiers, vitesse…).
 * 2. Rapport PDF complet, détaillé, avec niveaux BRUTS et PONDÉRÉS A côte à côte.
 *
 * CONVENTIONS DE NIVEAU (reprises dans le rapport)
 *   - Niveau brut : spectre du micro sans correction, en dB relatifs (pas de calibration).
 *   - Niveau pondéré A, dB(A) relatifs : chaque fréquence est corrigée par la courbe A
 *     (CEI 61672 : −19,1 dB à 100 Hz, 0 dB à 1 kHz, +1,0 à +1,2 dB entre 1,5 et 2,5 kHz),
 *     qui reproduit la sensibilité de l'oreille. Le diagnostic mécanique se fait sur le brut ;
 *     la gêne ressentie s'apprécie en dB(A).
 *   - Niveau d'une bande ou niveau global : somme ÉNERGÉTIQUE des composantes
 *     (10 × log10 de la somme des 10^(L/10)), jamais une moyenne de dB.
 *   - Moyenne de plusieurs instants : moyenne énergétique également.
 */
"use strict";

(() => {
  const $id = (id) => document.getElementById(id);
  const BAND = [1500, 1700], GRID = 5, REGS = ["Traction", "Erre", "Freinage"];
  const COL = { Traction: "#D52B1E", Erre: "#0088CE", Freinage: "#82BE00" }; // mêmes couleurs que le Campbell
  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d).replace(".", ",") : "—");
  const esc = (t) => (typeof escapeHtml === "function" ? escapeHtml(String(t ?? "")) : String(t ?? ""));
  const pow = (db) => Math.pow(10, db / 10), dB = (p) => (p > 0 ? 10 * Math.log10(p) : NaN);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const A = (f) => aWeightingCorrection(f);
  const camp = () => window.CampbellTGV?._state || { rows: [] };

  /* ---------- 1. sources du diagnostic ---------- */
  function sources() {
    const c = camp(), list = [];
    const live = typeof acqRunning !== "undefined" && acqRunning;
    list.push([c.rows.length > 0, c.rows.length ? `Campbell : ${c.rows.length} lignes (${live ? "acquisition en cours" : c.source === "import" ? esc(c.importedName || "fichier importé") : "acquisition de cet appareil"})` : "Campbell : aucune donnée (acquisition ou ZIP de session)"]);
    const recs = typeof records !== "undefined" ? records : [];
    list.push([recs.length > 0, recs.length ? `Fichiers : ${recs.length} (${recs.some((r) => r.spectrum) ? "analysés" : "non analysés"})` : "Fichiers : aucun"]);
    const tr = window.AnalyseRaieTGV?.state?.speedTrack;
    list.push([!!tr?.length, tr?.length ? `Vitesse associée : ${tr.length} points` : "Vitesse associée : aucune"]);
    const tone = window.AnalyseRaieTGV?.state?.result;
    list.push([!!(tone && !tone.error), tone && !tone.error ? "Analyse du sifflement : faite" : "Analyse du sifflement : à lancer"]);
    const d = window.DiametresTGV?.state?.result;
    list.push([!!d?.found?.length, d?.found?.length ? `Diamètres : ${d.found.map((p) => fmt(p.d, 0) + " mm").join(" / ")} (${d.source === "direct" ? "en direct" : "fichier"})` : "Diamètres : non calculés"]);
    return list;
  }
  function refresh() {
    const box = $id("diagSources"); if (!box) return;
    box.innerHTML = sources().map(([ok, t]) => `<span class="diag-src${ok ? " ok" : ""}">${t}</span>`).join("");
    try { renderPreco(); } catch (e) { console.warn("Préconisations", e); }
  }
  setInterval(() => { if (!$id("diagnosticMode")?.classList.contains("hidden")) { const b = $id("diagSources"); if (b) b.innerHTML = sources().map(([ok, t]) => `<span class="diag-src${ok ? " ok" : ""}">${t}</span>`).join(""); } }, 3000);

  /* ---------- 2. calculs pour le rapport ---------- */
  function rowLevels(r) {
    // niveaux bande 1 500–1 700 Hz et global 20–2 500 Hz, brut et pondéré A, depuis la grille de 5 Hz
    let bB = 0, bA = 0, gB = 0, gA = 0;
    for (let g = 4; g < r.spec.length; g++) {
      const f = g * GRID, v = r.spec[g]; if (!(v > -150)) continue;
      const p = pow(v), pa = pow(v + A(f));
      gB += p; gA += pa;
      if (f >= BAND[0] && f <= BAND[1]) { bB += p; bA += pa; }
    }
    return { bB: dB(bB), bA: dB(bA), gB: dB(gB), gA: dB(gA) };
  }
  const emean = (arr) => { const a = arr.filter(Number.isFinite); return a.length ? dB(a.reduce((s, v) => s + pow(v), 0) / a.length) : NaN; };
  function campbellStats() {
    const rows = camp().rows; if (!rows.length) return null;
    const dts = []; for (let i = 1; i < rows.length; i++) { const d = rows[i].t - rows[i - 1].t; if (d > 0 && d < 5) dts.push(d); }
    dts.sort((a, b) => a - b); const dt = dts.length ? dts[dts.length >> 1] : 0.5;
    const L = rows.map(rowLevels);
    const vs = rows.map((r) => r.speed).filter(Number.isFinite);
    const byReg = {}; REGS.forEach((g) => (byReg[g] = rows.map((r, i) => (r.regime === g ? i : -1)).filter((i) => i >= 0)));
    // tranches de 20 km/h
    const bins = [];
    for (let v0 = 60; v0 < 320; v0 += 20) {
      const row = { v0, v1: v0 + 20 };
      REGS.forEach((g) => {
        const idx = byReg[g].filter((i) => rows[i].speed >= v0 && rows[i].speed < v0 + 20);
        row[g] = idx.length >= 6 ? { n: idx.length, bB: emean(idx.map((i) => L[i].bB)), bA: emean(idx.map((i) => L[i].bA)), gB: emean(idx.map((i) => L[i].gB)), gA: emean(idx.map((i) => L[i].gA)) } : null;
      });
      if (REGS.some((g) => row[g])) bins.push(row);
    }
    const tot = {}; REGS.forEach((g) => { const idx = byReg[g]; tot[g] = { s: idx.length * dt, bB: emean(idx.map((i) => L[i].bB)), bA: emean(idx.map((i) => L[i].bA)), gB: emean(idx.map((i) => L[i].gB)), gA: emean(idx.map((i) => L[i].gA)) }; });
    // spectres moyens par régime dans la tranche la plus rapide où traction et erre coexistent
    let ref = [...bins].reverse().find((b) => b.Traction && b.Erre) || [...bins].reverse().find((b) => b.Traction);
    const spectra = {};
    if (ref) REGS.forEach((g) => {
      const idx = byReg[g].filter((i) => rows[i].speed >= ref.v0 && rows[i].speed < ref.v1);
      if (idx.length < 6) return;
      const n = rows[0].spec.length, acc = new Float64Array(n);
      idx.forEach((i) => { for (let k = 0; k < n; k++) acc[k] += pow(rows[i].spec[k]); });
      spectra[g] = Array.from(acc, (p) => dB(p / idx.length));
    });
    return { rows, dt, duration: rows.length * dt, vMin: vs.length ? Math.min(...vs) : NaN, vMax: vs.length ? Math.max(...vs) : NaN, bins, tot, ref, spectra };
  }

  /* ---------- 2 bis. raies fixes et préconisations ---------- */
  // Bips VACMA (veille automatique de la cabine) : son bref à 1 875 Hz (harmoniques de 312,5 Hz :
  // 625, 937, 1 562 Hz), répété toutes les 30 s environ, présent aussi à l'arrêt. Reconnu le
  // 30/10/2026 (confirmé par le conducteur / l'agent d'accompagnement). Il est signalé puis exclu
  // du diagnostic des fréquences fixes.
  const VACMA_HZ = 1875, VACMA_FAMILY = [625, 937.5, 1562.5, 1875];
  function vacma() {
    const rows = camp().rows; if (!rows.length) return null;
    const k = Math.round(VACMA_HZ / GRID); if (k + 13 >= rows[0].spec.length) return null;
    const on = rows.map((r) => {
      let pk = -200; for (let g = k - 1; g <= k + 1; g++) pk = Math.max(pk, r.spec[g]);
      const nb = []; for (let g = k - 12; g <= k + 12; g++) if (Math.abs(g - k) > 2) nb.push(r.spec[g]);
      nb.sort((a, b) => a - b); return pk - nb[nb.length >> 1] > 10;
    });
    const eps = []; let last = -1e9;
    rows.forEach((r, i) => { if (!on[i]) return; if (eps.length && r.t - last <= 3) eps.at(-1).t1 = r.t; else eps.push({ t0: r.t, t1: r.t, v: r.speed }); last = r.t; });
    if (eps.length < 5) return null;
    const dur = eps.map((e) => e.t1 - e.t0 + 0.5).sort((a, b) => a - b), med = dur[dur.length >> 1];
    if (med > 8) return null;   // un son permanent n'est pas la VACMA
    return { n: eps.length, durMed: med, arret: eps.filter((e) => e.v !== null && e.v < 5).length };
  }
  // Spectre médian d'un ensemble de lignes Campbell et émergence de chaque
  // fréquence au-dessus de son voisinage (médiane ±60 Hz, hors ±10 Hz).
  function emergenceSpectrum(rows, idx) {
    // spectre MÉDIAN (et non moyenne d'énergie) : un son bref et fort (bip VACMA, choc) ne doit
    // pas passer pour une raie permanente
    const n = rows[0].spec.length, sp = new Float64Array(n), col = new Float64Array(idx.length), e = new Float64Array(n);
    for (let k = 0; k < n; k++) { idx.forEach((i, j) => (col[j] = rows[i].spec[k])); const c = Array.from(col).sort((a, b) => a - b); sp[k] = c[c.length >> 1]; }
    for (let k = 0; k < n; k++) {
      const nb = []; for (let j = Math.max(0, k - 12); j <= Math.min(n - 1, k + 12); j++) if (Math.abs(j - k) > 2) nb.push(sp[j]);
      nb.sort((a, b) => a - b); e[k] = sp[k] - nb[nb.length >> 1];
    }
    return e;
  }
  // Fréquences FIXES : émergentes (médiane ≥ 5 dB, ≥ 4 dB dans 60 % des tranches) dans au moins
  // 3 tranches de vitesse de 20 km/h couvrant 60 km/h ou plus. Une raie qui suit la vitesse
  // (engrènement) change de fréquence d'une tranche à l'autre et n'est donc pas retenue.
  function fixedLines() {
    const rows = camp().rows; if (rows.length < 200) return [];
    const sets = { tous: () => true, traction: (r) => r.regime === "Traction", horsTraction: (r) => r.regime === "Erre" || r.regime === "Freinage" };
    const found = {};
    Object.entries(sets).forEach(([name, ok]) => {
      const E = [], vb = [];
      for (let v0 = 60; v0 < 320; v0 += 20) {
        const idx = rows.map((r, i) => (ok(r) && r.speed >= v0 && r.speed < v0 + 20 ? i : -1)).filter((i) => i >= 0);
        if (idx.length >= 20) { E.push(emergenceSpectrum(rows, idx)); vb.push(v0); }
      }
      if (E.length < 3 || vb.at(-1) + 20 - vb[0] < 60) return;
      const n = E[0].length, cand = [];
      for (let k = 8; k < n; k++) {
        const col = E.map((e) => e[k]).sort((a, b) => a - b), med = col[col.length >> 1], frac = col.filter((x) => x >= 4).length / col.length;
        if (med >= 5 && frac >= 0.6) cand.push({ k, med });
      }
      // regroupement des fréquences voisines (≤ 10 Hz)
      const groups = [];
      cand.forEach((c) => { const g = groups.at(-1); if (g && c.k - g.k1 <= 2) { g.k1 = c.k; if (c.med > g.med) { g.med = c.med; g.kmax = c.k; } } else groups.push({ k0: c.k, k1: c.k, kmax: c.k, med: c.med }); });
      found[name] = groups.map((g) => ({ f0: g.k0 * GRID, f1: g.k1 * GRID, f: g.kmax * GRID, em: g.med, span: [vb[0], vb.at(-1) + 20] }));
    });
    // classement : tous régimes, seulement en traction, seulement hors traction
    const near = (a, b) => Math.abs(a.f - b.f) <= 15;
    const out = [];
    (found.tous || []).forEach((g) => out.push({ ...g, cls: "tous" }));
    (found.traction || []).forEach((g) => { if (!(found.tous || []).some((x) => near(x, g)) && !(found.horsTraction || []).some((x) => near(x, g))) out.push({ ...g, cls: "traction" }); });
    (found.horsTraction || []).forEach((g) => { if (!(found.tous || []).some((x) => near(x, g)) && !(found.traction || []).some((x) => near(x, g))) out.push({ ...g, cls: "horsTraction" }); });
    const vac = vacma();
    return out.filter((g) => !(vac && VACMA_FAMILY.some((f) => f >= g.f0 - 15 && f <= g.f1 + 15))).sort((a, b) => b.em - a.em).slice(0, 6);
  }
  // Niveau et émergence de l'engrènement réducteur d'un essieu (diamètre D) sur les lignes
  // Campbell, traction contre erre à vitesse égale (tranches de 20 km/h au-dessus de 150 km/h).
  function meshTractionErre(D) {
    const rows = camp().rows; if (!rows.length) return null;
    const s1 = transmissionFrequencies(100, 1000).meshReducer / 100;
    const at = (r) => {
      const f0 = (s1 * r.speed) / (D / 1000), g0 = Math.round((f0 * 0.988) / GRID), g1 = Math.round((f0 * 1.012) / GRID);
      if (g1 >= r.spec.length - 1) return null;
      let pk = -200; for (let g = g0; g <= g1; g++) pk = Math.max(pk, r.spec[g]);
      const nb = []; for (let g = Math.round((f0 * 0.96) / GRID); g <= Math.round((f0 * 1.04) / GRID); g++) if (g < g0 || g > g1) nb.push(r.spec[g]);
      nb.sort((a, b) => a - b); return pk - nb[nb.length >> 1];
    };
    const diffs = [], emT = [];
    for (let v0 = 150; v0 < 320; v0 += 20) {
      const T = [], E = [];
      rows.forEach((r) => { if (!(r.speed >= v0 && r.speed < v0 + 20)) return; const e = at(r); if (e === null) return; if (r.regime === "Traction") T.push(e); else if (r.regime === "Erre") E.push(e); });
      const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
      if (T.length >= 10) emT.push(med(T));
      if (T.length >= 10 && E.length >= 10) diffs.push(med(T) - med(E));
    }
    const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
    return { emTraction: mean(emT), diffTE: mean(diffs), nBins: diffs.length };
  }
  function preconisations() {
    const list = [], calc = window.DiametresTGV?.calculated?.(), d = window.DiametresTGV?.state?.result;
    const found = d?.found || [], n = d?.n || 0, rel = calc?.reliability || (n >= 120 ? "fiable" : n >= 60 ? "correcte" : "en cours");
    const s1 = transmissionFrequencies(100, 1000).meshReducer / 100;
    const axles = found.map((p, i) => ({ ...p, label: found.length === 2 ? (i ? "essieu de plus grand diamètre" : "essieu de plus petit diamètre") : "essieu(x)", te: meshTractionErre(p.d) }));
    // v0.9.9 : la gêne réelle dans 1500–1700 Hz (part des lignes bruyantes en traction attribuées à l'engrènement de l'essieu)
    // passe avant l'émergence brute du sifflement, qui ne tient pas compte de la bande où le conducteur entend le bruit.
    axles.forEach((a) => { try { a.gene = window.EnqueteTGV?.shareForDiameter?.(a.d) || null; } catch (e) { a.gene = null; } });
    const loud = axles.filter((a) => a.em >= 10 || (a.gene && a.gene.share >= 0.2)), medium = axles.filter((a) => !loud.includes(a) && a.em >= 6);
    loud.sort((a, b) => (a.gene && b.gene && Math.abs(a.gene.share - b.gene.share) >= 0.1 ? b.gene.share - a.gene.share : b.em - a.em));
    loud.forEach((a, i) => {
      const te = a.te && Number.isFinite(a.te.diffTE) ? a.te.diffTE : null, f300 = (s1 * 300) / (a.d / 1000);
      const constat = `Sifflement d’engrènement du réducteur très élevé : émergence ${fmt(a.em)} dB en traction stable (${fmt(f300, 0)} Hz à 300 km/h)` + (te !== null ? `, traction − erre ${te >= 0 ? "+" : ""}${fmt(te)} dB à vitesse égale` : "") + `. Diamètre calculé ${fmt(a.d, 1)} mm (${a.label}).` + (a.gene ? ` Gêne dans 1500–1700 Hz : ${fmt(100 * a.gene.share)} % des lignes bruyantes en traction${Number.isFinite(a.gene.vLo) ? ` (${fmt(a.gene.vLo)}–${fmt(a.gene.vHi)} km/h)` : ""}${a.gene.shareErre != null ? `, ${fmt(100 * a.gene.shareErre)} % en érre` : ""}.` : "");
      if (n < 60) list.push({ niv: "controle", titre: "Confirmer la mesure", constat, action: "Refaire une mesure avec au moins 2 min de traction stable au-dessus de 150 km/h avant toute dépose (diamètre encore peu précis)." });
      else if (te !== null && te < 3) list.push({ niv: "controle", titre: "Contrôle du GMR", constat, action: "Le sifflement change peu entre traction et erre : vérifier une résonance excitée par l’engrènement avant dépose ; contrôle du GMR de cet essieu selon les règles de maintenance." });
      else if (i > 0 && (a.em < loud[0].em - 2 || (a.gene && loud[0].gene && a.gene.share < loud[0].gene.share / 2))) list.push({ niv: "controle", titre: "GMR à re-mesurer après la dépose prioritaire", constat,
        action: `${a.gene && loud[0].gene && a.gene.share < loud[0].gene.share / 2 ? `Beaucoup moins gênant dans 1500–1700 Hz (${fmt(100 * a.gene.share)} % des lignes bruyantes contre ${fmt(100 * loud[0].gene.share)} %) que l’essieu ≈ ${fmt(loud[0].d, 0)} mm` : `Sifflement également élevé mais nettement inférieur à celui de l’essieu ≈ ${fmt(loud[0].d, 0)} mm`} : refaire une mesure après la dépose du GMR prioritaire avant de décider la dépose du GMR de l’essieu ≈ ${fmt(a.d, 0)} mm (identifier dans SI-Essieux).` });
      else list.push({ niv: "depose", titre: `Préconisation de dépose du GMR${loud.length > 1 ? (i ? " (priorité 2)" : " (priorité 1)") : ""}`, constat,
        action: `Dépose du groupe motoréducteur (GMR) de l’essieu de diamètre ≈ ${fmt(a.d, 0)} mm. Identifier cet essieu dans SI-Essieux parmi les deux essieux de tête (correspondance des diamètres) avant l’intervention.` });
    });
    medium.forEach((a) => list.push({ niv: "controle", titre: "Surveillance du GMR",
      constat: `Sifflement d’engrènement du réducteur marqué (émergence ${fmt(a.em)} dB) sur l’essieu de diamètre ≈ ${fmt(a.d, 0)} mm.`,
      action: "Pas de dépose sur ce seul critère : nouvelle mesure lors d’un prochain accompagnement et contrôle du GMR à la prochaine opération de maintenance (état de denture, roulements, huile)." }));
    // contrôle de cohérence : un diamètre hors 850–924 mm signale un problème de mesure
    if (n >= 60) axles.filter((a) => window.DiametresTGV?.horsCotes?.(a.d)).forEach((a) => list.push({ niv: "controle", titre: "Diamètre calculé incohérent",
      constat: `Diamètre calculé ${fmt(a.d, 1)} mm, hors de la plage possible d’une roue TGV (850–924 mm).`,
      action: "Le sifflement attribué à cet essieu est douteux : vérifier la vitesse GPS (décalage, mauvais CSV associé) avant d’exploiter ce résultat pour une préconisation." }));
    if (!found.length && camp().rows.length) list.push({ niv: "controle", titre: "Diamètres non calculables",
      constat: "Aucun sifflement d’engrènement assez net pour calculer les diamètres de roue.",
      action: "Impossible d’attribuer un bruit d’engrènement à un essieu. Refaire une mesure avec au moins 2 min de traction stable au-dessus de 150 km/h, régime « Traction » saisi." });
    fixedLines().forEach((g) => {
      const fr = g.f0 === g.f1 ? `${g.f} Hz` : `${g.f0}–${g.f1} Hz`;
      const base = `Fréquence fixe ${fr} (émergence ${fmt(g.em)} dB) qui ne varie pas avec la vitesse (${g.span[0]}–${g.span[1]} km/h) : ce n’est pas un engrènement ni une rotation d’essieu`;
      if (g.cls === "traction") list.push({ niv: "orientation", titre: "Chaîne de traction électrique", constat: base + ", présente seulement en traction.", action: "Orienter vers la chaîne de traction électrique (onduleur / convertisseur, moteur de traction : bruit magnétique ou de découpage). Contrôle de la chaîne de traction ; pas de dépose de GMR sur ce critère." });
      else if (g.cls === "horsTraction") list.push({ niv: "orientation", titre: "Freinage ou équipements hors traction", constat: base + ", présente sur l’erre et au freinage mais pas en traction.", action: "Orienter vers le freinage (frottement, garnitures / disques) ou un équipement actif hors traction. Contrôle du freinage ; pas de dépose de GMR sur ce critère." });
      else list.push({ niv: "orientation", titre: "Auxiliaires ou résonance de structure", constat: base + ", présente dans tous les régimes.", action: "Orienter vers les auxiliaires (ventilation, compresseur, climatisation, groupes de refroidissement) ou une résonance de structure (cabine, vitrages, panneaux). Contrôle des auxiliaires et des fixations ; mesure à l’arrêt, auxiliaires en marche, pour confirmer." });
    });
    const vac = vacma();
    if (vac) list.push({ niv: "info", titre: "Bips VACMA identifiés", constat: `${vac.n} bips brefs à 1 875 Hz (durée médiane ${fmt(vac.durMed, 1)} s${vac.arret ? `, dont ${vac.arret} à l’arrêt` : ""}) : signal de veille automatique de la cabine.`, action: "Sans lien avec le roulement ni la transmission : exclus du diagnostic des fréquences fixes. Aucune action." });
    if (!list.some((p) => p.niv === "depose" || p.niv === "controle") && found.length) list.unshift({ niv: "info", titre: "Pas de dépose préconisée", constat: `Sifflement d’engrènement présent mais modéré (émergence ${axles.map((a) => fmt(a.em)).join(" / ")} dB).`, action: "Pas d’action sur le réducteur. Suivre l’évolution lors des prochains accompagnements." });
    return list;
  }
  const NIV = { depose: "Dépose", controle: "Contrôle", orientation: "Orientation", info: "Information" };
  function renderPreco() {
    const box = $id("precoResult"); if (!box) return;
    const list = preconisations();
    // une carte par préconisation, triées par niveau (dépose d'abord)
    const ORDER = { depose: 0, controle: 1, orientation: 2, info: 3 };
    box.innerHTML = list.length
      ? `<div class="preco-list">` + [...list].sort((a, b) => ORDER[a.niv] - ORDER[b.niv]).map((p) => `<article class="preco-card ${p.niv}"><span class="preco-niv-chip">${NIV[p.niv]}</span><div class="preco-title">${esc(p.titre)}</div><div class="preco-action">${esc(p.action)}</div><div class="preco-constat">${esc(p.constat)}</div></article>`).join("") + "</div>"
      : "Aucune préconisation pour l’instant. Chargez une session (ZIP) dans l’onglet Fichiers ou faites une acquisition, puis lancez « Calculer les diamètres E1 / E2 ».";
  }

  /* ---------- 3. graphiques du rapport ---------- */
  function lineChart(ctx, w, h, o) {
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, w, h);
    const L = 70, R = 20, T = 40, B = 50, pw = w - L - R, ph = h - T - B;
    const ys = o.series.flatMap((s) => s.pts.map((p) => p[1])).filter(Number.isFinite);
    if (!ys.length) return;
    const yMax = Math.ceil(Math.max(...ys) / 5) * 5 + 2, yMin = o.yMin ?? Math.floor(Math.max(Math.min(...ys), yMax - 70) / 5) * 5;
    const X = (x) => L + ((x - o.xmin) / (o.xmax - o.xmin)) * pw, Y = (y) => T + ph - ((Math.max(yMin, y) - yMin) / (yMax - yMin)) * ph;
    if (o.band) { ctx.fillStyle = "rgba(224,82,6,0.10)"; ctx.fillRect(X(o.band[0]), T, X(o.band[1]) - X(o.band[0]), ph); }
    ctx.strokeStyle = "#E1E1E1"; ctx.fillStyle = "#4D4F53"; ctx.font = "13px Arial"; ctx.lineWidth = 1;
    for (let x = o.xmin; x <= o.xmax + 1e-9; x += o.xstep) { ctx.beginPath(); ctx.moveTo(X(x), T); ctx.lineTo(X(x), T + ph); ctx.stroke(); ctx.fillText(String(x), X(x) - 12, h - 30); }
    for (let y = yMin; y <= yMax; y += 10) { ctx.beginPath(); ctx.moveTo(L, Y(y)); ctx.lineTo(L + pw, Y(y)); ctx.stroke(); ctx.fillText(String(y), L - 36, Y(y) + 4); }
    ctx.fillText(o.xlab, L + pw / 2 - 60, h - 10);
    ctx.save(); ctx.translate(18, T + ph / 2 + 50); ctx.rotate(-Math.PI / 2); ctx.fillText(o.ylab, 0, 0); ctx.restore();
    o.series.forEach((s) => {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.setLineDash(s.dash || []); ctx.beginPath();
      let on = false; s.pts.forEach(([x, y]) => { if (!Number.isFinite(y)) { on = false; return; } on ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)); on = true; });
      ctx.stroke(); ctx.setLineDash([]);
      if (s.marks) s.pts.forEach(([x, y]) => { if (Number.isFinite(y)) { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(X(x), Y(y), 3.5, 0, 2 * Math.PI); ctx.fill(); } });
    });
    ctx.fillStyle = "#3C3732"; ctx.font = "bold 15px Arial"; ctx.fillText(o.title, L, 24);
    let lx = L + pw - 10; ctx.font = "13px Arial";
    [...o.series].reverse().forEach((s) => { const tw = ctx.measureText(s.name).width; lx -= tw + 34; ctx.strokeStyle = s.color; ctx.lineWidth = 3; ctx.setLineDash(s.dash || []); ctx.beginPath(); ctx.moveTo(lx, 20); ctx.lineTo(lx + 22, 20); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = "#3C3732"; ctx.fillText(s.name, lx + 26, 24); });
  }
  const chart = (o, w = 1100, h = 440) => { const c = document.createElement("canvas"); c.width = w; c.height = h; lineChart(c.getContext("2d"), w, h, o); return c.toDataURL("image/png"); };
  function canvasImage(id) {
    const c = $id(id); if (!c || !c.width || !c.height) return null;
    try { return c.toDataURL("image/png"); } catch (e) { return null; }
  }
  // dessin d'un graphique de l'onglet Fichiers en mode brut ou pondéré A
  function withWeighting(aOn, fn) {
    const box = $id("aWeighting"); const old = box?.checked;
    if (box) box.checked = aOn;
    try { return fn(); } finally { if (box) box.checked = old; }
  }

  /* ---------- 4. construction du rapport ---------- */
  const H = (tag, html, style = "") => { const e = document.createElement(tag); if (style) e.style.cssText = style; e.innerHTML = html; return e; };
  function section(container, title, pageBreak = false) {
    const s = document.createElement("section"); s.className = "report-chart";
    s.style.cssText = (pageBreak ? "break-before:page;" : "") + "margin-bottom:14px";
    s.appendChild(H("h2", esc(title), "font-size:18px;margin:14px 0 6px;color:#4D4F53;border-bottom:2px solid #4D4F53;padding-bottom:3px"));
    container.appendChild(s); return s;
  }
  const note = (t) => H("div", t, "font-size:11.5px;color:#4D4F53;margin:4px 0 10px;line-height:1.45");
  const img = (url, alt) => { const i = createReportImage(url, alt); i.style.cssText = "width:100%;max-width:1100px;break-inside:avoid"; return i; };
  function table(headers, rows) { const t = makeSimpleTable(headers, rows); t.style.cssText = "border-collapse:collapse;font-size:11.5px;width:100%;margin:6px 0"; t.querySelectorAll("th,td").forEach((c) => (c.style.cssText = "border:1px solid #A0A0A0;padding:3px 6px;text-align:center")); t.querySelectorAll("th").forEach((c) => (c.style.background = "#E1E1E1")); return t; }
  const textOf = (id) => ($id(id)?.innerText || "").trim();

  async function build(progress = () => {}) {
    const container = $id("reportContainer"); container.innerHTML = "";
    const prevMode = typeof appMode !== "undefined" ? appMode : "analysis";
    const recs = typeof records !== "undefined" ? records.filter((r) => r.spectrum) : [];
    const cfg = getTransmissionConfig();
    // 0. images de l'onglet Diagnostic (affiché un instant pour avoir la bonne largeur)
    progress("Préparation des graphiques de diagnostic…");
    setAppMode("diagnostic"); await wait(120);
    window.CampbellTGV?.render(); window.dispatchEvent(new Event("resize")); await wait(400);
    const shots = { campbell: canvasImage("campbellCanvas"), level: canvasImage("campbellLevelCanvas"), diff: canvasImage("campbellDiffCanvas"), track: canvasImage("toneTrackCanvas"), orders: canvasImage("toneOrderCanvas") };
    const campDiag = textOf("campbellDiagnosis"), toneDiag = textOf("toneDiagnosis"), diffInfo = textOf("campbellDiffInfo");
    progress("Préparation de la carte du trajet…");
    if (window.CarteTrajetTGV) await window.CarteTrajetTGV.prepareReport();
    setAppMode(prevMode); await wait(60);
    progress("Mise en page du rapport…");
    const st = campbellStats(), tone = window.AnalyseRaieTGV?.state?.result, diam = window.DiametresTGV?.state?.result;
    const val = (id) => ($id(id)?.value || "").trim();
    const ident = { rame: val("rame") || val("acqRame"), motrice: val("motrice") || val("acqMotrice"), train: val("train") || val("acqTrain"), date: val("date") };

    // page de garde
    container.appendChild(H("div", `<div style="font-size:24px;font-weight:700;color:#4D4F53">Rapport de diagnostic acoustique TGV</div>
      <div style="font-size:13px;color:#4D4F53;margin:2px 0 10px">Analyse Acoustique TGV ${esc(STABILITY_CONFIG.applicationVersion)} — généré le ${new Date().toLocaleString("fr-FR")}</div>`));
    const calc = window.DiametresTGV?.calculated?.();
    container.appendChild(table(["Rame", "Motrice", "Train", "Date de l’essai", "Diamètres de roue calculés", "Chaîne de transmission"],
      [[ident.rame || "—", ident.motrice || "—", ident.train || "—", ident.date || "—", calc ? `${calc.single ? fmt(calc.d1, 0) + " mm (2 essieux proches)" : fmt(calc.d1, 0) + " / " + fmt(calc.d2, 0) + " mm"} — ${calc.reliability}` : "non calculés", "27/41/51 – 44/51"]]));
    container.appendChild(note(calc ? "<b>Diamètres calculés à partir du sifflement d’engrènement.</b> " + esc(window.DiametresTGV.SI_ESSIEUX) + " Tous les repères théoriques du rapport (spectres, Campbell) utilisent ces diamètres calculés."
      : `<b>Diamètres non calculés</b> (pas assez de traction stable) : les repères théoriques utilisent les valeurs de réglage ${fmt(cfg.diameter1, 0)} / ${fmt(cfg.diameter2, 0)} mm. Diamètres réels à relever dans SI-Essieux.`));
    const srcRows = [];
    if (st) srcRows.push(["Données Campbell (son + vitesse)", camp().source === "import" ? camp().importedName || "fichier importé" : "acquisition sur l’appareil", `${fmt(st.duration / 60, 1)} min`, `${fmt(st.vMin, 0)}–${fmt(st.vMax, 0)} km/h`]);
    recs.forEach((r) => srcRows.push(["Fichier audio", r.name, `${fmt(r.duration / 60, 1)} min`, r.speedRange ? `${fmt(r.speedRange[0], 0)}–${fmt(r.speedRange[1], 0)} km/h` : r.speed ? `${r.speed} km/h` : "—"]));
    if (srcRows.length) container.appendChild(table(["Source", "Nom", "Durée", "Vitesse"], srcRows));

    // 1. résumé chiffré
    const s1 = section(container, "1. Résumé");
    const res = [];
    if (st) {
      REGS.forEach((g) => { if (st.tot[g].s > 0) res.push([`Temps en ${g.toLowerCase()}`, `${fmt(st.tot[g].s / 60, 1)} min`, `bande ${fmt(st.tot[g].bB)} dB / ${fmt(st.tot[g].bA)} dB(A)`]); });
      const both = st.bins.filter((b) => b.Traction && b.Erre);
      if (both.length) {
        const dB_ = both.map((b) => b.Traction.bB - b.Erre.bB), dA_ = both.map((b) => b.Traction.bA - b.Erre.bA);
        res.push(["Écart traction − erre, bande 1 500–1 700 Hz, à vitesse égale", `${fmt(dB_.reduce((a, v) => a + v, 0) / dB_.length)} dB brut`, `${fmt(dA_.reduce((a, v) => a + v, 0) / dA_.length)} dB(A) (${both.length} tranche(s) de 20 km/h)`]);
      }
    }
    if (tone && !tone.error && tone.os) res.push(["Fréquence du sifflement suivi", `${fmt(tone.os.fMid, 0)} Hz`, `émergence ${fmt(tone.ord?.toneEmergence)} dB au-dessus du bruit voisin`]);
    if (diam?.found?.length) res.push(["Diamètres de roue calculés", diam.found.map((p) => fmt(p.d, 1) + " mm").join(" / "), `${diam.source === "direct" ? "en direct" : "sur fichier"}, ${diam.n} s de traction stable`]);
    if (res.length) s1.appendChild(table(["Indicateur", "Valeur", "Détail"], res));
    const precos = preconisations();
    if (precos.length) {
      s1.appendChild(H("div", "<b>Préconisations</b>", "font-size:13px;margin-top:8px"));
      s1.appendChild(table(["Niveau", "Constat", "Préconisation"], precos.map((p) => [`${NIV[p.niv]} — ${p.titre}`, p.constat, p.action])));
      s1.lastChild.querySelectorAll("td").forEach((c) => (c.style.textAlign = "left"));
      s1.appendChild(note("Préconisations d’aide à la décision, à valider selon les règles de maintenance et l’avis de l’expert."));
    }
    if (campDiag) s1.appendChild(note("<b>Diagnostic automatique :</b><br>" + esc(campDiag).replace(/\n+/g, "<br>")));
    const domRes = window.DominanteTGV?.last;
    if (domRes?.families?.length) { s1.appendChild(note("<b>Fréquences dominantes : vitesse et cause possible</b>")); try { s1.appendChild(note(window.DominanteTGV.calcNote())); } catch (e) { /* note de diamètres facultative */ } s1.appendChild(table(["#", "Fréquence", "Vitesse", "Présence par régime", "Cause possible"], window.DominanteTGV.rowsForReport(domRes))); }

    // v0.9.9 : enquête (verdict, suspects, carte de gêne, spectre traction − érre)
    try {
      const enq = window.EnqueteTGV?.reportParts?.();
      if (enq) {
        s1.appendChild(note("<b>Enquête : verdict</b><br>" + esc(enq.head) + "<br>" + enq.lines.map(esc).join("<br>")));
        if (enq.suspects.length) s1.appendChild(table(["Piste", "Indice /100", "Preuves"], enq.suspects.map((r) => [r[0], String(r[1]), r[2]])));
        enq.imgs.forEach(([t, url]) => { s1.appendChild(note("<b>" + esc(t) + "</b>")); s1.appendChild(createReportImage(url, t)); });
      }
    } catch (e) { console.warn("Rapport enquête", e); }

    // 2. conventions
    const s2 = section(container, "2. Conventions de mesure : brut et pondéré A");
    s2.appendChild(note(`<b>Niveau brut</b> : spectre du micro sans correction, en dB relatifs. C’est la base du diagnostic mécanique (fréquences, émergences, bandes latérales).<br>
      <b>Niveau pondéré A</b>, dB(A) relatifs : chaque fréquence est corrigée par la courbe A (CEI 61672), qui reproduit la sensibilité de l’oreille. Il sert à apprécier la gêne ressentie par les conducteurs.<br>
      <b>Niveau d’une bande et niveau global</b> : somme énergétique des composantes ; les moyennes dans le temps sont aussi énergétiques.<br>
      <b>Niveaux relatifs</b> : sans calibration acoustique, ce ne sont pas des mesures sonométriques absolues ou réglementaires. Seules les comparaisons (régimes, vitesses, rames mesurées avec le même matériel) ont un sens.<br>
      Spectres : fenêtre de Hann, FFT ${esc($id("fftSize")?.value || "8192")} points sur fichier (≈ ${fmt(8000 / (parseInt($id("fftSize")?.value) || 8192), 2)} Hz par case à 8 kHz) ; données Campbell : une ligne toutes les ${fmt(st?.dt ?? 0.5, 2)} s, grille de 5 Hz.`));
    s2.appendChild(table(["Fréquence (Hz)", "63", "125", "250", "500", "1 000", "1 500", "1 600", "1 700", "2 000", "2 500"],
      [["Correction A (dB)", ...[63, 125, 250, 500, 1000, 1500, 1600, 1700, 2000, 2500].map((f) => fmt(A(f)))]]));

    // 3. niveaux par régime et vitesse
    if (st?.bins.length) {
      const s3 = section(container, "3. Niveaux par régime et par vitesse (brut et pondéré A)", true);
      s3.appendChild(note("Bande gênante 1 500–1 700 Hz et niveau global 20–2 500 Hz, moyenne énergétique par tranche de 20 km/h (au moins 6 lignes par case). « — » : pas assez de mesures."));
      s3.appendChild(table(["Vitesse (km/h)", "Traction brut", "Traction dB(A)", "Erre brut", "Erre dB(A)", "Freinage brut", "Freinage dB(A)", "Écart T−E brut", "Écart T−E dB(A)"],
        st.bins.map((b) => [`${b.v0}–${b.v1}`, fmt(b.Traction?.bB), fmt(b.Traction?.bA), fmt(b.Erre?.bB), fmt(b.Erre?.bA), fmt(b.Freinage?.bB), fmt(b.Freinage?.bA),
          b.Traction && b.Erre ? fmt(b.Traction.bB - b.Erre.bB) : "—", b.Traction && b.Erre ? fmt(b.Traction.bA - b.Erre.bA) : "—"])));
      s3.appendChild(H("div", "<b>Niveau global 20–2 500 Hz</b>", "font-size:12px;margin-top:8px"));
      s3.appendChild(table(["Vitesse (km/h)", "Traction brut", "Traction dB(A)", "Erre brut", "Erre dB(A)", "Freinage brut", "Freinage dB(A)"],
        st.bins.map((b) => [`${b.v0}–${b.v1}`, fmt(b.Traction?.gB), fmt(b.Traction?.gA), fmt(b.Erre?.gB), fmt(b.Erre?.gA), fmt(b.Freinage?.gB), fmt(b.Freinage?.gA)])));
      const mid = (b) => (b.v0 + b.v1) / 2;
      const ser = (key) => REGS.filter((g) => st.bins.some((b) => b[g])).map((g) => ({ name: g, color: COL[g], marks: true, pts: st.bins.map((b) => [mid(b), b[g]?.[key]]) }));
      s3.appendChild(img(chart({ title: "Bande 1 500–1 700 Hz en fonction de la vitesse — brut", xlab: "vitesse (km/h)", ylab: "dB relatif", xmin: 60, xmax: 320, xstep: 20, series: ser("bB") }, 1100, 380), "Bande brut"));
      s3.appendChild(img(chart({ title: "Bande 1 500–1 700 Hz en fonction de la vitesse — pondéré A", xlab: "vitesse (km/h)", ylab: "dB(A) relatif", xmin: 60, xmax: 320, xstep: 20, series: ser("bA") }, 1100, 380), "Bande A"));
      if (st.ref && Object.keys(st.spectra).length) {
        const f = (k) => k * GRID;
        const sp = (aOn) => Object.entries(st.spectra).map(([g, s]) => ({ name: g, color: COL[g], width: 1.6, pts: s.map((v, k) => [f(k), aOn ? v + A(f(k)) : v]).filter(([x]) => x >= 50) }));
        s3.appendChild(H("div", `<b>Spectres moyens par régime entre ${st.ref.v0} et ${st.ref.v1} km/h</b>`, "font-size:12px;margin-top:8px;break-before:page"));
        s3.appendChild(img(chart({ title: `Spectre moyen ${st.ref.v0}–${st.ref.v1} km/h — brut`, xlab: "fréquence (Hz)", ylab: "dB relatif", xmin: 0, xmax: 2500, xstep: 250, band: BAND, series: sp(false) }), "Spectre brut"));
        s3.appendChild(img(chart({ title: `Spectre moyen ${st.ref.v0}–${st.ref.v1} km/h — pondéré A`, xlab: "fréquence (Hz)", ylab: "dB(A) relatif", xmin: 0, xmax: 2500, xstep: 250, band: BAND, series: sp(true) }), "Spectre A"));
      }
    }

    // 4. Campbell
    if (shots.campbell && st) {
      const s4 = section(container, "4. Diagramme de Campbell et traction / erre", true);
      s4.appendChild(note("Fréquence en fonction de la vitesse (niveau brut en couleur). Une droite qui part de zéro est un organe tournant ; les droites théoriques d’engrènement E1 / E2 sont superposées."));
      s4.appendChild(img(shots.campbell, "Diagramme de Campbell"));
      if (shots.level) s4.appendChild(img(shots.level, "Niveau en fonction de la vitesse"));
      if (shots.diff) { s4.appendChild(img(shots.diff, "Spectre différentiel traction − erre")); if (diffInfo) s4.appendChild(note(esc(diffInfo))); }
    }
    // 5. sifflement
    if (tone && !tone.error && shots.track) {
      const s5 = section(container, "5. Analyse du sifflement (organe en cause)", true);
      s5.appendChild(img(shots.track, "Suivi du sifflement"));
      if (shots.orders) s5.appendChild(img(shots.orders, "Spectre en ordres"));
      if (toneDiag) s5.appendChild(note(esc(toneDiag).replace(/\n+/g, "<br>")));
    }
    // 6. diamètres
    if (diam?.found?.length) { const before = container.children.length; window.DiametresTGV.appendToReport(container); const s = container.children[before]; if (s) { s.style.breakBefore = "page"; s.querySelector("h2").textContent = "6. Diamètres de roue calculés à partir du sifflement"; } }
    // 7. fichiers : spectres brut et pondéré A
    if (recs.length) {
      const s7 = section(container, "7. Spectres des fichiers : brut et pondéré A", true);
      s7.appendChild(img(withWeighting(false, () => makeCanvasImage(drawComparisonOn)), "Comparaison brut"));
      s7.appendChild(img(withWeighting(true, () => makeCanvasImage(drawComparisonOn)), "Comparaison pondérée A"));
      const peakRows = [...($id("peaksBody")?.querySelectorAll("tr") || [])].map((tr) => [...tr.children].map((td) => td.textContent));
      if (peakRows.length) { s7.appendChild(H("div", "<b>Principaux pics par fichier</b> (niveau brut et pondéré A)", "font-size:12px;margin-top:8px")); s7.appendChild(table(["Fichier", "Rang", "Fréquence", "Mode", "Niveau actif", "Niveau brut", "dB(A) relatif", "Type", "Famille", "Orientation"], peakRows)); }
      const g = textOf("frequencyGuidance"), sy = textOf("summary");
      if (g) s7.appendChild(note("<b>Orientation fréquentielle :</b><br>" + esc(g).replace(/\n+/g, "<br>")));
      if (sy) s7.appendChild(note("<b>Synthèse :</b><br>" + esc(sy).replace(/\n+/g, "<br>")));
      recs.forEach((r) => {
        const s = section(container, `Fichier : ${r.name}`, true);
        s.appendChild(note(`Vitesse : ${esc(r.speed || "—")} km/h — régime : ${esc(r.regime || "—")} — durée : ${fmt(r.duration, 1)} s`));
        s.appendChild(img(withWeighting(false, () => makeCanvasImage((c, w, h) => drawIndividualSpectrumOn(c, w, h, r))), "Spectre brut"));
        s.appendChild(img(withWeighting(true, () => makeCanvasImage((c, w, h) => drawIndividualSpectrumOn(c, w, h, r))), "Spectre pondéré A"));
        // le spectrogramme (temps × fréquence) n'apporte rien de plus que le Campbell quand la vitesse
        // est connue ; il n'est gardé que pour un fichier sans données de vitesse
        if (!st) { if (!r.spectrogram) computeSpectrogram(r); s.appendChild(img(makeCanvasImage((c, w, h) => drawSpectrogramOn(c, w, h, r), 1100, 560), "Spectrogramme")); }
      });
    }
    // 8. carte
    if (window.CarteTrajetTGV) { const before = container.children.length; window.CarteTrajetTGV.appendToReport(container); const s = container.children[before]; if (s?.querySelector("h2")) s.querySelector("h2").textContent = "8. Carte du trajet GPS"; }
    // 9. REX et limites
    if (typeof appendRexToPdf === "function") appendRexToPdf(container);
    const lim = section(container, "Limites et précautions");
    lim.appendChild(note(`Niveaux relatifs non calibrés : ne pas comparer à des seuils réglementaires. Vitesse GPS indicative (perte possible en tunnel). Régimes saisis à la main par l’accompagnateur (retour d’environ 1,5 s sur le son). Diamètres : précision ± 2 à 3 mm après 2 min de traction stable ; deux essieux à moins de 1,5 % d’écart ne sont pas séparables. Outil d’aide au diagnostic : il ne remplace pas les contrôles de maintenance.`));
    container.appendChild(H("div", `Document généré par Analyse Acoustique TGV ${esc(STABILITY_CONFIG.applicationVersion)} — SNCF Technicentre Le Landy.`, "margin-top:14px;font-size:11px;color:#4D4F53"));
  }

  async function printFromDiagnostic() {
    const b = $id("diagPdf"), t = b.textContent;
    if (!(typeof records !== "undefined" && records.some((r) => r.spectrum)) && !camp().rows.length) { $id("diagSources").insertAdjacentHTML("beforeend", '<div class="status-error small">Rien à mettre dans le rapport : faites une acquisition, ou chargez et analysez un fichier.</div>'); return; }
    try { b.disabled = true; await build((x) => (b.textContent = x)); await waitForReportImages($id("reportContainer")); b.textContent = "Ouverture du PDF…"; window.print(); }
    catch (error) { console.error(error); alertText(error); }
    finally { b.disabled = false; b.textContent = t; }
  }
  function alertText(error) { const box = $id("diagSources"); if (box) box.insertAdjacentHTML("beforeend", `<div class="status-error small">Erreur pendant le rapport : ${esc(error?.message || error)}</div>`); }
  function init() { $id("diagPdf")?.addEventListener("click", printFromDiagnostic); refresh(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

  window.DiagnosticTGV = { refresh, preconisations, fixedLines, vacma };
  window.RapportTGV = { build, _stats: campbellStats };
})();
