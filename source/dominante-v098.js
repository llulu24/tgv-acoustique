/* Analyse Acoustique TGV — v0.9.8
 * Fréquences dominantes : quelles fréquences reviennent le plus, à quelle vitesse, dans quel
 * régime, et quel organe leur correspond.
 * Lit les lignes du diagramme de Campbell (window.CampbellTGV._state.rows) : chaque ligne
 * porte la vitesse, le régime et le spectre sur une grille de 5 Hz (0–2 500 Hz).
 */
"use strict";
/* MÉTHODE — FRÉQUENCES DOMINANTES
 * Objectif : répondre à « quelle fréquence domine, à quelle vitesse, et d'où vient-elle ? »
 * sur tout le trajet, pas seulement dans la bande gênante 1 500–1 700 Hz.
 *   1. PICS : dans chaque ligne (spectre de 0,5 s), on garde jusqu'à 3 pics émergents entre
 *      100 et 2 500 Hz. L'émergence = niveau du pic − médiane du voisinage (±60 Hz) ; seuil 8 dB.
 *      La fréquence est affinée par interpolation parabolique.
 *   2. FAMILLES : on cherche les fréquences qui se répètent, de deux sortes :
 *        - PROPORTIONNELLE à la vitesse (f = k × v) : signature d'un organe tournant ;
 *          on repère le rapport k = f / v le plus fréquent (tolérance ±3 %) ;
 *        - FIXE (f constante quelle que soit la vitesse) : électrique, auxiliaire, résonance.
 *      La famille qui totalise le plus d'émergence est la « dominante » ; ses points sont
 *      retirés et on cherche la suivante (4 au plus).
 *   3. VITESSE : plage où la fréquence apparaît (10 %–90 % des points) et vitesse du maximum.
 *   4. RÉGIMES : part des lignes de chaque régime, dans la même plage de vitesse, où la fréquence
 *      est présente. Présente en traction/freinage et pas en érre = liée à la charge.
 *   5. CAUSE : pour une fréquence proportionnelle, on calcule le diamètre de roue qu'il faudrait
 *      pour que chaque organe de la chaîne (engrènement réducteur, pont, harmoniques,
 *      rotation moteur / essieu) produise k × v. Un organe n'est retenu que si ce diamètre
 *      est physiquement possible (850–924 mm : roue usée à neuve).
 *      Pour une fréquence fixe, la cause est déduite du régime où elle est présente. */

