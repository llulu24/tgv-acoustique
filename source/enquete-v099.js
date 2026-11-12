/* Analyse Acoustique TGV — v1.1 Diagnostic (fiabilité du verdict)
 * « Enquête » : un constat, des sources classées avec leurs éléments, et deux graphiques faits
 * pour répondre à la question du conducteur : « quel bruit, à quelle vitesse, et pourquoi ? »
 *
 *  1. Verdict       : source principale, vitesse la plus gênante, fiabilité de l'analyse.
 *  2. Suspects      : chaque fréquence dominante reçoit un indice de concordance (0–100) construit
 *                     sur 4 preuves : elle traverse 1500–1700 Hz, elle dépend de la charge
 *                     (forte en traction, faible en érre), son diamètre équivalent correspond à
 *                     un essieu calculé, et son poids dans l'énergie.
 *  3. Carte de gêne : émergence dans 1500–1700 Hz par tranche de 10 km/h et par régime.
 *  4. Spectre « charge » : spectre moyen en traction et en érre à la vitesse la plus gênante,
 *                     et leur DIFFÉRENCE : ce que la charge ajoute, avec les repères E1 / E2.
 * Tout est calculé à l'arrêt de l'acquisition (rien pendant la mesure).
 */
"use strict";
(() => {
  const BAND = [1500, 1700], STEP = 5, REGS = ["Traction", "Erre", "Freinage"], LABEL = { Traction: "Traction", Erre: "Érre", Freinage: "Freinage" };
  const iOf = (f) => Math.round(f / STEP);
  const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d).replace(".", ",") : "—");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const median = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : NaN; };
  const css = (n, d) => { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d; } catch (e) { return d; } };

  /* émergence d'une ligne dans la bande gênante : max(1500–1700) − médiane(1300–1480 ∪ 1720–1850) ; renvoie aussi la fréquence du pic */
  function rowBand(spec) {
    let pk = -Infinity, ip = -1;
    for (let i = iOf(BAND[0]); i <= iOf(BAND[1]); i++) { const v = spec[i]; if (Number.isFinite(v) && v > pk) { pk = v; ip = i; } }
    const ref = [];
    for (let i = iOf(1300); i <= iOf(1480); i++) ref.push(spec[i]);
    for (let i = iOf(1720); i <= iOf(1850); i++) ref.push(spec[i]);
    const m = median(ref);
    return Number.isFinite(pk) && Number.isFinite(m) ? { em: pk - m, f: ip * STEP } : null;
  }
  const rowEm = (spec) => { const b = rowBand(spec); return b ? b.em : NaN; };

  /* ---------- calculs ---------- */
  function compute(rows) {
    const use = [];
    (rows || []).forEach((r) => { if (r && r.spec && Number.isFinite(r.speed) && r.speed >= 20) { const bb = rowBand(r.spec); if (bb && Number.isFinite(bb.em)) use.push({ r, v: r.speed, reg: REGS.includes(r.regime) ? r.regime : "?", em: bb.em, fpk: bb.f }); } });
    const res = { n: use.length, use, cells: {}, bins: [], worst: null, spectra: null };
    if (use.length < 30) return res;
    const vmin = Math.floor(Math.min(...use.map((u) => u.v)) / 10) * 10, vmax = Math.ceil(Math.max(...use.map((u) => u.v)) / 10) * 10;
    for (let v = vmin; v < vmax; v += 10) res.bins.push(v);
    REGS.forEach((g) => { res.cells[g] = res.bins.map((b) => { const m = use.filter((u) => u.reg === g && u.v >= b && u.v < b + 10).map((u) => u.em); return { n: m.length, em: m.length >= 3 ? median(m) : NaN }; }); });
    // vitesse la plus gênante : traction d'abord
    let best = null;
    [["Traction"], ["Traction", "Freinage", "Erre"]].some((regs) => {
      regs.forEach((g) => res.cells[g].forEach((c, i) => { if (c.n >= 5 && Number.isFinite(c.em) && (!best || c.em > best.em)) best = { g, i, em: c.em, v: res.bins[i] + 5, n: c.n }; }));
      return !!best;
    });
    res.worst = best;
    if (best) res.spectra = windowSpectra(use, best.v);
    res.order = orderSpectra(use);
    try { res.attr = attribution(use); } catch (e) { console.warn("Attribution", e); }
    // le spectre « charge » est tracé à la vitesse où le bruit gênant est le plus FRÉQUENT (organe principal),
    // plutôt qu'à la case la plus émergente, souvent isolée
    const top = res.attr && res.attr.Traction && res.attr.Traction.items[0];
    if (top && top.share >= 0.15 && res.attr.Traction.n >= 20) { const sp2 = windowSpectra(use, (top.vLo + top.vHi) / 2); if (sp2 && sp2.tr) { sp2.why = top.o.short; res.spectra = sp2; } }
    return res;
  }
  function meanSpec(list) {
    const n = 501, acc = new Float64Array(n), cnt = new Float64Array(n);
    list.forEach((u) => { for (let i = 0; i < n; i++) { const v = u.r.spec[i]; if (Number.isFinite(v)) { acc[i] += Math.pow(10, v / 10); cnt[i]++; } } });
    return Array.from(acc, (a, i) => (cnt[i] ? 10 * Math.log10(a / cnt[i]) : NaN));
  }
  /* vitesses réelles des lignes retenues : la fenêtre est centrée sur vc, mais les lignes peuvent être
   * toutes d'un seul côté (ex. 290–300 km/h pour une fenêtre 270–300) : les repères doivent suivre les lignes. */
  function spd(list) { const v = list.map((u) => u.v).sort((a, b) => a - b); return v.length ? { vm: v.reduce((a, b) => a + b, 0) / v.length, vlo: v[Math.floor(0.05 * (v.length - 1))], vhi: v[Math.ceil(0.95 * (v.length - 1))] } : {}; }
  function windowSpectra(use, vc) {
    let half = 15, out = null;
    for (; half <= 30; half += 15) {
      const inW = use.filter((u) => Math.abs(u.v - vc) <= half);
      const tr = inW.filter((u) => u.reg === "Traction"), er = inW.filter((u) => u.reg === "Erre");
      if (tr.length >= 3 && er.length >= 3) { out = { vc, half, nT: tr.length, nE: er.length, tr: meanSpec(tr), er: meanSpec(er), ...spd(tr) }; break; }
      if (half === 30) out = { vc, half, nT: tr.length, nE: er.length, tr: tr.length >= 3 ? meanSpec(tr) : null, er: er.length >= 3 ? meanSpec(er) : null, ...spd(tr) };
    }
    if (out && out.tr && out.er) {
      out.diff = out.tr.map((v, i) => v - out.er[i]);
      let b = -Infinity, bi = -1;
      for (let i = iOf(BAND[0]); i <= iOf(BAND[1]); i++) if (Number.isFinite(out.diff[i]) && out.diff[i] > b) { b = out.diff[i]; bi = i; }
      out.peak = bi >= 0 ? { f: bi * STEP, d: b } : null;
      let b2 = -Infinity, bi2 = -1;
      for (let i = iOf(800); i <= iOf(2300); i++) if (Number.isFinite(out.diff[i]) && out.diff[i] > b2) { b2 = out.diff[i]; bi2 = i; }
      out.peakAll = bi2 >= 0 && (bi2 * STEP < BAND[0] || bi2 * STEP > BAND[1]) && b2 >= b + 3 ? { f: bi2 * STEP, d: b2 } : null;
    }
    return out;
  }

  /* Spectre par ordre : l'axe est f / v (Hz par km/h). Une fréquence d'engrènement proportionnelle à la
   * vitesse y reste FINE (au lieu de s'étaler de ±6 % sur une moyenne en fréquence) et tombe sur
   * 5,81 × 900 / D : le repère E1 / E2 doit donc coïncider avec le pic. */
  const K0 = 4.0, K1 = 7.4, KS = 0.02;
  function orderSpectra(use) {
    let vmin = 150, tr = use.filter((u) => u.reg === "Traction" && u.v >= vmin), er = use.filter((u) => u.reg === "Erre" && u.v >= vmin);
    if (tr.length < 10) { vmin = 100; tr = use.filter((u) => u.reg === "Traction" && u.v >= vmin); er = use.filter((u) => u.reg === "Erre" && u.v >= vmin); }
    if (tr.length < 10) return null;
    const nk = Math.round((K1 - K0) / KS) + 1, ks = Array.from({ length: nk }, (_, i) => K0 + i * KS);
    const mean = (list) => {
      const acc = new Float64Array(nk), cnt = new Float64Array(nk);
      list.forEach((u) => { const sp = u.r.spec; for (let j = 0; j < nk; j++) { const x = (ks[j] * u.v) / STEP, i0 = Math.floor(x); if (i0 < 0 || i0 >= 500) continue; const a = sp[i0], b = sp[i0 + 1]; if (!Number.isFinite(a) || !Number.isFinite(b)) continue; const w = x - i0; acc[j] += Math.pow(10, (a * (1 - w) + b * w) / 10); cnt[j]++; } });
      return Array.from(acc, (a, j) => (cnt[j] > 0 ? 10 * Math.log10(a / cnt[j]) : NaN));
    };
    const o = { ks, vmin, nT: tr.length, nE: er.length, tr: mean(tr), er: er.length >= 5 ? mean(er) : null };
    if (o.er) o.diff = o.tr.map((v, j) => v - o.er[j]);
    return o;
  }
  /* Attribution des fréquences gênantes : chaque ligne dont le pic de 1500–1700 Hz émerge de ≥ 8 dB est
   * rapprochée de l'organe dont la fréquence théorique (à la vitesse de la ligne) est à moins de 1,2 %. */
  const TOLK = 0.012, EM_LOUD = 8;
  function organList(axles) {
    const out = [];
    axles.forEach((a) => {
      const t = transmissionFrequencies(100, a.d); if (!t) return;
      [["red", t.meshReducer / 100, "engrènement du réducteur", "réd."], ["pont", t.meshBridge / 100, "engrènement du pont", "pont"]].forEach(([kind, k, lab, sh]) => {
        out.push({ kind, mult: 1, k, axle: a, label: `${lab} ${a.id} (Ø${fmt(a.d)})`, short: `${sh} ${a.id}` });
        out.push({ kind, mult: 2, k: 2 * k, axle: a, label: `harmonique 2 du ${lab.replace("engrènement du ", "")} ${a.id}`, short: `${sh} ${a.id} ×2` });
      });
    });
    return out;
  }
  function attribution(use) {
    const orgs = organList(markAxles()), res = {};
    REGS.forEach((g) => {
      const loud = use.filter((u) => u.reg === g && u.em >= EM_LOUD && u.v >= 60), tally = new Map(); let un = [];
      loud.forEach((u) => {
        let best = null;
        orgs.forEach((o) => { const e = Math.abs(u.fpk - o.k * u.v) / (o.k * u.v); if (e <= TOLK && (!best || e < best.e)) best = { o, e }; });
        if (best) { if (!tally.has(best.o)) tally.set(best.o, []); tally.get(best.o).push(u); } else un.push(u);
      });
      const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
      const items = [...tally.entries()].map(([o, l]) => ({ o, n: l.length, share: l.length / loud.length, vLo: q(l.map((u) => u.v), 0.1), vHi: q(l.map((u) => u.v), 0.9), em: median(l.map((u) => u.em)) })).sort((x, y) => y.n - x.n);
      res[g] = { n: loud.length, items, unShare: loud.length ? un.length / loud.length : 0, unN: un.length, unV: un.length ? [q(un.map((u) => u.v), 0.1), q(un.map((u) => u.v), 0.9)] : null, unF: un.length ? median(un.map((u) => u.fpk)) : NaN };
    });
    return res;
  }
  function shareOf(g, o) { const it = res_attr(g).items.find((x) => x.o.kind === o.kind && x.o.mult === o.mult && x.o.axle.id === o.axle.id); return it ? it.share : 0; }
  function res_attr(g) { return (last && last.res && last.res.attr && last.res.attr[g]) || { n: 0, items: [], unShare: 0 }; }
  /* part des lignes bruyantes (traction) attribuée à l'engrènement du réducteur d'un essieu de diamètre d */
  function shareForDiameter(d) {
    const a = last && last.res && last.res.attr && last.res.attr.Traction; if (!a || a.n < 20) return null;
    const it = a.items.find((x) => x.o.kind === "red" && x.o.mult === 1 && Math.abs(x.o.axle.d - d) <= 8);
    return { share: it ? it.share : 0, n: a.n, vLo: it ? it.vLo : NaN, vHi: it ? it.vHi : NaN, shareErre: (() => { const e = last.res.attr.Erre; const x = e && e.items.find((y) => y.o.kind === "red" && y.o.mult === 1 && Math.abs(y.o.axle.d - d) <= 8); return e && e.n >= 20 ? (x ? x.share : 0) : null; })() };
  }
  function calc() { try { return window.DominanteTGV?.calcAxles?.() || null; } catch (e) { return null; } }
  function axlesNow() {
    const c = calc(); if (c) return c.axles.map((a) => ({ id: a.id, d: a.d, calc: true }));
    try { return getTransmissionConfig().axles.map((a) => ({ id: a.id, d: a.diameter, calc: false })); } catch (e) { return []; }
  }

  /* deux essieux dont les diamètres diffèrent de moins de 1,5 % ont des fréquences indiscernables (≈ 4 Hz d'écart
   * à 1 700 Hz, moins que le lissage dû à la vitesse) : on les traite comme un seul groupe, pour ne pas
   * attribuer arbitrairement le bruit à l'un des deux. */
  const CLOSE = 0.015;
  function mergeClose(list) {
    if (list.length === 2 && Math.abs(list[0].d - list[1].d) / ((list[0].d + list[1].d) / 2) < CLOSE)
      return [{ id: "E1/E2", d: (list[0].d + list[1].d) / 2, src: list[0].src, merged: true }];
    return list;
  }
  /* repères du graphique : diamètres calculés, sinon diamètres déduits des fréquences, sinon réglages */
  function markAxles() { return mergeClose(markAxlesRaw()); }
  function markAxlesRaw() {
    const c = calc(); if (c) return c.axles.map((a) => ({ id: a.id, d: a.d, src: "calculé" }));
    try {
      const fams = (window.DominanteTGV && window.DominanteTGV.last && window.DominanteTGV.last.families) || [], ds = [];
      fams.forEach((f) => { const o = f.organs && f.organs[0]; if (o && /^engrènement du réducteur/.test(o.label) && f.type !== "fixe" && !ds.some((x) => Math.abs(x - o.dEq) < 15)) ds.push(o.dEq); });
      if (ds.length) { ds.sort((a, b) => a - b); return ds.slice(0, 2).map((d, i) => ({ id: ds.length > 1 ? "E" + (i + 1) : "essieu", d, src: "déduit" })); }
    } catch (e) { /* repli */ }
    return axlesNow().map((a) => ({ id: a.id, d: a.d, src: "réglage" }));
  }

  /* ---------- suspects ---------- */
  function suspects(dom) {
    const fams = (dom && dom.families) || [], ax = markAxles().map((a) => ({ id: a.id, d: a.d, src: a.src, calc: a.src === "calculé" })), c = calc(), out = [];
    fams.forEach((d, idx) => {
      let name, axle = null, diamTxt = "";
      if (d.type === "fixe") {
        const mult = d.fMed / 50, isMult = Math.abs(mult - Math.round(mult)) * 50 <= 3 && Math.round(mult) >= 1;
        name = Math.abs(d.fMed - 1875) <= 15 ? "Bip VACMA (1 875 Hz)" : `Fréquence fixe ${fmt(d.fMed)} Hz${isMult ? ` (≈ ${Math.round(mult)} × 50 Hz)` : ""}`;
      } else if (d.organs && d.organs.length) {
        const o = d.organs[0];
        const best = ax.map((a) => ({ a, e: Math.abs(a.d - o.dEq) })).sort((x, y) => x.e - y.e)[0];
        if (best && best.e <= Math.max(5, 0.015 * best.a.d)) { axle = best.a; diamTxt = `${axle.id} Ø${fmt(axle.d)} mm (${axle.src})`; }
        name = `${o.label.replace(/ \(.*?\)/, "")} — Ø équivalent ${fmt(o.dEq)} mm${axle ? " → " + diamTxt : ""}`;
      } else name = `Fréquence ${fmt(d.fMed)} Hz suivant la vitesse (organe non identifié)`;
      const overlap = d.fType === "fixe" || d.type === "fixe" ? (d.fMed >= BAND[0] && d.fMed <= BAND[1] ? 1 : 0)
        : (d.fHi >= BAND[0] && d.fLo <= BAND[1] ? 1 : d.bandCross ? 0.6 : 0);
      const loadS = d.load === "charge" ? 1 : d.load === "indep" ? 0.2 : d.load === "erre" ? 0 : 0.5;
      const diamS = d.type === "fixe" ? 0.3 : axle ? (axle.calc ? 1 : 0.7) : d.organs && d.organs.length ? 0.4 : 0;
      const rankS = [1, 0.7, 0.5, 0.35][idx] ?? 0.2;
      let attrS = 0, attrShare = null, attrV = null;
      if (axle && d.organs && d.organs[0] && d.type !== "fixe") {
        const lb = d.organs[0].label, kind = /pont/.test(lb) ? "pont" : "red", mult = /harmonique 2/.test(lb) ? 2 : 1;
        const it = res_attr("Traction").items.find((x) => x.o.kind === kind && x.o.mult === mult && x.o.axle.id === axle.id);
        attrShare = it ? it.share : 0; attrV = it ? [it.vLo, it.vHi] : null; attrS = Math.min(1, attrShare / 0.4);
      }
      const score = Math.round(30 * overlap + 15 * loadS + 15 * diamS + 10 * rankS + 30 * attrS);
      const why = [];
      why.push(overlap === 1 ? `<b>+</b> passe dans la bande gênante 1500–1700 Hz (${d.type === "fixe" ? fmt(d.fMed) + " Hz" : fmt(d.fLo) + "–" + fmt(d.fHi) + " Hz"})`
        : overlap > 0 ? `<b>+</b> franchira la bande gênante à ${fmt(d.bandCross[0])}–${fmt(d.bandCross[1])} km/h (au-delà de la plage mesurée)` : "<b>–</b> hors de la bande gênante 1500–1700 Hz");
      why.push(d.load === "charge" ? "<b>+</b> liée à la charge : présente en traction/freinage, faible en érre" : d.load === "indep" ? "<b>–</b> aussi présente en érre : peu dépendante de la charge" : d.load === "erre" ? "<b>–</b> surtout en érre" : "<b>?</b> régime insuffisamment renseigné");
      if (axle) why.push(`<b>+</b> diamètre équivalent correspondant à ${esc(diamTxt)}`);
      else if (d.type !== "fixe" && d.organs && d.organs.length) why.push(c ? "<b>–</b> ne correspond à aucun diamètre calculé" : "<b>?</b> diamètres non calculés : valeurs de réglage");
      if (attrShare !== null && res_attr("Traction").n >= 20) why.push(attrShare >= 0.05 ? `<b>+</b> explique <b>${fmt(100 * attrShare)} %</b> des lignes bruyantes en traction${attrV ? ` (${fmt(attrV[0])}–${fmt(attrV[1])} km/h)` : ""}` : "<b>–</b> n’explique presque aucune ligne bruyante en traction (< 5 %)");
      why.push(`<b>=</b> rang ${d.rank} par énergie (${d.nRows} lignes, ${fmt(d.dbMed)} dB rel.)`);
      out.push({ d, name, score, why, axle, attrShare });
    });
    return out.sort((a, b) => b.score - a.score);
  }


  /* ---------- fiabilité du verdict (v1.1) ----------
   * Chaque critère vaut 2 (solide), 1 (limite) ou 0 (insuffisant). Le niveau global est le plus bas de
   * l'indice de concordance de la source n°1 et du bilan des critères : on ne peut pas être « élevé » avec
   * des données trop courtes, même si la source semble évidente.                                        */
  const LV = ["faible", "moyenne", "élevée"];
  function reliability(res, sus) {
    const crit = [], need = [];
    const add = (name, pts, detail, fix) => { crit.push({ name, pts, detail }); if (pts < 2 && fix) need.push(fix); };
    const n = res.n || 0, use = res.use || [];
    add("Quantité de données", n >= 200 ? 2 : n >= 60 ? 1 : 0, `${n} lignes avec vitesse (≥ 20 km/h)`, "enregistrer plus longtemps à vitesse stable ou variable (idéalement ≥ 200 lignes)");
    const vs = use.map((u) => u.v), span = vs.length ? Math.max(...vs) - Math.min(...vs) : 0;
    add("Plage de vitesse", span >= 80 ? 2 : span >= 40 ? 1 : 0, vs.length ? `${fmt(Math.min(...vs))} à ${fmt(Math.max(...vs))} km/h (${fmt(span)} km/h d’écart)` : "aucune vitesse exploitable", "couvrir au moins 40 km/h d’écart (accélération ou ralentissement) pour distinguer une fréquence liée à la vitesse d’une fréquence fixe");
    const nT = use.filter((u) => u.reg === "Traction").length, nE = use.filter((u) => u.reg === "Erre").length, nQ = use.filter((u) => u.reg === "?").length;
    add("Traction et érre renseignées", nT >= 30 && nE >= 10 ? 2 : nT >= 15 && nE >= 5 ? 1 : 0, `${nT} lignes traction, ${nE} érre`, "marquer le régime (traction / érre) pendant l’acquisition : sans érre, on ne sait pas ce qui dépend de la charge");
    add("Régimes connus", n && nQ / n <= 0.1 ? 2 : n && nQ / n <= 0.3 ? 1 : 0, `${fmt(n ? 100 * nQ / n : 0)} % des lignes sans régime`, "renseigner le régime sur toute la mesure");
    const w = res.worst, em = w && Number.isFinite(w.em) ? w.em : NaN;
    add("Émergence du bruit", em >= 10 ? 2 : em >= 6 ? 1 : 0, Number.isFinite(em) ? `+${fmt(em, 1)} dB dans 1500–1700 Hz` : "non mesurable", "refaire la mesure au moment où le conducteur entend le bruit");
    const ax = markAxles(), src = ax[0] && ax[0].src, merged = ax.some((a) => a.merged || a.id === "E1/E2");
    add("Diamètres de roue", src === "calculé" ? 2 : src === "déduit" ? 1 : 0, src === "calculé" ? "calculés à partir du sifflement" : src === "déduit" ? "déduits des fréquences" : "valeurs de réglage non vérifiées", "lancer le calcul des diamètres (onglet Diagnostic) avant de conclure");
    const at = res.attr && res.attr.Traction;
    if (at && at.n >= 20) add("Lignes expliquées", at.unShare <= 0.3 ? 2 : at.unShare <= 0.6 ? 1 : 0, `${fmt(100 * (1 - at.unShare))} % des lignes bruyantes en traction rapprochées d’un organe`, `${fmt(100 * at.unShare)} % des lignes bruyantes ne correspondent à aucun organe connu : chercher une autre source (voir les fréquences fixes)`);
    else add("Lignes expliquées", 0, `seulement ${at ? at.n : 0} lignes bruyantes en traction (20 minimum)`, "plus de lignes bruyantes en traction sont nécessaires pour attribuer le bruit");
    const gap = sus.length > 1 ? sus[0].score - sus[1].score : sus.length ? 30 : 0;
    add("Source n°1 bien séparée", gap >= 15 ? 2 : gap >= 6 ? 1 : 0, sus.length > 1 ? `${gap} points d’avance sur la n°2` : sus.length ? "une seule source" : "aucune source", "deux sources proches : une seconde mesure à une autre vitesse permet de les distinguer");
    const sum = crit.reduce((a, c) => a + c.pts, 0), bad = crit.filter((c) => c.pts === 0).length, ratio = sum / (2 * crit.length);
    const lvCrit = ratio >= 0.8 && bad === 0 ? 2 : ratio >= 0.5 && bad <= 1 ? 1 : 0;
    const top = sus[0], lvScore = top ? (top.score >= 75 ? 2 : top.score >= 55 ? 1 : 0) : 0;
    const lv = Math.min(lvCrit, lvScore);
    // capacité à désigner l'essieu : impossible si les diamètres sont trop proches
    const desig = merged ? { ok: false, txt: "Le son ne permet pas de distinguer l’essieu A de l’essieu B : les deux diamètres sont presque identiques (écart < 1,5 %). Seule une mesure près de chaque réducteur les distinguerait." }
      : ax.length > 1 ? { ok: true, txt: "Les deux essieux ont des diamètres assez différents pour être distingués au son. L’ordre E1 / E2 par rapport à la position dans la motrice reste à confirmer sur place." }
      : { ok: false, txt: "Un seul diamètre exploitable : l’essieu ne peut pas être désigné." };
    return { level: LV[lv], lv, crit, need, ratio, desig, limitedBy: lvCrit < lvScore ? "données" : lvScore < lvCrit ? "suspect" : null };
  }

  /* ---------- verdict ---------- */
  function actionFor(s) {
    const d = s.d;
    if (d.type === "fixe") return Math.abs(d.fMed - 1875) <= 15 ? "Bip VACMA : écarté de l’analyse." : "Fréquence indépendante de la vitesse : aucun organe de la chaîne de transmission ne lui correspond.";
    const lab = d.organs && d.organs[0] ? d.organs[0].label.replace(/ \(.*?\)/, "") : "";
    const ess = s.axle ? (s.axle.merged ? "l’un des deux essieux (diamètres trop proches pour être distingués au son)" : s.axle.id) : "l’essieu concerné";
    if (lab) return `Organe dont la fréquence correspond au bruit mesuré : ${lab} de ${ess}. L’analyse identifie l’organe par sa fréquence ; elle ne mesure pas son état.`;
    return "Aucun organe de la chaîne de transmission ne correspond à cette fréquence par km/h.";
  }
  function verdict(res, sus, rel) {
    const w = res.worst, sp = res.spectra, top = sus[0];
    const lines = [];
    let head;
    if (!w || !Number.isFinite(w.em)) head = "Pas assez de données avec vitesse pour conclure (30 lignes minimum à plus de 20 km/h).";
    else if (w.em < 6) head = `Aucune émergence nette dans 1500–1700 Hz (maximum +${fmt(w.em, 1)} dB à ${fmt(w.v)} km/h).`;
    else head = `Le bruit de 1500–1700 Hz émerge de <b>+${fmt(w.em, 1)} dB</b> vers <b>${fmt(w.v)} km/h</b> (${LABEL[w.g].toLowerCase()}).`;
    // deux vitesses gênantes : l'émergence maximale et le bruit le plus fréquent peuvent venir de deux fréquences d'un même organe
    try {
      const atT = res.attr && res.attr.Traction, topA = atT && atT.n >= 20 && atT.items[0];
      if (w && Number.isFinite(w.em) && w.em >= 6 && topA && topA.share >= 0.15) {
        const near = (res.use || []).filter((u) => u.reg === w.g && Math.abs(u.v - w.v) <= 5 && u.em >= EM_LOUD);
        if (near.length >= 3) {
          const fm = median(near.map((u) => u.fpk)), vm = median(near.map((u) => u.v));
          let bo = null; organList(markAxles()).forEach((o) => { const e = Math.abs(fm - o.k * vm) / fm; if (e <= 0.02 && (!bo || e < bo.e)) bo = { o, e }; });
          const vMid = (topA.vLo + topA.vHi) / 2;
          if (bo && Math.abs(vMid - w.v) > 30 && (bo.o.kind !== topA.o.kind || bo.o.mult !== topA.o.mult)) {
            const same = bo.o.kind === topA.o.kind && bo.o.axle.id === topA.o.axle.id;
            lines.push(`<b>Deux vitesses gênantes.</b> Vers <b>${fmt(w.v)} km/h</b>, le bruit ressort le plus fort (+${fmt(w.em, 1)} dB) à ≈ ${fmt(fm)} Hz : c’est ${esc(bo.o.label)} (${near.length} lignes seulement). Vers <b>${fmt(topA.vLo)}–${fmt(topA.vHi)} km/h</b>, il est le plus <i>fréquent</i> (${fmt(100 * topA.share)} % des lignes bruyantes) : ${esc(topA.o.label)}.` + (same ? " <b>Les deux fréquences correspondent au même organe</b> (fondamental et harmonique) : deux passages dans 1500–1700 Hz." : " Ce sont deux organes différents."));
          }
        }
      }
    } catch (e) { /* explication facultative */ }
    if (w && sp && sp.peak && sp.diff) lines.push(`À <b>${fmt(sp.vc)} km/h</b> (vitesse où le bruit gênant est le plus fréquent), la charge ajoute <b>+${fmt(sp.peak.d, 1)} dB à ${fmt(sp.peak.f)} Hz</b> (spectre traction − érre, ${sp.nT} lignes traction / ${sp.nE} érre).`);
    if (w && sp && sp.peakAll) lines.push(`Excès plus fort <i>hors bande</i> : +${fmt(sp.peakAll.d, 1)} dB à ${fmt(sp.peakAll.f)} Hz (non rattaché à un organe : voir les fréquences ci-dessous).`);
    if (w && sp && !sp.diff) lines.push("Pas assez de lignes en érre à cette vitesse pour isoler ce que la charge ajoute : marquer l’érre pendant l’acquisition.");
    const at = res.attr && res.attr.Traction;
    if (at && at.n >= 20) {
      const top3 = at.items.slice(0, 3).map((it) => `${esc(it.o.short)} <b>${fmt(100 * it.share)} %</b> (${fmt(it.vLo)}–${fmt(it.vHi)} km/h)`);
      lines.push(`Origine des ${at.n} lignes bruyantes en traction : ${top3.length ? top3.join(", ") + ", " : ""}non attribuées <b>${fmt(100 * at.unShare)} %</b>.`);
    }
    let conf = "—";
    if (top) {
      conf = rel ? rel.level : (top.score >= 75 ? "élevée" : top.score >= 55 ? "moyenne" : "faible");
      const conc = Number.isFinite(top.attrShare) ? `, soit ${fmt(100 * top.attrShare)} % des lignes bruyantes en traction à cette fréquence par km/h` : "";
      lines.push(`Source principale : <b>${esc(top.name)}</b>${conc} (fiabilité de l’analyse : <b>${conf}</b>${rel && rel.limitedBy === "données" ? ", limitée par les données" : ""}).`);
      if (rel && !rel.desig.ok) lines.push(`<b>Limite de l’analyse :</b> ${esc(rel.desig.txt)}`);
      if (top.d.bandCross) lines.push(`Il traverse la bande gênante entre <b>${fmt(top.d.bandCross[0])} et ${fmt(top.d.bandCross[1])} km/h</b>.`);
      lines.push(esc(actionFor(top)));
    }
    return { head, lines, conf };
  }

  /* ---------- dessin ---------- */
  function setup(cv, w, h) { const dpr = window.devicePixelRatio || 1; cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + "px"; cv.style.height = h + "px"; const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); return g; }
  function drawHeat(cv, res, W) {
    const colW = (W - 70) / Math.max(1, res.bins.length), H = 150, g = setup(cv, W, H);
    const txt = css("--text", "#3C3732"), mut = css("--muted", "#747678"), acc = css("--accent", "#CD0037"), bd = css("--border", "#D7D7D7");
    g.font = "12px Segoe UI, Arial, sans-serif"; g.textBaseline = "middle";
    const maxEm = Math.max(12, ...REGS.flatMap((r) => res.cells[r].map((c) => (Number.isFinite(c.em) ? c.em : 0))));
    REGS.forEach((r, ri) => {
      const y = 8 + ri * 38; g.fillStyle = txt; g.textAlign = "left"; g.fillText(LABEL[r], 2, y + 16);
      res.cells[r].forEach((c, i) => {
        const x = 70 + i * colW;
        g.fillStyle = css("--panel", "#fff"); g.fillRect(x, y, colW - 1, 32);
        if (Number.isFinite(c.em)) {
          const a = Math.max(0.06, Math.min(1, c.em / maxEm)); g.globalAlpha = a; g.fillStyle = acc; g.fillRect(x, y, colW - 1, 32); g.globalAlpha = 1;
          if (colW >= 24) { g.fillStyle = a > 0.55 ? "#fff" : txt; g.textAlign = "center"; g.fillText(fmt(c.em), x + colW / 2, y + 16); }
        } else { g.strokeStyle = bd; g.strokeRect(x + 0.5, y + 0.5, colW - 2, 31); }
        if (res.worst && res.worst.g === r && res.worst.i === i) { g.strokeStyle = txt; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, colW - 3, 30); g.lineWidth = 1; }
      });
    });
    g.fillStyle = mut; g.textAlign = "center";
    res.bins.forEach((b, i) => { if (i % Math.ceil(30 / colW) === 0 || colW >= 30) g.fillText(String(b), 70 + i * colW + colW / 2, 8 + 3 * 38 + 6); });
    g.textAlign = "left"; g.fillText("km/h — émergence dB dans 1500–1700 Hz (cadre = pire cas)", 70, H - 6);
  }
  function drawFft(cv, res, W) {
    const sp = res.spectra, H = 352, g = setup(cv, W, H);
    const txt = css("--text", "#3C3732"), mut = css("--muted", "#747678"), acc = css("--accent", "#CD0037"), acc2 = css("--accent2", "#6E1E78"), ok = css("--ok", "#009AA6"), bd = css("--border", "#D7D7D7");
    g.font = "12px Segoe UI, Arial, sans-serif";
    if (!sp || (!sp.tr && !sp.er)) { g.fillStyle = mut; g.fillText("Pas assez de lignes à la vitesse la plus gênante.", 10, 24); return; }
    const L = 56, R = W - 10, F0 = 800, F1 = 2300, x = (f) => L + ((f - F0) / (F1 - F0)) * (R - L);
    const ref = sp.tr || sp.er, base = median(Array.from(ref.slice(iOf(F0), iOf(F1) + 1))); const sh = (a) => (a ? a.map((v) => v - base) : a); const TR = sh(sp.tr), ER = sh(sp.er);
    const top = { y0: 44, y1: 240 }, bot = { y0: 268, y1: 326 };
    const series = [TR, ER].filter(Boolean);
    let lo = Infinity, hi = -Infinity; series.forEach((s) => { for (let i = iOf(F0); i <= iOf(F1); i++) if (Number.isFinite(s[i])) { lo = Math.min(lo, s[i]); hi = Math.max(hi, s[i]); } });
    lo = Math.floor(lo / 5) * 5 - 2; hi = Math.ceil(hi / 5) * 5 + 2;
    const y = (v) => top.y1 - ((v - lo) / (hi - lo)) * (top.y1 - top.y0);
    // bande gênante
    g.fillStyle = acc; g.globalAlpha = 0.10; g.fillRect(x(BAND[0]), top.y0, x(BAND[1]) - x(BAND[0]), bot.y1 - top.y0); g.globalAlpha = 1;
    // grille
    g.strokeStyle = bd; g.fillStyle = mut; g.textAlign = "right"; g.lineWidth = 1;
    for (let v = Math.ceil(lo / 10) * 10; v <= hi; v += 10) { g.beginPath(); g.moveTo(L, y(v)); g.lineTo(R, y(v)); g.stroke(); g.fillText((v > 0 ? "+" : "") + v, L - 4, y(v) + 4); }
    g.save(); g.translate(11, (top.y0 + top.y1) / 2); g.rotate(-Math.PI / 2); g.textAlign = "center"; g.fillStyle = mut; g.fillText("dB au-dessus du fond  (haut = plus fort)", 0, 0); g.restore(); g.fillStyle = mut; g.textAlign = "right";
    g.textAlign = "center"; for (let f = 1000; f <= 2200; f += 200) g.fillText(String(f), x(f), bot.y1 + 16);
    g.textAlign = "left"; g.fillText("Hz", R - 16, bot.y1 + 16);
    const line = (s, col, wd) => { g.beginPath(); let st = false; for (let i = iOf(F0); i <= iOf(F1); i++) { const v = s[i]; if (!Number.isFinite(v)) continue; const px = x(i * STEP), py = y(v); st ? g.lineTo(px, py) : (g.moveTo(px, py), st = true); } g.strokeStyle = col; g.lineWidth = wd; g.stroke(); g.lineWidth = 1; };
    if (ER) line(ER, ok, 1.4); if (TR) line(TR, acc, 1.8);
    // repères théoriques à la vitesse du pire cas
    try {
      const marks = [];
      markAxles().forEach((a, k) => { const vm = sp.vm || sp.vc, t = transmissionFrequencies(vm, a.d), tl = transmissionFrequencies(sp.vlo || vm - sp.half, a.d), th = transmissionFrequencies(sp.vhi || vm + sp.half, a.d); if (t) { marks.push({ f: t.meshReducer, lo: tl.meshReducer, hi: th.meshReducer, t: `réd. ${a.id} Ø${fmt(a.d)} (${a.src})`, k }); marks.push({ f: t.meshBridge, lo: tl.meshBridge, hi: th.meshBridge, t: `pont ${a.id}`, k, dash: true }); } });
      marks.filter((m) => m.f >= F0 && m.f <= F1).forEach((m, j) => {
        g.fillStyle = acc2; g.globalAlpha = 0.12; g.fillRect(x(m.lo), top.y0 + 6, x(m.hi) - x(m.lo), top.y1 - top.y0 - 6); g.globalAlpha = 1;
        g.strokeStyle = acc2; g.setLineDash(m.dash ? [2, 4] : [6, 3]); g.beginPath(); g.moveTo(x(m.f), top.y0 - 8 + (j % 3) * 12); g.lineTo(x(m.f), top.y1); g.stroke(); g.setLineDash([]);
        g.fillStyle = acc2; g.textAlign = "center"; g.fillText(m.t, Math.min(R - 60, Math.max(L + 50, x(m.f))), top.y0 - 12 + (j % 3) * 12);
      });
    } catch (e) { /* repères facultatifs */ }
    // différence
    if (sp.diff) {
      const dmax = Math.max(6, ...sp.diff.slice(iOf(F0), iOf(F1)).filter(Number.isFinite)), dmin = Math.min(-3, ...sp.diff.slice(iOf(F0), iOf(F1)).filter(Number.isFinite));
      const yd = (v) => bot.y1 - ((v - dmin) / (dmax - dmin)) * (bot.y1 - bot.y0);
      g.strokeStyle = bd; g.beginPath(); g.moveTo(L, yd(0)); g.lineTo(R, yd(0)); g.stroke();
      g.fillStyle = acc2; g.globalAlpha = 0.55;
      for (let i = iOf(F0); i <= iOf(F1); i++) { const v = sp.diff[i]; if (!Number.isFinite(v)) continue; const px = x(i * STEP), w = Math.max(1, x(STEP) - x(0)); g.fillRect(px - w / 2, Math.min(yd(0), yd(v)), w, Math.abs(yd(v) - yd(0))); }
      g.globalAlpha = 1; g.fillStyle = txt; g.textAlign = "left"; g.fillText("traction − érre (dB)", L + 4, bot.y0 - 4);
      if (sp.peak) { g.fillStyle = acc2; g.textAlign = "center"; g.fillText(`+${fmt(sp.peak.d, 1)} dB @ ${fmt(sp.peak.f)} Hz`, Math.min(R - 60, Math.max(L + 60, x(sp.peak.f))), yd(sp.peak.d) - 5); }
    } else { g.fillStyle = mut; g.textAlign = "left"; g.fillText("Pas de spectre érre à cette vitesse : différence impossible.", L + 4, bot.y0 + 20); }
    { let bi = -1, bv = -Infinity; const A = TR || ER; for (let i = iOf(BAND[0]); i <= iOf(BAND[1]); i++) if (Number.isFinite(A[i]) && A[i] > bv) { bv = A[i]; bi = i; } if (bi >= 0) {
      const edge = bi === iOf(BAND[1]) || bi === iOf(BAND[0]);
      let gi = bi, gv = bv; if (edge) for (let i = iOf(BAND[0] - 100); i <= iOf(BAND[1] + 150); i++) if (Number.isFinite(A[i]) && A[i] > gv) { gv = A[i]; gi = i; }
      g.fillStyle = acc; g.beginPath(); g.arc(x(bi * STEP), y(bv), 4, 0, 6.3); g.fill(); g.textAlign = "center";
      if (edge && gi !== bi) {
        g.strokeStyle = acc; g.lineWidth = 2; g.beginPath(); g.arc(x(gi * STEP), y(gv), 5, 0, 6.3); g.stroke(); g.lineWidth = 1;
        g.fillText(`pic réel : ${fmt(gi * STEP)} Hz`, Math.min(R - 60, Math.max(L + 60, x(gi * STEP) + 38)), y(gv) - 8);
        g.fillText(`plus fort dans la bande : ${fmt(bi * STEP)} Hz (bord de la bande)`, Math.min(R - 130, Math.max(L + 130, x(bi * STEP))), y(bv) + 16);
      } else g.fillText(`plus fort dans la bande : ${fmt(bi * STEP)} Hz`, Math.min(R - 90, Math.max(L + 90, x(bi * STEP))), y(bv) + 16);
    } }
    // légende
    g.textAlign = "left"; let lx = L + 6; [[acc, `Traction (${sp.nT} lignes)`], [ok, `Érre (${sp.nE} lignes)`]].forEach(([c, t]) => { g.fillStyle = c; g.fillRect(lx, top.y1 - 14, 14, 3); g.fillStyle = txt; g.fillText(t, lx + 18, top.y1 - 9); lx += 150; });
  }

  function drawOrder(cv, res, W) {
    const o = res.order, H = 330, g = setup(cv, W, H);
    const txt = css("--text", "#3C3732"), mut = css("--muted", "#747678"), acc = css("--accent", "#CD0037"), acc2 = css("--accent2", "#6E1E78"), ok = css("--ok", "#009AA6"), bd = css("--border", "#D7D7D7");
    g.font = "12px Segoe UI, Arial, sans-serif";
    if (!o) { g.fillStyle = mut; g.fillText("Pas assez de lignes en traction au-dessus de 100 km/h.", 10, 24); return; }
    const L = 56, R = W - 10, x = (k) => L + ((k - K0) / (K1 - K0)) * (R - L), top = { y0: 52, y1: 232 }, bot = { y0: 258, y1: 310 };
    const base = median(o.tr), sh = (a) => (a ? a.map((v) => v - base) : a), TRo = sh(o.tr), ERo = sh(o.er);
    let lo = Infinity, hi = -Infinity; [TRo, ERo].filter(Boolean).forEach((a) => a.forEach((v) => { if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
    lo = Math.floor(lo / 5) * 5 - 2; hi = Math.ceil(hi / 5) * 5 + 2;
    const y = (v) => top.y1 - ((v - lo) / (hi - lo)) * (top.y1 - top.y0);
    g.strokeStyle = bd; g.fillStyle = mut; g.textAlign = "right";
    for (let v = Math.ceil(lo / 10) * 10; v <= hi; v += 10) { g.beginPath(); g.moveTo(L, y(v)); g.lineTo(R, y(v)); g.stroke(); g.fillText((v > 0 ? "+" : "") + v, L - 4, y(v) + 4); }
    g.save(); g.translate(11, (top.y0 + top.y1) / 2); g.rotate(-Math.PI / 2); g.textAlign = "center"; g.fillText("dB au-dessus du fond  (haut = plus fort)", 0, 0); g.restore(); g.textAlign = "right";
    g.textAlign = "center"; for (let k = 4.5; k <= 7.01; k += 0.5) g.fillText(fmt(k, 1), x(k), bot.y1 + 16);
    g.textAlign = "left"; g.fillText("Hz par km/h (f / v)", R - 120, bot.y1 + 30);
    const line = (a, col, wd) => { g.beginPath(); let st = false; a.forEach((v, j) => { if (!Number.isFinite(v)) return; const px = x(o.ks[j]), py = y(v); st ? g.lineTo(px, py) : (g.moveTo(px, py), st = true); }); g.strokeStyle = col; g.lineWidth = wd; g.stroke(); g.lineWidth = 1; };
    if (ERo) line(ERo, ok, 1.4); line(TRo, acc, 1.8);
    // repères : engrènement du réducteur et du pont, à partir de chaque diamètre
    const peaks = [];
    try {
      const marks = [];
      markAxles().forEach((a) => { const t = transmissionFrequencies(100, a.d); if (t) { marks.push({ k: t.meshReducer / 100, t: `réd. ${a.id} Ø${fmt(a.d)}`, c: acc2 }); marks.push({ k: t.meshBridge / 100, t: `pont ${a.id} Ø${fmt(a.d)}`, c: acc2, dash: true }); } });
      marks.filter((m) => m.k >= K0 && m.k <= K1).sort((p, q) => p.k - q.k).forEach((m, j) => {
        g.strokeStyle = m.c; g.setLineDash(m.dash ? [2, 4] : [6, 3]); g.beginPath(); g.moveTo(x(m.k), top.y0 - 14 + (j % 3) * 12); g.lineTo(x(m.k), bot.y1); g.stroke(); g.setLineDash([]);
        g.fillStyle = m.c; g.textAlign = "center"; g.fillText(m.t, Math.min(R - 55, Math.max(L + 55, x(m.k))), top.y0 - 18 + (j % 3) * 12);
        // niveau mesuré au repère (±1 %)
        const arr = o.diff || o.tr; let b = -Infinity; o.ks.forEach((k, i) => { if (Math.abs(k - m.k) <= 0.012 * m.k && Number.isFinite(arr[i]) && arr[i] > b) b = arr[i]; });
        if (Number.isFinite(b)) peaks.push({ t: m.t, d: b, dash: m.dash });
      });
    } catch (e) { /* repères facultatifs */ }
    if (o.diff) {
      const vals = o.diff.filter(Number.isFinite), dmax = Math.max(6, ...vals), dmin = Math.min(-3, ...vals), yd = (v) => bot.y1 - ((v - dmin) / (dmax - dmin)) * (bot.y1 - bot.y0);
      g.strokeStyle = bd; g.beginPath(); g.moveTo(L, yd(0)); g.lineTo(R, yd(0)); g.stroke();
      g.fillStyle = acc2; g.globalAlpha = 0.55; const w = Math.max(1, x(K0 + KS) - x(K0));
      o.diff.forEach((v, j) => { if (Number.isFinite(v)) g.fillRect(x(o.ks[j]) - w / 2, Math.min(yd(0), yd(v)), w, Math.abs(yd(v) - yd(0))); });
      g.globalAlpha = 1; g.fillStyle = txt; g.textAlign = "left"; g.fillText("traction − érre (dB)", L + 4, bot.y0 - 4);
    }
    g.textAlign = "left"; let lx = L + 6; [[acc, `Traction ≥ ${o.vmin} km/h (${o.nT} lignes)`], [ok, `Érre (${o.nE} lignes)`]].forEach(([c, t]) => { if (c === ok && !o.er) return; g.fillStyle = c; g.fillRect(lx, top.y1 - 14, 14, 3); g.fillStyle = txt; g.fillText(t, lx + 18, top.y1 - 9); lx += 230; });
    res.orderMarks = peaks;
  }

  /* ---------- rendu ---------- */
  let last = null, canv = {}, lastSig = "";
  function render(rows, el) {
    if (!el) return null;
    const live = typeof acqRunning !== "undefined" && acqRunning;
    if (live) { el.innerHTML = "<h4>Enquête</h4><p><i>Verdict et graphiques calculés à l’arrêt de l’acquisition.</i></p>"; last = null; return null; }
    const dom = window.DominanteTGV && window.DominanteTGV.last;
    const res = compute(rows), sus = suspects(dom), rel = reliability(res, sus), ver = verdict(res, sus, rel);
    last = { res, sus, ver, rel };
    try { const sg = JSON.stringify(((res.attr && res.attr.Traction && res.attr.Traction.items) || []).slice(0, 3).map((it) => [it.o.short, Math.round(100 * it.share)])); if (sg !== lastSig) { lastSig = sg; setTimeout(() => { try { window.DiagnosticTGV && window.DiagnosticTGV.refresh && window.DiagnosticTGV.refresh(); } catch (e) { /* ignore */ } }, 0); } } catch (e) { /* ignore */ }
    const W = Math.max(300, Math.min(1000, (el.clientWidth || 700) - 20));
    let html = '<h4>Analyse : quel bruit, à quelle vitesse, quel organe correspond ?</h4>';
    html += `<div class="enq-verdict"><div class="enq-head">${ver.head}</div><ul>${ver.lines.map((l) => `<li>${l}</li>`).join("")}</ul></div>`;
    {
      const col = ["#CD0037", "#FFB612", "#82BE00"], ico = ["✖", "▲", "✔"], lab = ["insuffisant", "limite", "solide"];
      html += `<div class="enq-rel"><div class="enq-rel-head"><span class="enq-badge" style="background:${col[rel.lv]}">Fiabilité de l’analyse : ${esc(rel.level)}</span> <span class="small">${rel.crit.filter((c) => c.pts === 2).length} critère(s) solide(s) sur ${rel.crit.length}</span></div>`;
      html += '<table border="1" cellspacing="0" cellpadding="4" class="enq-attr"><tr><th>Critère</th><th>Constat</th><th>État</th></tr>' + rel.crit.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.detail)}</td><td style="white-space:nowrap"><b style="color:${c.pts === 1 ? "#8a6100" : col[c.pts]}">${ico[c.pts]}</b> ${lab[c.pts]}</td></tr>`).join("") + "</table>";
      if (rel.need.length) html += `<p class="small"><b>Pour fiabiliser l’analyse (données manquantes) :</b></p><ul class="small">${rel.need.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
      html += `<p class="small"><b>Désignation de l’essieu :</b> ${esc(rel.desig.txt)}</p></div>`;
    }
    if (sus.length) {
      html += '<div class="enq-sus">' + sus.map((s, i) => `<div class="enq-row"><div class="enq-name">${i === 0 ? "★ " : ""}${esc(s.name)}</div><div class="enq-bar"><i style="width:${s.score}%"></i><b>${s.score}</b></div><div class="enq-why">${s.why.join(" · ")}</div></div>`).join("") + "</div>";
      html += '<p class="small"><i>L’indice de concordance (0–100) classe les sources ; ce n’est ni une probabilité ni un constat de défaut. Il additionne : part des lignes bruyantes expliquée en traction (30), passage dans 1500–1700 Hz (30), dépendance à la charge (15), diamètre cohérent avec un essieu (15), poids énergétique (10).</i></p>';
    }
    const at0 = res.attr && res.attr.Traction;
    if (at0 && at0.n >= 20) {
      const rowsA = at0.items.map((it) => { const e = res.attr.Erre, x = e && e.items.find((y) => y.o === undefined ? false : y.o.kind === it.o.kind && y.o.mult === it.o.mult && y.o.axle.id === it.o.axle.id); return `<tr><td>${esc(it.o.label)}</td><td>${fmt(100 * it.share)} %</td><td>${fmt(it.vLo)}–${fmt(it.vHi)} km/h</td><td>+${fmt(it.em, 1)} dB</td><td>${e && e.n >= 20 ? fmt(100 * (x ? x.share : 0)) + " %" : "n/d"}</td></tr>`; }).join("");
      html += `<h5>Organes dont la fréquence correspond au bruit de 1500–1700 Hz (lignes ≥ +${EM_LOUD} dB, traction : ${at0.n})</h5><table border="1" cellspacing="0" cellpadding="4" class="enq-attr"><tr><th>Organe dont la fréquence coïncide</th><th>Part (traction)</th><th>Vitesses</th><th>Émergence</th><th>Part en érre</th></tr>${rowsA}<tr><td><i>Non rattachées à un organe connu</i></td><td>${fmt(100 * at0.unShare)} %</td><td>${at0.unV ? fmt(at0.unV[0]) + "–" + fmt(at0.unV[1]) + " km/h" : "—"}</td><td></td><td></td></tr></table><p class="small"><i>Une ligne est attribuée à un organe si la fréquence de son pic est à ±1,2 % de f = k × vitesse. Une part forte en traction et faible en érre désigne la source qui dépend de la charge.</i></p>`;
    }
    if (res.n >= 30) {
      html += '<h5>Carte de gêne : où et quand ça émerge</h5><canvas id="enqHeat"></canvas><h5>Ce que la charge ajoute (spectre à la vitesse où le bruit gênant est le plus fréquent)</h5><canvas id="enqFft"></canvas><p class="small"><i>Les repères violets sont calculés à la <b>vitesse moyenne réelle des lignes</b> de la fenêtre, et la zone ombrée couvre leur étendue de vitesse (90 % des lignes). Les bandes violettes montrent où tombe chaque engrènement sur la plage de vitesse moyennée : une fréquence qui suit la vitesse s’étale sur toute la bande, donc ne forme pas un pic fin ici.</i></p><h5>Spectre par ordre : le réducteur doit tomber sur son repère</h5><canvas id="enqOrd"></canvas><p class="small"><i>Axe = fréquence ÷ vitesse (Hz par km/h). Toutes les vitesses sont superposées : une fréquence d’engrènement forme un pic fin, au repère de son essieu (5,81 × 900 ÷ Ø). Un pic décalé donne le diamètre réel ; une composante à fréquence fixe, elle, s’étale.</i></p>';
    }
    html += '<style>.enq-rel{margin:8px 0 12px;padding:8px 12px;border:1px solid var(--border,#D7D7D7);border-radius:8px;background:#fff}.enq-rel-head{margin-bottom:6px}.enq-badge{display:inline-block;padding:3px 12px;border-radius:999px;color:#fff;font-weight:700;font-size:14px}.enq-rel ul{margin:2px 0 6px 18px;padding:0}.enq-verdict{border-left:5px solid var(--accent,#CD0037);padding:6px 12px;margin:6px 0 10px;background:rgba(110,30,120,.07);border-radius:6px}.enq-head{font-size:15px;margin-bottom:4px}.enq-verdict ul{margin:4px 0 2px 18px;padding:0}.enq-row{display:grid;grid-template-columns:minmax(0,1.3fr) 140px;gap:4px 10px;margin:6px 0;align-items:center}.enq-bar{position:relative;height:16px;border:1px solid var(--border,#D7D7D7);border-radius:8px;overflow:hidden}.enq-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent2,#6E1E78),var(--accent,#CD0037))}.enq-bar b{position:absolute;right:10px;top:-1px;font-size:12px;color:var(--text,#3C3732)}.enq-why{grid-column:1/3;font-size:12px;color:var(--muted,#747678)}.enq-name{font-weight:600}.enq-attr{border-collapse:collapse;font-size:13px;width:100%}.enq-attr th{background:rgba(110,30,120,.12);text-align:left}</style>';
    el.innerHTML = html;
    if (res.n >= 30) {
      canv = { heat: el.querySelector("#enqHeat"), fft: el.querySelector("#enqFft"), ord: el.querySelector("#enqOrd") };
      try { drawHeat(canv.heat, res, W); drawFft(canv.fft, res, W); drawOrder(canv.ord, res, W); } catch (e) { console.warn("Enquête graphiques", e); }
    }
    return last;
  }
  function reportParts() {
    if (!last) return null;
    const strip = (s) => String(s).replace(/<[^>]+>/g, "");
    const imgs = [];
    try { if (canv.heat) imgs.push(["Carte de gêne", canv.heat.toDataURL("image/png")]); if (canv.fft) imgs.push(["Spectre traction / érre", canv.fft.toDataURL("image/png")]); if (canv.ord) imgs.push(["Spectre par ordre (Hz par km/h)", canv.ord.toDataURL("image/png")]); } catch (e) { /* images facultatives */ }
    const at = last.res.attr && last.res.attr.Traction; const attr = at && at.n >= 20 ? at.items.map((it) => [it.o.label, fmt(100 * it.share) + " %", fmt(it.vLo) + "–" + fmt(it.vHi) + " km/h"]).concat([["Non attribuées", fmt(100 * at.unShare) + " %", at.unV ? fmt(at.unV[0]) + "–" + fmt(at.unV[1]) + " km/h" : "—"]]) : [];
    const rel = last.rel ? { level: last.rel.level, crit: last.rel.crit.map((c) => [c.name, c.detail, ["insuffisant", "limite", "solide"][c.pts]]), need: last.rel.need, desig: last.rel.desig.txt } : null;
    return { rel, attr, head: strip(last.ver.head), lines: last.ver.lines.map(strip), suspects: last.sus.map((s) => [s.name, s.score, s.why.map(strip).join(" ; ")]), imgs };
  }
  const api = { render, compute, suspects, reliability, rowEm, reportParts, shareForDiameter, get last() { return last; } };
  window.EnqueteTGV = api;
  if (typeof module !== "undefined") module.exports = api;
  window.addEventListener("resize", () => { try { const el = document.getElementById("enquetePanel"); if (last && el && el.offsetParent) { const r = last.res; const W = Math.max(300, Math.min(1000, (el.clientWidth || 700) - 20)); if (canv.heat && canv.fft) { drawHeat(canv.heat, r, W); drawFft(canv.fft, r, W); if (canv.ord) drawOrder(canv.ord, r, W); } } } catch (e) { /* ignore */ } });
})();
