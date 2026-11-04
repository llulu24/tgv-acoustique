/* Analyse Acoustique TGV — v0.9.6
 * Carte du trajet GPS dans l'onglet « Analyse de fichiers » et dans le rapport PDF complet.
 *
 * MÉTHODE
 *   Chaque ligne du CSV (ou du JSON) d'acquisition contient la position GPS, la vitesse,
 *   le régime saisi et le niveau de la bande 1 500–1 700 Hz. On place un point par ligne
 *   sur une carte, et on choisit ce que représente la couleur :
 *     - Vitesse : 5 classes de 0 à plus de 280 km/h ;
 *     - Régime  : Traction (orange), Erre (bleu), Freinage (vert), autre (gris) ;
 *     - Niveau 1 500–1 700 Hz : 5 classes calculées sur la session elle-même (centiles),
 *       car les niveaux sont relatifs (sans calibration, seule la comparaison à l'intérieur
 *       d'une même session a un sens). Plus le point est rouge foncé, plus le sifflement
 *       est fort à cet endroit.
 *   Les points trop proches (moins de 20 m) sont regroupés pour alléger la carte.
 *
 * SOURCES DES DONNÉES (dans cet ordre)
 *   1. CSV / JSON associé dans « Analyse de la raie gênante » ou ZIP de session déposé ;
 *   2. à défaut, l'acquisition en cours ou terminée sur cet appareil (acqSamples).
 *
 * FOND DE CARTE
 *   Carte MapLibre (fond OpenFreeMap, internet nécessaire). Sans internet ou si le fond ne
 *   se charge pas, le tracé est dessiné sur un fond neutre avec un quadrillage
 *   latitude / longitude : le rapport contient toujours les trois cartes.
 *
 * RAPPORT
 *   prepareReport() prend une image de la carte pour chacun des trois modes de couleur,
 *   puis appendToReport() les ajoute au rapport PDF complet.
 */
"use strict";