(() => {
  const GRID_STEP = 5, GRID_N = 501, F_MIN = 100, F_MAX = 2500;
  const EM_MIN = 8;          // émergence minimale d'un pic (dB)
  const V_MIN = 15;          // vitesse minimale d'une ligne exploitable (km/h)
  const SPAN_MIN = 25;       // étendue de vitesse minimale pour distinguer fixe / proportionnelle
  const MAX_FAMILIES = 4;
  const LOG_BIN = 0.015, RATIO_TOL = 0.03, F_TOL = 10;
  const BAND = [1500, 1700];
  const REGS = ["Traction", "Erre", "Freinage"];
  const REG_LABEL = { Traction: "Traction", Erre: "Érre", Freinage: "Freinage" };

  const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d).replace(".", ",") : "—");
  const esc = (t) => (typeof escapeHtml === "function" ? escapeHtml(String(t)) : String(t).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";"));
  const sorted = (a) => a.filter(Number.isFinite).slice().sort((x, y) => x - y);
  const quant = (a, q) => { const s = sorted(a); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };
  const median = (a) => quant(a, 0.5);
  const wheelMin = () => (typeof TRANS_DEFAULTS !== "undefined" ? TRANS_DEFAULTS.wheelMin : 850);
  const wheelMax = () => (typeof TRANS_DEFAULTS !== "undefined" ? TRANS_DEFAULTS.wheelMax : 924);

  /* ---------- 1. pics d'une ligne ---------- */
  function rowPeaks(spec) {
    const found = [], tmp = [];
    const i0 = Math.max(F_MIN / GRID_STEP, 14), i1 = Math.min(F_MAX / GRID_STEP, GRID_N - 15);
    for (let i = i0; i <= i1; i++) {
      const v = spec[i];
      if (!(v > -140) || !(v > spec[i - 1] && v >= spec[i + 1] && v > spec[i - 2] && v >= spec[i + 2])) continue;
      // pré-filtre sans tri : la médiane du voisinage ne peut être ≥ 8 dB sous le pic que si
      // au moins la moitié (+1) des cases voisines le sont (évite 95 % des tris)
      let below = 0, nb = 0;
      for (let j = i - 12; j <= i + 12; j++) if (Math.abs(j - i) > 3) { nb++; if (spec[j] <= v - EM_MIN) below++; }
      if (below < (nb >> 1) + 1) continue;
      tmp.length = 0;
      for (let j = i - 12; j <= i + 12; j++) if (Math.abs(j - i) > 3) tmp.push(spec[j]);
      tmp.sort((a, b) => a - b);
      const em = v - tmp[tmp.length >> 1];
      if (em < EM_MIN) continue;
      const l = spec[i - 1], r = spec[i + 1], den = l - 2 * v + r;
      const d = Math.abs(den) > 1e-9 ? Math.max(-1, Math.min(1, (0.5 * (l - r)) / den)) : 0;
      found.push({ f: (i + d) * GRID_STEP, db: v - 0.25 * (l - r) * d, em });
    }
    found.sort((a, b) => b.em - a.em);
    const out = [];
    for (const p of found) { if (out.every((q) => Math.abs(q.f - p.f) >= 20)) out.push(p); if (out.length >= 3) break; }
    return out;
  }

  /* ---------- 2. familles ---------- */
  function bestWindow(hist, half) {
    let bestB = null, bestS = 0;
    for (const b of hist.keys()) {
      let s = 0;
      for (let d = -half; d <= half; d++) s += hist.get(b + d) || 0;
      if (s > bestS) { bestS = s; bestB = b; }
    }
    return bestB;
  }
  const weight = (pts) => pts.reduce((s, p) => s + p.w, 0);
  const rowsOf = (pts) => new Set(pts.map((p) => p.row)).size;
  const spanOf = (pts) => { const v = pts.map((p) => p.v); return quant(v, 0.9) - quant(v, 0.1); };

  function findFamilies(points, nRows) {
    const out = [];
    let pts = points.slice();
    for (let it = 0; it < MAX_FAMILIES; it++) {
      if (pts.length < 8) break;
      // proportionnelle : rapport f / v le plus fréquent
      const hp = new Map();
      pts.forEach((p) => { const b = Math.round(Math.log(p.f / p.v) / LOG_BIN); hp.set(b, (hp.get(b) || 0) + p.w); });
      const bP = bestWindow(hp, 2);
      let k0 = Math.exp(bP * LOG_BIN), mp = pts.filter((p) => Math.abs(Math.log(p.f / p.v / k0)) <= RATIO_TOL);
      if (mp.length) { k0 = median(mp.map((p) => p.f / p.v)); mp = pts.filter((p) => Math.abs(Math.log(p.f / p.v / k0)) <= RATIO_TOL); }
      // fixe : fréquence la plus fréquente
      const hf = new Map();
      pts.forEach((p) => { const b = Math.round(p.f / GRID_STEP); hf.set(b, (hf.get(b) || 0) + p.w); });
      const bF = bestWindow(hf, 2);
      let f0 = bF * GRID_STEP, mf = pts.filter((p) => Math.abs(p.f - f0) <= F_TOL);
      if (mf.length) { f0 = median(mf.map((p) => p.f)); mf = pts.filter((p) => Math.abs(p.f - f0) <= F_TOL); }

      const fixedWins = weight(mf) >= weight(mp);
      const mem = fixedWins ? mf : mp;
      if (rowsOf(mem) < Math.max(8, 0.015 * nRows)) break;
      const span = spanOf(mem);
      const type = span < SPAN_MIN ? "etroite" : fixedWins ? "fixe" : "proportionnelle";
      out.push({ type, members: mem, score: weight(mem), k: fixedWins ? null : k0, f0: fixedWins ? f0 : null });
      const gone = new Set(mem);
      pts = pts.filter((p) => !gone.has(p));
    }
    return out;
  }

  /* ---------- 3-5. description d'une famille ---------- */
  function organList() {
    const f100 = transmissionFrequencies(100, 900);
    const mk = (key, mult, label) => ({ label, slope: (f100[key] * mult) / 100 });
    return [
      mk("meshReducer", 1, "engrènement du réducteur (pignon moteur 27 dents)"),
      mk("meshReducer", 2, "harmonique 2 de l’engrènement du réducteur"),
      mk("meshBridge", 1, "engrènement du pont (roue 51 dents)"),
      mk("meshBridge", 2, "harmonique 2 de l’engrènement du pont"),
      mk("motor", 1, "rotation du moteur"),
      mk("reducerIntermediate", 1, "rotation de la roue intermédiaire (41 dents)"),
      mk("axle", 1, "rotation d’essieu"),
    ];
  }
  function matchOrgans(k) {
    const lo = wheelMin() * 0.985, hi = wheelMax() * 1.015, res = [];
    organList().forEach((o) => {
      const dEq = (900 * o.slope) / k;
      if (dEq >= lo && dEq <= hi) res.push({ label: o.label, dEq });
    });
    return res;
  }
  /* Diamètres E1 / E2 calculés à partir du sifflement (diametres-v097.js), s'ils existent. */
  function calcAxles() {
    try {
      const D = window.DiametresTGV, r = D && D.state && D.state.result;
      if (!r || !r.found || !r.found.length || r.n < 60) return null;
      const f = r.found, mk = (id, x) => ({ id, d: x.d, pm: x.stat });
      const ap = D.state.applied;
      return { axles: f.length > 1 ? [mk("E1", f[0]), mk("E2", f[1])] : [mk("E1/E2", f[0])], n: r.n, source: r.source,
        rel: (ap && ap.reliability) || (r.n >= 120 ? "fiable" : "indicatif") };
    } catch (e) { return null; }
  }
  const axTxt = (a) => `${a.id} Ø${fmt(a.d)}${a.pm ? " ± " + fmt(Math.max(a.pm, 1)) : ""} mm`;
  function calcNote() {
    const c = calcAxles();
    if (!c) return "Diamètres de roue : <b>non calculés</b> (valeurs de réglage). Ils se calculent à l’analyse du sifflement avec le CSV/JSON de vitesse, ou en acquisition (traction &gt; 150 km/h, 60 s minimum).";
    return `Diamètres calculés à partir du sifflement (${c.source === "direct" ? "acquisition en direct" : "fichier"}, ${c.n} s, ${esc(c.rel)}) : <b>${c.axles.map(axTxt).join(" ; ")}</b>.`;
  }
  function axleHint(dEq) {
    const c = calcAxles();
    if (c) {
      const best = c.axles.map((a) => ({ a, d: Math.abs(a.d - dEq) })).sort((x, y) => x.d - y.d)[0];
      const tol = Math.max(5, 0.015 * best.a.d);
      return best.d <= tol
        ? ` — <b>cohérent avec ${esc(axTxt(best.a))} (calculé)</b>`
        : ` — ne correspond à aucun diamètre calculé (${c.axles.map(axTxt).join(", ")})`;
    }
    try {
      const axles = getTransmissionConfig().axles;
      const best = axles.map((a) => ({ a, d: Math.abs(a.diameter - dEq) })).sort((x, y) => x.d - y.d)[0];
      return best && best.d <= 15 ? ` (essieu le plus proche : ${best.a.id}, Ø${fmt(best.a.diameter)} mm, valeur de réglage)` : "";
    } catch (e) { return ""; }
  }

  function describe(fam, usable) {
    const m = fam.members, v = m.map((p) => p.v), f = m.map((p) => p.f), db = m.map((p) => p.db);
    const vLo = quant(v, 0.1), vHi = quant(v, 0.9);
    const dbTop = quant(db, 0.9);
    const top = m.filter((p) => p.db >= dbTop);
    const vMax = median(top.map((p) => p.v)), fAtMax = median(top.map((p) => p.f));
    const present = new Set(m.map((p) => p.row));
    const pct = {};
    REGS.forEach((r) => {
      const inRange = usable.map((u, i) => ({ u, i })).filter((x) => x.u.regime === r && x.u.speed >= vLo - 5 && x.u.speed <= vHi + 5);
      pct[r] = inRange.length >= 10 ? inRange.filter((x) => present.has(x.i)).length / inRange.length : null;
    });
    const loaded = Math.max(pct.Traction ?? -1, pct.Freinage ?? -1);
    let load = null;
    if (pct.Erre != null && loaded >= 0) load = loaded >= 2 * pct.Erre + 0.1 ? "charge" : pct.Erre >= 2 * loaded + 0.1 ? "erre" : "indep";

    const d = { type: fam.type, score: fam.score, nPoints: m.length, nRows: present.size, fMed: median(f), fLo: quant(f, 0.1), fHi: quant(f, 0.9), vLo, vHi, vMax, fAtMax, dbMed: median(db), pct, load, k: null, organs: [], cause: [], bandCross: null };
    const rangeTxt = `${fmt(vLo)}–${fmt(vHi)} km/h`;

    if (fam.type === "proportionnelle" || fam.type === "etroite") {
      const k = fam.type === "proportionnelle" ? fam.k : median(m.map((p) => p.f / p.v));
      d.k = k;
      d.organs = matchOrgans(k);
      if (d.organs.length) {
        const txt = d.organs.map((o) => `<b>${esc(o.label)}</b> — diamètre de roue équivalent ${fmt(o.dEq)} mm${axleHint(o.dEq)}`).join(" ; ou ");
        d.cause.push(fam.type === "proportionnelle"
          ? `La fréquence suit la vitesse (${fmt(k, 2)} Hz par km/h) et correspond à ${txt}.`
          : `Vitesse quasi constante (${rangeTxt}) : on ne peut pas établir si la fréquence suit la vitesse. Correspondance éventuelle : ${txt}.`);
        if (d.organs.length > 1) d.cause.push("Plusieurs organes correspondent à cette fréquence par km/h : une variation de vitesse plus large permettrait de les distinguer.");
        if (BAND[0] / k <= 330) {
          d.bandCross = [BAND[0] / k, BAND[1] / k];
          d.cause.push(`Traverse la bande gênante ${BAND[0]}–${BAND[1]} Hz entre <b>${fmt(d.bandCross[0])} et ${fmt(d.bandCross[1])} km/h</b>${d.bandCross[0] > vHi ? " (au-delà de la plage mesurée)" : ""}.`);
        }
      } else {
        d.cause.push(fam.type === "proportionnelle"
          ? `La fréquence suit la vitesse (${fmt(k, 2)} Hz par km/h) mais aucun organe de la chaîne de transmission ne lui correspond pour une roue de ${fmt(wheelMin())}–${fmt(wheelMax())} mm.`
          : `Vitesse quasi constante (${rangeTxt}) et aucun organe de la chaîne de transmission ne correspond à cette fréquence à cette vitesse.`);
      }
    } else { // fixe
      const f0 = fam.f0;
      if (Math.abs(f0 - 1875) <= 15) d.cause.push("<b>Bip VACMA</b> (1 875 Hz, intermittent) : écarté de l’analyse.");
      else {
        d.cause.push(`Fréquence fixe (~${fmt(f0)} Hz) alors que la vitesse varie de ${fmt(vLo)} à ${fmt(vHi)} km/h : indépendante de la vitesse, elle ne correspond à aucun engrènement.`);
        if (d.load === "charge") d.cause.push("Présente en traction/freinage, absente en érre.");
        else if (d.load === "indep") d.cause.push("Présente aussi en érre : indépendante de la charge.");
        else d.cause.push("Régimes insuffisamment renseignés : la dépendance à la charge n’est pas établie.");
        { const m50 = f0 / 50; if (Math.round(m50) >= 1 && Math.abs(m50 - Math.round(m50)) * 50 <= 3) d.cause.push(`Multiple de 50 Hz (${Math.round(m50)} × 50 Hz).`); }
        if (f0 >= BAND[0] && f0 <= BAND[1]) d.cause.push("Elle se situe dans la bande gênante 1 500–1 700 Hz.");
      }
    }
    if (d.load === "charge" && fam.type !== "fixe") d.cause.push("Liée à la charge : forte en traction/freinage, faible en érre.");
    else if (d.load === "indep" && fam.type !== "fixe") d.cause.push("Présente aussi en érre : peu dépendante de la charge.");
    return d;
  }

  /* ---------- analyse complète ---------- */
  function analyse(rows) {
    const usable = [];
    (rows || []).forEach((r) => { if (Number.isFinite(r.speed) && r.speed >= V_MIN && r.spec) usable.push({ speed: r.speed, regime: r.regime, spec: r.spec }); });
    const res = { nRows: usable.length, families: [] };
    if (usable.length < 40) return res;
    const points = [];
    usable.forEach((u, i) => rowPeaks(u.spec).forEach((p) => points.push({ v: u.speed, f: p.f, db: p.db, em: p.em, w: Math.min(p.em, 25), row: i })));
    findFamilies(points, usable.length).forEach((fam, i) => { const d = describe(fam, usable); d.rank = i + 1; res.families.push(d); });
    // deux fréquences du même organe avec des diamètres équivalents différents = deux essieux
    res.families.forEach((d, i) => res.families.slice(0, i).forEach((e) => {
      if (d.organs[0] && e.organs[0] && d.organs[0].label === e.organs[0].label && Math.abs(d.organs[0].dEq - e.organs[0].dEq) > 15)
        d.cause.push(`Même organe que la fréquence n°${e.rank}, avec un diamètre équivalent différent (${fmt(d.organs[0].dEq)} contre ${fmt(e.organs[0].dEq)} mm) : correspond à deux essieux E1 / E2 de diamètres différents.`);
    }));
    return res;
  }

  /* ---------- affichage ---------- */
  const regTxt = (pct) => REGS.map((r) => `${REG_LABEL[r]} ${pct[r] == null ? "n/d" : fmt(100 * pct[r]) + " %"}`).join(" · ");
  const freqTxt = (d) => (d.type === "fixe" ? `${fmt(d.fMed)} Hz (fixe)` : `${fmt(d.fLo)}–${fmt(d.fHi)} Hz${d.k ? ` (${fmt(d.k, 2)} Hz/km/h)` : ""}`);
  const speedTxt = (d) => `${fmt(d.vLo)}–${fmt(d.vHi)} km/h<br>maximum vers ${fmt(d.vMax)} km/h (${fmt(d.fAtMax)} Hz)`;
  function html(res) {
    if (!res.families.length)
      return `<p>Fréquences dominantes : ${res.nRows < 40 ? "pas assez de lignes avec vitesse (minimum 40 ; vitesse ≥ 15 km/h)." : "aucune fréquence ne se répète assez pour être retenue."}</p>`;
    const rows = res.families.map((d) => `<tr${d.rank === 1 ? ' class="dom-first"' : ""}><td>${d.rank === 1 ? "★ " : ""}${d.rank}</td><td>${freqTxt(d)}</td><td>${speedTxt(d)}</td><td>${regTxt(d.pct)}</td><td>${fmt(d.dbMed)} dB rel.</td><td>${d.cause.join("<br>")}</td></tr>`).join("");
    return `<style>.dom-table{border-collapse:collapse;width:100%;font-size:13px}.dom-table th,.dom-table td{border:1px solid #A0A0A0;padding:4px 6px;text-align:left;vertical-align:top}.dom-table th{background:#E1E1E1;color:#000}.dom-table tr.dom-first td{background:#F1E6F3;color:#000}</style>`
      + `<p class="small">${calcNote()}</p>`
      + `<table class="dom-table"><tr><th>#</th><th>Fréquence</th><th>Vitesse</th><th>Présence par régime</th><th>Niveau</th><th>Correspondance</th></tr>${rows}</table>`
      + `<p class="small"><i>${res.nRows} lignes exploitées. La ★ est la fréquence qui totalise le plus d’émergence. Niveaux relatifs non calibrés. Ces constats portent sur la fréquence mesurée ; ils n’établissent pas l’état d’un organe.</i></p>`;
  }
  function rowsForReport(res) {
    const strip = (s) => String(s).replace(/<br>/g, " ; ").replace(/<[^>]+>/g, "");
    return res.families.map((d) => [(d.rank === 1 ? "★ " : "") + d.rank, freqTxt(d), `${fmt(d.vLo)}–${fmt(d.vHi)} km/h (max ${fmt(d.vMax)})`, regTxt(d.pct), strip(d.cause.join(" "))]);
  }

  /* Pendant une acquisition on ne calcule rien : le diagnostic est réactualisé souvent et
   * l'analyse coûte ~0,2 s par heure d'enregistrement sur PC (plus d'1 s sur tablette), ce qui
   * ferait saccader la mesure. Le calcul se fait à l'arrêt (le Campbell se redessine alors). */
  let last = null, lastKey = "", ctx = null, tried = "";
  const sig = () => { const c = calcAxles(); return c ? c.axles.map((a) => Math.round(a.d)).join("/") : "-"; };
  /* Lance le calcul des diamètres E1 / E2 s'il n'existe pas encore et si le fichier audio et la
   * vitesse sont disponibles ; les causes sont ensuite recalculées avec ces diamètres. */
  function ensureDiameters() {
    try {
      const D = window.DiametresTGV;
      if (!D || D.state.busy || calcAxles()) return;
      const btn = document.getElementById("diamRun"), tr = window.AnalyseRaieTGV && window.AnalyseRaieTGV.state && window.AnalyseRaieTGV.state.speedTrack;
      if (!btn || btn.disabled || !tr || !tr.length) return;
      const k = tr.length + ":" + ((document.getElementById("toneRecord") || {}).value || "");
      if (k === tried) return; tried = k;
      D.run().then(() => { if (ctx && !(typeof acqRunning !== "undefined" && acqRunning)) render(ctx.rows, ctx.el); }).catch(() => {});
    } catch (e) { console.warn("Diamètres automatiques", e); }
  }
  function render(rows, el) {
    ctx = { rows, el };
    const n = rows ? rows.length : 0, key = n + ":" + (n ? rows[n - 1].t : 0) + "|" + sig();
    const live = typeof acqRunning !== "undefined" && acqRunning;
    if (live) {
      last = null; lastKey = "";
      if (el) el.innerHTML = "<h4>Fréquences dominantes : vitesse et organe correspondant</h4><p><i>Calculées à l’arrêt de l’acquisition, pour ne pas ralentir la mesure.</i></p>";
      try { window.EnqueteTGV && window.EnqueteTGV.render(rows, document.getElementById("enquetePanel")); } catch (e) { /* ignore */ }
      return null;
    }
    if (!last || key !== lastKey) { last = analyse(rows); lastKey = key; }
    if (el) el.innerHTML = "<h4>Fréquences dominantes : vitesse et organe correspondant</h4>" + html(last);
    try { window.EnqueteTGV && window.EnqueteTGV.render(rows, document.getElementById("enquetePanel")); } catch (e) { console.warn("Enquête", e); }
    ensureDiameters();
    return last;
  }
  if (typeof document !== "undefined") document.addEventListener("click", (e) => {
    if (!(e.target && e.target.closest && e.target.closest("#toneRun,#analyze"))) return;
    const t0 = setInterval(() => { const st = window.AnalyseRaieTGV && window.AnalyseRaieTGV.state; if (!st || !st.busy) { clearInterval(t0); tried = ""; setTimeout(ensureDiameters, 400); } }, 700);
    setTimeout(() => clearInterval(t0), 900000);
  });
  const api = { analyse, html, render, rowsForReport, calcNote, calcAxles, _rowPeaks: rowPeaks, get last() { return last; } };
  if (typeof window !== "undefined") window.DominanteTGV = api;
  if (typeof module !== "undefined") module.exports = api;
})();
