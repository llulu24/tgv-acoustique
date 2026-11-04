/* Analyse Acoustique TGV — v0.9.6
 * Disposition adaptée à l'appareil : PC (inchangé), tablette, téléphone.
 * Détection automatique (écran tactile + taille d'écran), choix manuel possible
 * dans le pied de page (mémorisé) ou par l'adresse ?affichage=tablette|telephone|pc.
 * Sur tablette et téléphone, l'onglet Acquisition est réorganisé en « cockpit » :
 * identification et vitesse en haut, commandes fixées, spectres juste en dessous.
 */
"use strict";

(() => {
  const KEY = "AnalyseAcoustiqueTGV_Affichage";
  const $ = (id) => document.getElementById(id);
  const readPref = () => { try { return localStorage.getItem(KEY) || "auto"; } catch (e) { return "auto"; } };
  const savePref = (v) => { try { localStorage.setItem(KEY, v); } catch (e) {} };

  function detect() {
    const param = new URLSearchParams(location.search).get("affichage");
    const map = { tablette: "tablet", tablet: "tablet", telephone: "phone", phone: "phone", pc: "desktop", desktop: "desktop" };
    if (param && map[param]) savePref(map[param]);
    const pref = readPref();
    if (pref !== "auto") return pref;
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches || navigator.maxTouchPoints > 1 && !window.matchMedia?.("(pointer: fine)")?.matches;
    const minSide = Math.min(screen.width || innerWidth, screen.height || innerHeight);
    if (!coarse) return "desktop";
    return minSide >= 600 ? "tablet" : "phone";
  }

  function label(text, child) {
    const l = document.createElement("label");
    l.className = "cockpit-field";
    const s = document.createElement("span"); s.textContent = text;
    l.append(s, child);
    return l;
  }

  /* réorganisation de l'onglet Acquisition (tablette et téléphone) */
  function buildCockpit() {
    const mode = $("acquisitionMode");
    if (!mode || $("tabletCockpit")) return;
    const cockpit = document.createElement("section");
    cockpit.id = "tabletCockpit";
    cockpit.className = "card panel tablet-cockpit";
    const title = document.createElement("div");
    title.className = "cockpit-title";
    title.textContent = "Identification et vitesse";
    const grid = document.createElement("div");
    grid.className = "cockpit-grid";
    [["acqRame", "Rame"], ["acqMotrice", "Motrice"], ["acqTrain", "Train"]].forEach(([id, text]) => {
      const input = $(id); if (input) grid.append(label(text, input));
    });
    const source = $("acqSpeedSource");
    if (source) {
      const old = source.previousElementSibling;
      if (old?.tagName === "LABEL") old.style.display = "none";
      grid.append(label("Source vitesse", source));
    }
    const manualBox = $("acqManualSpeedBox"), manual = $("acqManualSpeed");
    if (manual && manualBox) {
      const field = label("Vitesse manuelle (km/h)", manual);
      field.id = "cockpitManualField";
      grid.append(field);
      const sync = () => field.classList.toggle("hidden", source?.value !== "manual");
      source?.addEventListener("change", sync); sync();
      manualBox.style.display = "none";
    }
    cockpit.append(title, grid);

    const status = $("acqStatus"), kpis = mode.querySelector(".acq-kpis"), command = mode.querySelector(".acq-command-panel");
    const perms = $("acqPermissions")?.closest("section");
    const first = mode.firstElementChild;
    mode.insertBefore(cockpit, first);
    if (command) mode.insertBefore(command, cockpit.nextSibling);
    if (kpis) mode.insertBefore(kpis, command ? command.nextSibling : cockpit.nextSibling);
    if (status) mode.insertBefore(status, (kpis || command || cockpit).nextSibling);
    if (perms) {
      mode.insertBefore(perms, status ? status.nextSibling : null);
      perms.classList.add("cockpit-perms");
      const refresh = () => {
        const ok = ["acqMicPermission", "acqGpsPermission"].every((id) => $(id)?.classList.contains("acq-perm-ok"));
        perms.classList.toggle("perms-ok", ok);
      };
      ["acqMicPermission", "acqGpsPermission"].forEach((id) => { const el = $(id); if (el) new MutationObserver(refresh).observe(el, { attributes: true, attributeFilter: ["class"], childList: true, characterData: true, subtree: true }); });
      refresh();
    }
    // spectres côte à côte en paysage
    $("acqSpectrum")?.closest("section")?.classList.add("live-pair");
    $("acqSpectrogram")?.closest("section")?.classList.add("live-pair");
  }

  function footerSelector(current) {
    const box = document.querySelector(".footer-box");
    if (!box || $("layoutChoice")) return;
    const wrap = document.createElement("div");
    wrap.className = "layout-choice screen-only";
    const sel = document.createElement("select");
    sel.id = "layoutChoice";
    sel.setAttribute("aria-label", "Disposition de l'affichage");
    [["auto", "Automatique"], ["desktop", "PC"], ["tablet", "Tablette"], ["phone", "Téléphone"]].forEach(([v, t]) => {
      const o = document.createElement("option"); o.value = v; o.textContent = t; sel.append(o);
    });
    sel.value = readPref();
    sel.addEventListener("change", () => { savePref(sel.value); location.replace(location.pathname); });
    const l = document.createElement("label");
    l.textContent = `Affichage (${{ desktop: "PC", tablet: "tablette", phone: "téléphone" }[current]}) : `;
    l.append(sel);
    wrap.append(l);
    box.after(wrap);
  }

  const layout = detect();
  document.documentElement.classList.add("layout-" + layout);
  document.documentElement.dataset.layout = layout;
  const init = () => {
    if (layout !== "desktop") buildCockpit();
    footerSelector(layout);
    window.dispatchEvent(new Event("resize"));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