(() => {
  const $id = (id) => document.getElementById(id);
  const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
  const MODES = { vitesse: "Vitesse GPS", regime: "Régime saisi", bande: "Niveau 1 500–1 700 Hz (relatif à la session)" };
  const REG = { Traction: "#D52B1E", Erre: "#0088CE", Freinage: "#82BE00" }; // mêmes couleurs que le Campbell
  const VIT = [[0, "#440154"], [100, "#3b528b"], [200, "#21918c"], [250, "#5ec962"], [280, "#fde725"]];
  const BAN_COLORS = ["#E1E1E1", "#fdd49e", "#fc8d59", "#d7301f", "#7f0000"];
  const NO_DATA = "#B9B9B9";
  const state = { points: [], source: "", map: null, mapReady: false, mapFailed: false, mode: "vitesse", banThresholds: null, snapshots: null };

  const num = (x) => {
    if (x === null || x === undefined) return null;
    const v = parseFloat(String(x).trim().replace(/^'/, "").replace(",", "."));
    return Number.isFinite(v) ? v : null;
  };
  const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d).replace(".", ",") : "—");
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

  /* ---------- lecture des données ---------- */
  // distance approchée en mètres entre deux points proches (projection équirectangulaire)
  function metres(a, b) {
    const k = Math.PI / 180, x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k), y = (b.lat - a.lat) * k;
    return Math.hypot(x, y) * 6371000;
  }
  function thin(points) {
    const out = [];
    for (const p of points) if (!out.length || metres(out.at(-1), p) >= 20) out.push(p);
    return out;
  }
  function fromCsvText(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const parse = (l) => l.split(";").map((c) => c.trim().replace(/^"|"$/g, "").replace(/""/g, '"').replace(/^'/, ""));
    const h = parse(lines[0]), ix = (k) => h.indexOf(k);
    const iLat = ix("latitude"), iLon = ix("longitude");
    if (iLat < 0 || iLon < 0) return [];
    const iV = ix("vitesse_kmh"), iR = ix("regime"), iB = ix("niveau_bande_1500_1700_db"), iH = ix("horodatage"), iP = ix("pic_bande_hz"), iT = ix("temps_s");
    return lines.slice(1).map(parse).map((c) => ({
      lat: num(c[iLat]), lon: num(c[iLon]), v: iV >= 0 ? num(c[iV]) : null, regime: iR >= 0 ? c[iR] || "" : "",
      band: iB >= 0 ? num(c[iB]) : null, peak: iP >= 0 ? num(c[iP]) : null, time: iH >= 0 ? c[iH] : "", t: iT >= 0 ? num(c[iT]) : null,
    }));
  }
  function fromSamples(samples, defaultRegime = "") {
    return (samples || []).map((s) => ({
      lat: num(s.latitude), lon: num(s.longitude), v: num(s.speed), regime: s.regime || defaultRegime,
      band: num(s.bandDb), peak: num(s.bandPeakHz), time: s.timestamp || "", t: num(s.elapsed),
    }));
  }
  function setPoints(points, source) {
    state.points = thin(points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) > 0.01));
    state.source = source;
    state.snapshots = null;
    // classes de niveau : centiles 25, 50, 75 et 90 de la session
    const bands = state.points.map((p) => p.band).filter(Number.isFinite).sort((a, b) => a - b);
    const q = (f) => bands[Math.min(bands.length - 1, Math.floor(f * bands.length))];
    state.banThresholds = bands.length >= 10 ? [q(0.25), q(0.5), q(0.75), q(0.9)] : null;
    render();
  }
  // appelé par analyse-raie-v096.js quand un CSV / JSON / ZIP d'acquisition est associé
  function loadFromText(text, name) {
    try {
      let pts = [];
      if (/\.json$/i.test(name || "") || text.trim().startsWith("{")) {
        const obj = JSON.parse(text);
        pts = fromSamples(obj.samples, obj.identity?.regime || "");
      } else pts = fromCsvText(text);
      if (pts.some((p) => Number.isFinite(p.lat))) setPoints(pts, name || "fichier d'acquisition");
    } catch (error) { console.warn("Carte du trajet : lecture impossible", error); }
  }
  function useLiveAcquisition() {
    if (typeof acqSamples === "undefined" || !acqSamples.length) return false;
    setPoints(fromSamples(acqSamples), "acquisition de cet appareil");
    return true;
  }

  /* ---------- couleurs ---------- */
  function colorOf(p, mode) {
    if (mode === "regime") return REG[p.regime] || NO_DATA;
    if (mode === "bande") {
      if (!Number.isFinite(p.band) || !state.banThresholds) return NO_DATA;
      const k = state.banThresholds.filter((t) => p.band >= t).length;
      return BAN_COLORS[k];
    }
    if (!Number.isFinite(p.v)) return NO_DATA;
    let c = VIT[0][1]; for (const [s, col] of VIT) if (p.v >= s) c = col; return c;
  }
  function legendItems(mode) {
    if (mode === "regime") return [...Object.entries(REG).map(([k, c]) => [c, k]), [NO_DATA, "Non renseigné / statique"]];
    if (mode === "bande") {
      const t = state.banThresholds;
      if (!t) return [[NO_DATA, "pas de mesure de bande"]];
      const lab = [`moins de ${fmt(t[0])} dB`, `${fmt(t[0])} à ${fmt(t[1])} dB`, `${fmt(t[1])} à ${fmt(t[2])} dB`, `${fmt(t[2])} à ${fmt(t[3])} dB`, `plus de ${fmt(t[3])} dB (10 % les plus forts)`];
      return [...BAN_COLORS.map((c, i) => [c, lab[i]]), [NO_DATA, "pas de mesure"]];
    }
    return [...VIT.map(([s, c], i) => [c, i < VIT.length - 1 ? `${s} à ${VIT[i + 1][0]} km/h` : `plus de ${s} km/h`]), [NO_DATA, "vitesse inconnue"]];
  }
  function geojson(mode) {
    return { type: "FeatureCollection", features: state.points.map((p, i) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: { i, color: colorOf(p, mode) },
    })) };
  }
  function bounds() {
    const la = state.points.map((p) => p.lat), lo = state.points.map((p) => p.lon);
    return [[Math.min(...lo), Math.min(...la)], [Math.max(...lo), Math.max(...la)]];
  }

  /* ---------- carte MapLibre ---------- */
  function ensureMap() {
    if (state.map || state.mapFailed) return;
    if (!window.maplibregl || !navigator.onLine) { state.mapFailed = true; return; }
    try {
      state.map = new maplibregl.Map({
        container: "routeMap", style: STYLE_URL, center: [2.6, 49.6], zoom: 6,
        attributionControl: true, preserveDrawingBuffer: true, // nécessaire pour l'image du rapport
      });
      state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      state.map.on("load", () => {
        state.mapReady = true;
        state.map.addSource("route", { type: "geojson", data: geojson(state.mode) });
        state.map.addLayer({ id: "route-points", type: "circle", source: "route", paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 10, 4.5, 14, 7],
          "circle-color": ["get", "color"], "circle-opacity": 0.9,
        } });
        state.map.on("click", "route-points", (e) => {
          const p = state.points[e.features[0].properties.i];
          new maplibregl.Popup({ offset: 8 }).setLngLat([p.lon, p.lat]).setHTML(popupHtml(p)).addTo(state.map);
        });
        state.map.on("mouseenter", "route-points", () => (state.map.getCanvas().style.cursor = "pointer"));
        state.map.on("mouseleave", "route-points", () => (state.map.getCanvas().style.cursor = ""));
        render();
      });
      // une erreur isolée (une tuile, une police) ne doit pas faire abandonner le fond de carte :
      // on ne bascule sur le dessin de secours que si le style n'est pas chargé au bout de 20 s
      state.map.on("error", (e) => console.warn("Carte : erreur non bloquante", e?.error?.message || e));
      setTimeout(() => { if (!state.mapReady) { console.warn("Fond de carte indisponible (délai)"); state.mapFailed = true; render(); } }, 20000);
    } catch (error) { console.warn("Carte indisponible", error); state.mapFailed = true; }
  }
  function popupHtml(p) {
    const hour = p.time ? new Date(p.time).toLocaleTimeString("fr-FR") : "";
    return `<b>${esc(hour)}</b><br>Vitesse : ${Number.isFinite(p.v) ? fmt(p.v) + " km/h" : "inconnue"}<br>Régime : ${esc(p.regime || "—")}` +
      `<br>Bande 1 500–1 700 Hz : ${Number.isFinite(p.band) ? fmt(p.band, 1) + " dB rel." : "—"}` + (Number.isFinite(p.peak) ? `<br>Pic dans la bande : ${fmt(p.peak)} Hz` : "");
  }

  /* ---------- dessin de secours (sans fond de carte) et image du rapport ---------- */
  function drawStatic(mode, width = 1100, height = 620) {
    const c = document.createElement("canvas"); c.width = width; c.height = height;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, width, height);
    const L = 70, R = 260, T = 50, B = 50, pw = width - L - R, ph = height - T - B;
    const [[x0, y0], [x1, y1]] = bounds();
    const k = Math.cos(((y0 + y1) / 2) * Math.PI / 180);           // correction de la longitude
    const sx = (x1 - x0) * k || 1e-4, sy = y1 - y0 || 1e-4, s = Math.min(pw / sx, ph / sy) * 0.92;
    const cx = L + pw / 2, cy = T + ph / 2, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const X = (lon) => cx + (lon - mx) * k * s, Y = (lat) => cy - (lat - my) * s;
    // quadrillage tous les 0,1° ou 0,5° selon l'étendue
    const step = sy > 1.5 ? 0.5 : sy > 0.4 ? 0.1 : 0.05;
    ctx.strokeStyle = "#E1E1E1"; ctx.fillStyle = "#747678"; ctx.font = "12px Arial"; ctx.lineWidth = 1;
    for (let la = Math.ceil((my - ph / 2 / s) / step) * step; la <= my + ph / 2 / s; la += step) {
      ctx.beginPath(); ctx.moveTo(L, Y(la)); ctx.lineTo(L + pw, Y(la)); ctx.stroke(); ctx.fillText(la.toFixed(2) + "°N", 8, Y(la) + 4);
    }
    let lstep = step; while (lstep * k * s < 90) lstep *= 2;          // au moins 90 px entre deux longitudes
    for (let lo = Math.ceil((mx - pw / 2 / k / s) / lstep) * lstep; lo <= mx + pw / 2 / k / s; lo += lstep) {
      ctx.beginPath(); ctx.moveTo(X(lo), T); ctx.lineTo(X(lo), T + ph); ctx.stroke(); ctx.fillText(lo.toFixed(2) + "°E", X(lo) - 22, height - 20);
    }
    state.points.forEach((p) => { ctx.fillStyle = colorOf(p, mode); ctx.beginPath(); ctx.arc(X(p.lon), Y(p.lat), 3.2, 0, 2 * Math.PI); ctx.fill(); });
    const first = state.points[0], last = state.points.at(-1);
    [[first, "Départ"], [last, "Arrivée"]].forEach(([p, t]) => { ctx.fillStyle = "#3C3732"; ctx.font = "bold 13px Arial"; ctx.fillText(t, X(p.lon) + 8, Y(p.lat) - 6); });
    ctx.fillStyle = "#3C3732"; ctx.font = "bold 16px Arial"; ctx.fillText(`Trajet GPS — couleur : ${MODES[mode]}`, L, 28);
    drawLegend(ctx, mode, width - R + 20, T + 10);
    ctx.fillStyle = "#747678"; ctx.font = "11px Arial"; ctx.fillText("Fond de carte non disponible : tracé sur quadrillage latitude / longitude.", L, height - 4);
    return c.toDataURL("image/png");
  }
  function drawLegend(ctx, mode, x, y) {
    const items = legendItems(mode);
    ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fillRect(x - 10, y - 18, 240, 26 + items.length * 22);
    ctx.fillStyle = "#3C3732"; ctx.font = "bold 13px Arial"; ctx.fillText(mode === "bande" ? "Niveau 1 500–1 700 Hz" : MODES[mode], x, y);
    ctx.font = "12px Arial";
    items.forEach(([c, t], i) => { ctx.fillStyle = c; ctx.fillRect(x, y + 10 + i * 22, 16, 12); ctx.fillStyle = "#3C3732"; ctx.fillText(t, x + 24, y + 21 + i * 22); });
  }
  function waitIdle(timeout = 6000) {
    return new Promise((resolve) => {
      let done = false; const end = () => { if (!done) { done = true; resolve(); } };
      state.map.once("idle", end); setTimeout(end, timeout);
    });
  }
  // attend que le style soit chargé (carte créée pendant la préparation du rapport)
  function waitReady(timeout = 20000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() { if (state.mapReady || state.mapFailed || Date.now() - t0 > timeout) resolve(state.mapReady); else setTimeout(poll, 200); })();
    });
  }
  async function snapshotMap(mode) {
    state.map.getSource("route").setData(geojson(mode));
    state.map.resize();
    state.map.fitBounds(bounds(), { padding: 40, duration: 0 });
    await waitIdle(12000);
    // tuiles encore en cours : on laisse un peu de temps supplémentaire
    for (let i = 0; i < 20 && !state.map.areTilesLoaded(); i++) await new Promise((r) => setTimeout(r, 250));
    const src = state.map.getCanvas();
    const c = document.createElement("canvas"); c.width = src.width; c.height = src.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(src, 0, 0);
    const r = window.devicePixelRatio || 1; ctx.scale(r, r);
    drawLegend(ctx, mode, 20, 30);
    ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.fillRect(src.width / r - 250, src.height / r - 18, 250, 18);
    ctx.fillStyle = "#3C3732"; ctx.font = "11px Arial"; ctx.fillText("© OpenFreeMap © OpenMapTiles © OpenStreetMap", src.width / r - 244, src.height / r - 5);
    return c.toDataURL("image/png");
  }
  // prépare les 3 images (vitesse, régime, niveau) avant la génération du PDF
  async function prepareReport() {
    if (!state.points.length) useLiveAcquisition();
    if (!state.points.length) { state.snapshots = null; return; }
    const shots = {};
    // la carte doit être visible (onglet Diagnostic affiché par le générateur du rapport) puis chargée
    const sec = $id("routeSection"); if (sec) sec.classList.remove("hidden");
    render(); ensureMap();
    if (state.map && !state.mapReady) await waitReady();
    for (const mode of Object.keys(MODES)) {
      try { shots[mode] = state.mapReady && !state.mapFailed ? await snapshotMap(mode) : drawStatic(mode); }
      catch (error) { console.warn("Image de carte impossible, dessin de secours", error); shots[mode] = drawStatic(mode); }
    }
    if (state.mapReady) state.map.getSource("route").setData(geojson(state.mode));
    state.snapshots = shots;
  }
  function stats() {
    const pts = state.points, vs = pts.map((p) => p.v).filter(Number.isFinite);
    let km = 0; for (let i = 1; i < pts.length; i++) km += metres(pts[i - 1], pts[i]) / 1000;
    const loud = pts.filter((p) => state.banThresholds && Number.isFinite(p.band) && p.band >= state.banThresholds[3]);
    const lv = loud.map((p) => p.v).filter(Number.isFinite).sort((a, b) => a - b);
    return { n: pts.length, km, vmax: vs.length ? Math.max(...vs) : null, loudN: loud.length, loudV: lv.length ? [lv[Math.floor(lv.length * 0.1)], lv[Math.floor(lv.length * 0.9)]] : null };
  }
  function appendToReport(container) {
    if (!state.snapshots) return;
    const s = stats();
    const section = document.createElement("section");
    section.style.breakBefore = "page";
    section.innerHTML = `<h2>Carte du trajet GPS</h2><div style="font-size:12px;margin-bottom:8px">Source : ${esc(state.source)} — ${s.n} points, environ ${fmt(s.km)} km, vitesse maximale ${fmt(s.vmax)} km/h.` +
      (s.loudV ? ` Les 10 % de points où la bande 1 500–1 700 Hz est la plus forte se situent surtout entre ${fmt(s.loudV[0])} et ${fmt(s.loudV[1])} km/h.` : "") + "</div>";
    Object.entries(MODES).forEach(([mode, label]) => {
      const fig = document.createElement("div"); fig.style.breakInside = "avoid"; fig.style.marginBottom = "12px";
      fig.innerHTML = `<h3 style="margin:8px 0 4px">Couleur selon : ${esc(label)}</h3>`;
      fig.appendChild(createReportImage(state.snapshots[mode], `Carte du trajet — ${label}`));
      section.appendChild(fig);
    });
    container.appendChild(section);
  }

  /* ---------- interface ---------- */
  function render() {
    const info = $id("routeInfo"), legend = $id("routeLegend"), mapBox = $id("routeMap"), fallback = $id("routeFallback");
    if (!info) return;
    if (!state.points.length) {
      info.textContent = "Aucun trajet : associez le CSV / JSON d’une acquisition (ou déposez le ZIP de session), ou cliquez sur « Utiliser l’acquisition de cet appareil ».";
      legend.innerHTML = ""; mapBox.hidden = true; fallback.hidden = true; return;
    }
    const s = stats();
    info.textContent = `${state.source} : ${s.n} points, environ ${fmt(s.km)} km, vitesse maximale ${fmt(s.vmax)} km/h. Cliquez sur un point pour le détail.`;
    legend.innerHTML = `<b>${esc(MODES[state.mode])}</b> : ` + legendItems(state.mode).map(([c, t]) => `<span class="route-key"><i style="background:${c}"></i>${esc(t)}</span>`).join(" ");
    ensureMap();
    if (state.mapFailed) {
      mapBox.hidden = true; fallback.hidden = false;
      fallback.src = drawStatic(state.mode);
      info.textContent += " Fond de carte indisponible (pas d’internet ?) : tracé sur quadrillage.";
      return;
    }
    mapBox.hidden = false; fallback.hidden = true;
    if (state.mapReady) {
      state.map.resize();
      state.map.getSource("route").setData(geojson(state.mode));
      state.map.fitBounds(bounds(), { padding: 40, duration: 0, maxZoom: 14 });
    }
  }
  function init() {
    if (!$id("routeSection")) return;
    $id("routeMode").addEventListener("change", (e) => { state.mode = e.target.value; render(); });
    $id("routeUseLive").addEventListener("click", () => {
      if (!useLiveAcquisition()) $id("routeInfo").textContent = "Aucune acquisition enregistrée sur cet appareil depuis l’ouverture de l’application.";
    });
    $id("routePng").addEventListener("click", async () => {
      if (!state.points.length) return;
      const url = state.mapReady && !state.mapFailed ? await snapshotMap(state.mode) : drawStatic(state.mode);
      const a = document.createElement("a"); a.href = url; a.download = `Carte_trajet_${state.mode}.png`; a.click();
    });
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

  window.CarteTrajetTGV = { loadFromText, useLiveAcquisition, prepareReport, appendToReport, _state: state };
})();
