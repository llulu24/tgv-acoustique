/*
 * comparaison-v0912.js — Comparer deux accompagnements de la même rame (v1.7)
 *
 * Principe : chaque accompagnement est lu depuis son JSON (dans le ZIP ou seul). On n'a pas besoin
 * du fichier audio : le JSON contient les spectres du diagramme de Campbell (grille 5 Hz, 0,5 s).
 * Le bruit du réducteur est suivi sur sa fréquence théorique (5,2268 / diamètre × vitesse). Un instant
 * est « actif » quand ce bruit ressort nettement de son voisinage, quel que soit le régime marqué
 * (le marquage manuel traction / erre peut être oublié ou décalé).
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SLOPE_RED = 5.2268, SLOPE_PONT = 4.5093; // Hz par km/h pour un diamètre de 1 m
  const GRID = 5, GN = 501;
  const EM_ON = 12, EM_OFF = 7; // émergence (dB) : actif / inactif
  const BAND = [1500, 1700];
  const KS = []; for (let k = 2; k <= 14.0001; k += 0.02) KS.push(Math.round(k * 100) / 100);

  const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d).replace(".", ",") : "—");
  const sgn = (x, d = 1) => (Number.isFinite(x) ? (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d).replace(".", ",") : "—");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pw = (db) => Math.pow(10, db / 10);
  function median(a) {
    const v = a.filter(Number.isFinite).sort((x, y) => x - y);
    if (!v.length) return NaN;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  /* ---------- lecture du JSON (ZIP ou JSON seul), sans décompresser l'audio ---------- */
  async function readJson(file) {
    if (/\.json$/i.test(file.name)) return JSON.parse(await file.text());
    const tail = new DataView(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("ZIP invalide : " + file.name);
    const count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
    const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.getUint32(p, true) !== 0x02014b50) break;
      const method = cd.getUint16(p + 10, true), csize = cd.getUint32(p + 20, true);
      const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true), local = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!/\.json$/i.test(name) || /geojson/i.test(name)) continue;
      const lh = new DataView(await file.slice(local, local + 30).arrayBuffer());
      const start = local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const blob = file.slice(start, start + csize);
      if (method === 0) return JSON.parse(await blob.text());
      if (method === 8) {
        if (typeof DecompressionStream === "undefined") throw new Error("ZIP compressé non pris en charge par ce navigateur : fournir le fichier JSON seul.");
        const text = await new Response(blob.stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
        return JSON.parse(text);
      }
      throw new Error("Méthode de compression ZIP non prise en charge.");
    }
    throw new Error("Aucun fichier JSON dans " + file.name);
  }

  /* ---------- analyse d'un accompagnement ---------- */
  function diameterOf(obj) {
    const d = obj?.diametresTempsReel?.diametresMm;
    if (Array.isArray(d) && d.length) return d.reduce((a, b) => a + b, 0) / d.length;
    const t = obj?.transmission || {};
    const v = [Number(t.diameterEssieu1Mm), Number(t.diameterEssieu2Mm)].filter((x) => x > 500);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 897;
  }

  function track(rows, D) {
    const sl = SLOPE_RED / (D / 1000), out = [];
    let run = 0, prev = null;
    for (const r of rows) {
      if (r.regime !== prev) { run++; prev = r.regime; }
      const v = r.speed;
      if (!(v >= 150) || !r.spec) continue;
      const sp = r.spec, fm = sl * v;
      const g0 = Math.max(30, Math.round(0.975 * fm / GRID)), g1 = Math.min(GN - 30, Math.round(1.025 * fm / GRID));
      if (g1 <= g0) continue;
      let gp = g0, best = -1e9;
      for (let g = g0; g <= g1; g++) if (sp[g] > best) { best = sp[g]; gp = g; }
      const lev = 10 * Math.log10(pw(sp[gp - 1]) + pw(sp[gp]) + pw(sp[gp + 1]));
      const nb = [];
      for (let g = gp - 24; g <= gp - 6; g++) nb.push(sp[g]);
      for (let g = gp + 6; g <= gp + 24; g++) nb.push(sp[g]);
      const em = lev - (median(nb) + 4.77);
      out.push({ t: r.t, v, reg: r.regime, f: gp * GRID, lev, em, sp, run });
    }
    return out;
  }

  function stats(tr, lo, hi) {
    const sel = tr.filter((x) => x.v >= lo && x.v < hi);
    const on = sel.filter((x) => x.em >= EM_ON), off = sel.filter((x) => x.em < EM_OFF);
    return {
      n: sel.length,
      onShare: sel.length ? on.length / sel.length : NaN,
      levOn: median(on.map((x) => x.lev)), levOff: median(off.map((x) => x.lev)),
      emOn: median(on.map((x) => x.em)), fOn: median(on.map((x) => x.f)),
      inBand: on.length ? on.filter((x) => x.f >= BAND[0] && x.f <= BAND[1]).length / on.length : NaN,
    };
  }

  function orderSpec(group) {
    const acc = new Float64Array(KS.length), cnt = new Int32Array(KS.length);
    for (const x of group) {
      for (let i = 0; i < KS.length; i++) {
        const g = Math.round(KS[i] * x.v / GRID);
        if (g + 1 >= GN) break;
        acc[i] += pw(x.sp[g - 1]) + pw(x.sp[g]) + pw(x.sp[g + 1]);
        cnt[i]++;
      }
    }
    return Array.from(acc, (a, i) => (cnt[i] >= 20 ? 10 * Math.log10(a / cnt[i] / 3 + 1e-20) : NaN));
  }

  function orderPeaks(S) {
    const on = S.oOn, off = S.oOff, peaks = [];
    for (let i = 8; i < KS.length - 8; i++) {
      const v = on[i];
      if (!Number.isFinite(v)) continue;
      let isMax = true;
      for (let j = i - 6; j <= i + 6; j++) if (j !== i && Number.isFinite(on[j]) && on[j] > v) { isMax = false; break; }
      if (!isMax) continue;
      const nb = [];
      for (let j = Math.max(0, i - 25); j <= Math.min(KS.length - 1, i + 25); j++) if (Math.abs(j - i) > 8) nb.push(on[j]);
      const prom = v - median(nb), gap = v - off[i];
      if (prom >= 5 && gap >= 5) peaks.push({ k: KS[i], gap, prom });
    }
    return peaks;
  }

  function gapAt(S, k) {
    let best = NaN;
    for (let i = 0; i < KS.length; i++) {
      if (Math.abs(KS[i] - k) <= 0.04) {
        const g = S.oOn[i] - S.oOff[i];
        if (Number.isFinite(g) && (!Number.isFinite(best) || g > best)) best = g;
      }
    }
    return best;
  }

  function organOf(k, D) {
    const m = SLOPE_RED / (D / 1000), p = SLOPE_PONT / (D / 1000), near = (a) => Math.abs(k - a) / a < 0.02;
    if (near(m)) return "engrènement du réducteur";
    if (near(2 * m)) return "réducteur, harmonique 2";
    if (near(p)) return "engrènement du pont";
    if (near(2 * p)) return "pont, harmonique 2";
    return "non identifié";
  }

  function analyse(obj, fileName) {
    const rows = obj?.campbell?.rows;
    if (!Array.isArray(rows) || !rows.length) throw new Error(fileName + " : pas de données Campbell dans le JSON (acquisition v0.9.6 ou plus récente requise).");
    const D = diameterOf(obj), sl = SLOPE_RED / (D / 1000);
    const samples = obj.samples || [];
    const first = samples.find((s) => s.timestamp)?.timestamp || obj.exportedAt;
    const dts = []; for (let i = 1; i < Math.min(rows.length, 400); i++) dts.push(rows[i].t - rows[i - 1].t);
    const dt = median(dts) || 0.5;
    const sec = (pred) => rows.filter(pred).length * dt;
    const withSpeed = rows.filter((r) => r.speed != null && r.speed >= 20);
    const lo = BAND[0] / sl, hi = BAND[1] / sl;
    const sp250 = rows.filter((r) => r.speed >= 250).map((r) => r.speed);
    const tr = track(rows, D);
    const oOn = orderSpec(tr.filter((x) => x.v >= 230 && x.em >= EM_ON)), oOff = orderSpec(tr.filter((x) => x.v >= 230 && x.em < EM_OFF));
    // périodes marquées « erre » où le bruit est pourtant actif (traction oubliée dans le marquage)
    const runs = new Map();
    for (const x of tr) if (x.reg === "Erre" && x.v >= 250) { const r = runs.get(x.run) || { t0: x.t, t1: x.t, n: 0, on: 0 }; r.t1 = x.t; r.n++; if (x.em >= EM_ON) r.on++; runs.set(x.run, r); }
    const doubtful = [...runs.values()].filter((r) => (r.t1 - r.t0) >= 12 && r.on / r.n >= 0.3).map((r) => [Math.round(r.t0), Math.round(r.t1)]);
    const erreRows = tr.filter((x) => x.reg === "Erre" && x.v >= 250);
    const markers = (obj.markers || []).map((m) => {
      const mm = /(\d+(?:[.,]\d+)?)\s*d\s*b\s*\(?a?\)?/i.exec(m.label || "");
      return mm && /sonom|dba|db\(a\)/i.test(m.label) ? { dba: Number(mm[1].replace(",", ".")), speed: m.speed, t: m.elapsed, label: m.label } : null;
    }).filter(Boolean);
    return {
      name: fileName, obj, D, sl, dt,
      id: obj.identity || {}, start: first, duration: obj.summary?.duration ?? (rows.at(-1).t - rows[0].t),
      distance: obj.summary?.routeDistanceKm, vmax: obj.summary?.maxSpeed,
      med250: median(sp250), t250: sec((r) => r.speed >= 250),
      tReg: { Traction: sec((r) => r.regime === "Traction"), Erre: sec((r) => r.regime === "Erre"), Freinage: sec((r) => r.regime === "Freinage") },
      zones: (() => { const tot = withSpeed.length * dt || 1, a = sec((r) => r.speed >= 20 && r.speed < lo), b = sec((r) => r.speed >= lo && r.speed <= hi), c = sec((r) => r.speed > hi); return { lo, hi, a, b, c, tot, pa: a / tot, pb: b / tot, pc: c / tot }; })(),
      st: stats(tr, 270, 300), st2: stats(tr, 250, 300),
      tr, oOn, oOff, doubtful,
      erreActive: erreRows.length ? erreRows.filter((x) => x.em >= EM_ON).length / erreRows.length : NaN,
      markers, nRows: rows.length,
      fiab: obj.diametresTempsReel?.fiabilite, speedRows: rows.map((r) => [r.t, r.speed]),
    };
  }

  /* ---------- comparaison et rédaction ---------- */
  function dateFr(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return "date inconnue";
    return d.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
  }
  function hourFr(ts, plusS = 0) {
    const d = new Date(new Date(ts).getTime() + plusS * 1000);
    if (isNaN(d)) return "—";
    return d.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).replace(":", "h");
  }

  function compare(A, B, note) {
    const dA = dateFr(A.start), dB = dateFr(B.start);
    const sameRame = String(A.id.rame || "") === String(B.id.rame || ""), sameMot = String(A.id.motrice || "") === String(B.id.motrice || "");
    const doc = { title: `Comparaison de deux accompagnements — rame ${B.id.rame || "?"}, motrice ${B.id.motrice || "?"}`, sections: [], A, B, dA, dB };
    const names = [`${dA} (train ${A.id.train || "?"})`, `${dB} (train ${B.id.train || "?"})`];
    doc.intro = `Accompagnement du ${names[1]}, comparé à celui du ${names[0]}. Niveaux en dB relatifs (non calibrés), mesurés sur la fréquence du réducteur.`;
    const sA = A.st, sB = B.st;
    const gapA = sA.levOn - sA.levOff, gapB = sB.levOn - sB.levOff;
    const dOn = sB.levOn - sA.levOn, dOff = sB.levOff - sA.levOff;

    // 1. Constats (chiffres mesurés ; différences seulement au-delà du seuil de significativité)
    const SIG = 3; // dB
    const c = [];
    const enough = sA.n >= 60 && sB.n >= 60;
    if (!sameRame || !sameMot) c.push(`Les deux fichiers ne portent pas sur la même rame ou la même motrice : ${esc(A.id.rame || "?")} / ${esc(A.id.motrice || "?")} et ${esc(B.id.rame || "?")} / ${esc(B.id.motrice || "?")}.`);
    if (!enough) c.push(`<b>Non conclu</b> : moins de 60 instants entre 270 et 300 km/h dans l'un des fichiers (${sA.n} et ${sB.n}).`);
    const dGap = gapB - gapA;
    if (enough && Number.isFinite(gapA) && Number.isFinite(gapB)) {
      const dShare = 100 * (sB.onShare - sA.onShare);
      c.push(`<b>Bruit du réducteur</b> (${fmt(B.sl, 2)} Hz par km/h) : actif ${fmt(100 * sA.onShare, 0)} % du temps le ${dA}, ${fmt(100 * sB.onShare, 0)} % le ${dB}, entre 270 et 300 km/h (${Math.abs(dShare) < 10 ? "pas de différence significative" : "différence de " + sgn(dShare, 0) + " points"}).`);
      c.push(`<b>Écart actif − inactif</b> : ${fmt(gapA)} dB le ${dA}, ${fmt(gapB)} dB le ${dB} (${Math.abs(dGap) < SIG ? "pas de différence significative" : "différence de " + sgn(dGap) + " dB"} ; seuil retenu : ${SIG} dB).`);
    }
    const zA = A.zones, zB = B.zones;
    c.push(`<b>Temps avec la fréquence du bruit dans ${BAND[0]}–${BAND[1]} Hz</b> : ${fmt(zA.b / 60, 0)} min (${fmt(100 * zA.pb, 0)} %) le ${dA}, ${fmt(zB.b / 60, 0)} min (${fmt(100 * zB.pb, 0)} %) le ${dB}. Vitesse médiane au-dessus de 250 km/h : ${fmt(A.med250, 0)} puis ${fmt(B.med250, 0)} km/h. La fréquence est dans la bande entre ${fmt(zB.lo, 0)} et ${fmt(zB.hi, 0)} km/h ; au-dessus, elle dépasse ${BAND[1]} Hz.`);
    if (enough && Number.isFinite(dOn) && Number.isFinite(dOff)) {
      const lvl = (d) => (Math.abs(d) < SIG ? "pas de différence significative" : "différence de " + sgn(d) + " dB");
      c.push(`<b>Niveau relatif</b> à la fréquence du réducteur : bruit actif ${fmt(sA.levOn)} puis ${fmt(sB.levOn)} dB (${lvl(dOn)}) ; bruit inactif ${fmt(sA.levOff)} puis ${fmt(sB.levOff)} dB (${lvl(dOff)}).` + (Math.abs(dOn - dOff) < 2 && Math.abs(dOff) >= SIG ? " L'écart de niveau est du même ordre (à 2 dB près) que le bruit soit actif ou inactif." : ""));
    }
    const conds = [[dA, A.cond], [dB, B.cond]].filter((x) => x[1]);
    if (conds.length) c.push("<b>Conditions de mesure notées</b> : " + conds.map((x) => `le ${x[0]} : ${esc(x[1])}`).join(" ; ") + ". Les niveaux ne sont comparables entre eux que si le côté de la motrice, la manière de tenir l'appareil et le gain sont identiques ; l'écart actif − inactif ne dépend pas du gain.");
    else c.push("<b>Conditions de mesure</b> (côté de la motrice, position de l'appareil) : non renseignées.");
    if (note) c.push(`<b>Intervention notée entre les deux accompagnements</b> : ${esc(note)}.`);
    doc.sections.push({ title: "1. Constats", bullets: c });

    // 2. identité
    const row = (lab, f) => [lab, f(A), f(B)];
    doc.sections.push({
      title: "2. Les deux accompagnements",
      head: ["Indicateur", names[0], names[1]],
      rows: [
        row("Horaire (local)", (S) => `${hourFr(S.start)} – ${hourFr(S.start, S.duration)} (${fmt(S.duration / 60, 0)} min)`),
        row("Rame / motrice / train", (S) => `${S.id.rame || "?"} / ${S.id.motrice || "?"} / ${S.id.train || "?"}`),
        row("Distance enregistrée", (S) => (S.distance ? `${fmt(S.distance)} km` : "—")),
        row("Vitesse maximale", (S) => (S.vmax ? `${fmt(S.vmax)} km/h` : "—")),
        row("Vitesse médiane au-dessus de 250 km/h", (S) => `${fmt(S.med250, 0)} km/h`),
        row("Temps au-dessus de 250 km/h", (S) => `${fmt(S.t250 / 60, 1)} min`),
        row("Temps traction / erre / freinage", (S) => `${fmt(S.tReg.Traction / 60, 0)} / ${fmt(S.tReg.Erre / 60, 0)} / ${fmt(S.tReg.Freinage / 60, 0)} min`),
        row("Diamètre utilisé pour les lignes théoriques", (S) => `${fmt(S.D)} mm`),
        row(`Fréquence du réducteur (Hz par km/h)`, (S) => fmt(S.sl, 2)),
      ],
    });

    // 3. à vitesse égale
    doc.sections.push({
      title: "3. Comparaison à vitesse égale (270–300 km/h)",
      text: `Le bruit du réducteur est suivi sur sa fréquence théorique ; un instant est dit « actif » si ce bruit ressort d'au moins ${EM_ON} dB de son voisinage, « inactif » sous ${EM_OFF} dB. Cette méthode ne dépend pas du marquage du régime.`,
      head: ["Indicateur", names[0], names[1], "Écart"],
      rows: [
        ["Instants analysés", String(sA.n), String(sB.n), enough ? "" : "non conclu (moins de 60)"],
        ["Temps où le bruit est actif", `${fmt(100 * sA.onShare, 0)} %`, `${fmt(100 * sB.onShare, 0)} %`, sgn(100 * (sB.onShare - sA.onShare), 0) + " points" + (Math.abs(sB.onShare - sA.onShare) < 0.1 ? " (non significatif)" : "")],
        ["Niveau du bruit actif (médiane)", `${fmt(sA.levOn)} dB`, `${fmt(sB.levOn)} dB`, sgn(dOn) + " dB" + (Math.abs(dOn) < SIG ? " (non significatif)" : "")],
        ["Niveau quand il est inactif (médiane)", `${fmt(sA.levOff)} dB`, `${fmt(sB.levOff)} dB`, sgn(dOff) + " dB" + (Math.abs(dOff) < SIG ? " (non significatif)" : "")],
        ["Écart actif − inactif", `${fmt(gapA)} dB`, `${fmt(gapB)} dB`, sgn(dGap) + " dB" + (Math.abs(dGap) < SIG ? " (non significatif)" : "")],
        ["Fréquence du bruit actif (médiane)", `${fmt(sA.fOn, 0)} Hz`, `${fmt(sB.fOn, 0)} Hz`, sgn(sB.fOn - sA.fOn, 0) + " Hz"],
        [`Instants actifs dans ${BAND[0]}–${BAND[1]} Hz`, `${fmt(100 * sA.inBand, 0)} %`, `${fmt(100 * sB.inBand, 0)} %`, "dépend de la vitesse"],
        [`Temps passé à ${fmt(zA.lo, 0)}–${fmt(zA.hi, 0)} km/h (bruit dans la bande)`, `${fmt(zA.b / 60, 1)} min (${fmt(100 * zA.pb, 0)} %)`, `${fmt(zB.b / 60, 1)} min (${fmt(100 * zB.pb, 0)} %)`, ""],
        ["Temps au-dessus (bruit au-dessus de 1700 Hz)", `${fmt(zA.c / 60, 1)} min (${fmt(100 * zA.pc, 0)} %)`, `${fmt(zB.c / 60, 1)} min (${fmt(100 * zB.pc, 0)} %)`, ""],
      ],
    });

    // 4. organes
    const pk = [];
    const add = (S, T) => { for (const p of orderPeaks(S)) { const same = pk.find((q) => Math.abs(q.k - p.k) <= 0.08); if (same) { if (p.gap > same.gap) { same.k = p.k; same.gap = p.gap; } } else pk.push({ k: p.k, gap: p.gap }); } };
    add(A); add(B);
    pk.sort((a, b) => a.k - b.k);
    const orows = pk.map((p) => {
      const ga = gapAt(A, p.k), gb = gapAt(B, p.k);
      const org = organOf(p.k, B.D) !== "non identifié" ? organOf(p.k, B.D) : organOf(p.k, A.D);
      let ev = "";
      if (Number.isFinite(ga) && Number.isFinite(gb)) {
        if (ga < 5 && gb >= 6) ev = "présent le " + dB + " seulement";
        else if (gb < 5 && ga >= 6) ev = "présent le " + dA + " seulement";
        else ev = Math.abs(gb - ga) < SIG ? sgn(gb - ga) + " dB (non significatif)" : sgn(gb - ga) + " dB";
      }
      return [fmt(p.k, 2), org, Number.isFinite(ga) ? sgn(ga) + " dB" : "—", Number.isFinite(gb) ? sgn(gb) + " dB" : "—", ev];
    });
    doc.sections.push({
      title: "4. Comparaison par organe (vitesse au-dessus de 230 km/h)",
      text: "« Fréquence par km/h » : rapport entre la fréquence d'un bruit et la vitesse (Hz par km/h). Il ne dépend pas de la vitesse et correspond à un organe tournant. L'écart actif − inactif est la différence de niveau à cette fréquence par km/h entre les instants où le bruit du réducteur est actif et ceux où il est inactif.",
      head: ["Fréquence par km/h", "Organe", "Écart actif − inactif : " + dA, "Écart actif − inactif : " + dB, "Évolution"],
      rows: orows.length ? orows : [["—", "aucun pic marqué", "", "", ""]],
    });
    const only = orows.filter((r) => /seulement/.test(r[4]));
    only.forEach((r) => doc.sections[0].bullets.push(`<b>Fréquence par km/h ${r[0]}</b> : ${r[4]} (écart actif − inactif ${r[2]} le ${dA}, ${r[3]} le ${dB}). ${r[1] === "non identifié" ? "Aucun organe de la chaîne de transmission ne lui correspond." : "Organe correspondant : " + r[1] + "."}`));

    // 5. marquage
    const mk = [];
    for (const [S, lab] of [[A, dA], [B, dB]]) {
      const pc = Number.isFinite(S.erreActive) ? `${fmt(100 * S.erreActive, 0)} % des instants marqués « erre » à plus de 250 km/h ont un bruit du réducteur actif` : "pas d'instant marqué « erre » à plus de 250 km/h";
      mk.push(S.doubtful.length ? `${lab} : ${pc}. Périodes marquées « erre » de 12 s ou plus dont au moins 30 % des instants ont un bruit actif : ${S.doubtful.map((d) => d[0] + " à " + d[1] + " s").join(" ; ")}.` : `${lab} : ${pc}.`);
    }
    mk.push("Les paragraphes 3 et 4 n'utilisent pas le marquage du régime.");
    doc.sections.push({ title: "5. Marquage du régime", bullets: mk });

    // 6. sonomètre
    const mkS = [];
    for (const [S, lab] of [[A, dA], [B, dB]]) for (const m of S.markers) mkS.push(`${lab} : ${fmt(m.dba, 0)} dB(A) au sonomètre à ${fmt(m.speed, 0)} km/h (repère « ${m.label} »).`);
    if (mkS.length) doc.sections.push({ title: "6. Relevés au sonomètre notés pendant l'accompagnement", bullets: mkS.concat(["Le passage en dB(A) estimés demande le fichier audio : analyse d'un seul accompagnement dans l'onglet Fichiers."]) });

    doc.sections.push({ title: "Limites", bullets: [
      "Niveaux relatifs, non calibrés : les comparaisons portent sur des écarts (actif − inactif) et sur l'évolution du niveau relatif.",
      "Le niveau global en dB(A) n'est pas comparé ici (il demande le fichier audio).",
      `Un accompagnement de chaque côté ; seuil de significativité retenu : ${SIG} dB.`,
      "Ces constats portent sur des fréquences mesurées ; ils n'établissent pas l'état d'un organe.",
    ] });
    return doc;
  }

  /* ---------- rendu : page, HTML simple, texte ---------- */
  const strip = (h) => String(h).replace(/<\/?b>/g, "");
  function toHtmlSimple(doc) {
    const o = [`<html>\n<head><meta charset="utf-8"><title>${esc(doc.title)}</title></head>\n<body>\n<h2>${esc(doc.title)}</h2>\n<p>${esc(doc.intro)}</p>`];
    for (const s of doc.sections) {
      o.push(`<h3>${esc(s.title)}</h3>`);
      if (s.text) o.push(`<p>${esc(s.text)}</p>`);
      if (s.bullets) o.push("<ul>\n" + s.bullets.map((b) => `<li>${b}</li>`).join("\n") + "\n</ul>");
      if (s.head) o.push(`<table border cellpadding="4">\n<tr>${s.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>\n` + s.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("\n") + "\n</table>");
    }
    o.push("</body>\n</html>");
    return o.join("\n");
  }
  function toText(doc) {
    const o = [doc.title, "", doc.intro];
    for (const s of doc.sections) {
      o.push("", s.title.toUpperCase());
      if (s.text) o.push(s.text);
      if (s.bullets) s.bullets.forEach((b) => o.push("- " + strip(b)));
      if (s.head) { o.push(s.head.join(" | ")); s.rows.forEach((r) => o.push(r.join(" | "))); }
    }
    return o.join("\n");
  }
  function toPage(doc) {
    const o = [`<p>${esc(doc.intro)}</p>`];
    for (const s of doc.sections) {
      o.push(`<h4>${esc(s.title)}</h4>`);
      if (s.text) o.push(`<p>${esc(s.text)}</p>`);
      if (s.bullets) o.push("<ul>" + s.bullets.map((b) => `<li>${b}</li>`).join("") + "</ul>");
      if (s.head) o.push(`<div class="cmp-scroll"><table><thead><tr>${s.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>` + s.rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? "" : ' class="cmp-lab"'}>${esc(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table></div>");
    }
    return o.join("");
  }

  /* ---------- graphique : vitesse, spectre moyen (bruit actif), répartition ---------- */
  function drawChart(canvas, A, B, dA, dB) {
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = canvas.clientWidth || 1000, narrow = W < 700, H = narrow ? 370 : 310;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = H + "px";
    const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
    const cols = ["#8A8D8F", "#00824A"];
    const panels = narrow ? [[0, 0, W, 165], [0, 170, W, 165]] : [[0, 0, W * 0.5, H - 28], [W * 0.5, 0, W * 0.5, H - 28]];
    const frame = (p, title) => {
      const x0 = p[0] + 46, x1 = p[0] + p[2] - 12, y0 = p[1] + 26, y1 = p[1] + p[3] - 34;
      g.fillStyle = "#1d1d1b"; g.font = "600 12px system-ui, sans-serif"; g.textAlign = "left"; g.fillText(title, x0, p[1] + 16);
      g.strokeStyle = "#d9dadb"; g.lineWidth = 1; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      return { x0, x1, y0, y1 };
    };
    // vitesse
    let f = frame(panels[0], "Vitesse (zone rouge : bruit dans " + BAND[0] + "–" + BAND[1] + " Hz)");
    const tmax = Math.max(A.speedRows.at(-1)[0], B.speedRows.at(-1)[0]);
    const X = (t) => f.x0 + (t / tmax) * (f.x1 - f.x0), Y = (v) => f.y1 - (v / 320) * (f.y1 - f.y0);
    g.fillStyle = "rgba(200,16,46,.12)"; g.fillRect(f.x0, Y(B.zones.hi), f.x1 - f.x0, Y(B.zones.lo) - Y(B.zones.hi));
    g.fillStyle = "#555"; g.font = "11px system-ui, sans-serif"; g.textAlign = "right";
    for (const v of [0, 100, 200, 300]) { g.fillText(String(v), f.x0 - 5, Y(v) + 4); g.strokeStyle = "#eee"; g.beginPath(); g.moveTo(f.x0, Y(v)); g.lineTo(f.x1, Y(v)); g.stroke(); }
    g.textAlign = "center"; for (let m = 0; m * 60 <= tmax; m += 10) g.fillText(m + " min", X(m * 60), f.y1 + 14);
    [A, B].forEach((S, i) => { g.strokeStyle = cols[i]; g.lineWidth = 1.4; g.beginPath(); let st = false; for (const [t, v] of S.speedRows) { if (v == null) { st = false; continue; } if (!st) { g.moveTo(X(t), Y(v)); st = true; } else g.lineTo(X(t), Y(v)); } g.stroke(); });
    // spectre moyen du bruit actif 270–300
    f = frame(panels[1], "Spectre moyen, bruit actif, 270–300 km/h (dB relatif)");
    const spec = (S) => { const sel = S.tr.filter((x) => x.v >= 270 && x.v < 300 && x.em >= EM_ON); const acc = new Float64Array(GN); for (const x of sel) for (let i = 0; i < GN; i++) acc[i] += pw(x.sp[i]); return sel.length ? Array.from(acc, (a) => 10 * Math.log10(a / sel.length + 1e-20)) : null; };
    const SA = spec(A), SB = spec(B), g0 = 1100 / GRID, g1 = 2300 / GRID;
    const all = [SA, SB].filter(Boolean).flatMap((s) => s.slice(g0, g1));
    if (all.length) {
      const lo = Math.floor(Math.min(...all) / 5) * 5, hi = Math.ceil(Math.max(...all) / 5) * 5;
      const XF = (hz) => f.x0 + ((hz - 1100) / 1200) * (f.x1 - f.x0), YL = (d) => f.y1 - ((d - lo) / (hi - lo || 1)) * (f.y1 - f.y0);
      g.fillStyle = "rgba(200,16,46,.12)"; g.fillRect(XF(BAND[0]), f.y0, XF(BAND[1]) - XF(BAND[0]), f.y1 - f.y0);
      g.fillStyle = "#555"; g.font = "11px system-ui, sans-serif"; g.textAlign = "right";
      for (let d = lo; d <= hi; d += 5) g.fillText(String(d), f.x0 - 5, YL(d) + 4);
      g.textAlign = "center"; for (let hz = 1200; hz <= 2200; hz += 200) g.fillText(hz + " Hz", XF(hz), f.y1 + 14);
      [SA, SB].forEach((s, i) => { if (!s) return; g.strokeStyle = cols[i]; g.lineWidth = 1.4; g.beginPath(); for (let k = g0; k <= g1; k++) { const x = XF(k * GRID), y = YL(s[k]); k === g0 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke(); });
    }
    // légende
    g.textAlign = "left"; g.font = "12px system-ui, sans-serif";
    [dA, dB].forEach((d, i) => { g.fillStyle = cols[i]; g.fillRect(14 + i * 170, H - 14, 14, 4); g.fillStyle = "#1d1d1b"; g.fillText(d, 34 + i * 170, H - 9); });
  }

  /* ---------- interface ---------- */
  let last = null;
  function setStatus(msg, bad) { const s = $("cmpStatus"); if (s) { s.textContent = msg; s.className = "cmp-status" + (bad ? " bad" : ""); } }
  async function run() {
    const fa = $("cmpFileA").files[0], fb = $("cmpFileB").files[0];
    if (!fa || !fb) { setStatus("Choisissez les deux accompagnements (ZIP ou JSON).", true); return; }
    $("cmpRun").disabled = true;
    try {
      setStatus("Lecture du premier accompagnement…");
      const SA = analyse(await readJson(fa), fa.name);
      setStatus("Lecture du deuxième accompagnement…");
      const SB = analyse(await readJson(fb), fb.name);
      const [A, B] = new Date(SA.start) <= new Date(SB.start) ? [SA, SB] : [SB, SA];
      SA.cond = ($("cmpCondA").value || "").trim(); SB.cond = ($("cmpCondB").value || "").trim();
      const note = ($("cmpNote").value || "").trim();
      const doc = compare(A, B, note);
      last = doc;
      $("cmpResult").innerHTML = toPage(doc);
      $("cmpOut").classList.remove("hidden");
      drawChart($("cmpCanvas"), A, B, doc.dA, doc.dB);
      setStatus(`Comparaison terminée : ${doc.dA} (avant) et ${doc.dB} (après).`);
    } catch (e) {
      console.error(e);
      setStatus(e.message || String(e), true);
    } finally { $("cmpRun").disabled = false; }
  }
  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function init() {
    if (!$("cmpRun")) return;
    $("cmpRun").addEventListener("click", run);
    $("cmpHtml").addEventListener("click", () => { if (last) download(`Comparaison_accompagnements_${last.dA.replace(/\//g, "-")}_${last.dB.replace(/\//g, "-")}.html`, toHtmlSimple(last), "text/html;charset=utf-8"); });
    $("cmpCopy").addEventListener("click", async () => {
      if (!last) return;
      try { await navigator.clipboard.writeText(toText(last)); setStatus("Texte copié."); }
      catch { download("Comparaison_accompagnements.txt", toText(last), "text/plain;charset=utf-8"); setStatus("Copie impossible ici : texte téléchargé."); }
    });
    window.addEventListener("resize", () => { if (last && !$("cmpOut").classList.contains("hidden")) drawChart($("cmpCanvas"), last.A, last.B, last.dA, last.dB); });
  }
  window.ComparaisonTGV = { analyse, compare, readJson, toText, toHtmlSimple, _last: () => last, EM_ON, EM_OFF };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
