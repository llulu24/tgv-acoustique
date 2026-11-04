/* Analyse Acoustique TGV — ergonomie v0.9.7 RC (build 02/11 h)
 * Petits réglages d'interface, sans effet sur les calculs :
 *   - état de l'appli (PWA / HTTPS) déplacé dans l'en-tête, bandeau supprimé ;
 *   - réglages des essieux repliés sur tous les écrans, avec E1 / E2 affichés dans le titre ;
 *   - un seul bouton Démarrer / Arrêter, carmin avec chronomètre pendant l'enregistrement ;
 *   - exemples des champs d'identification marqués « ex. » pour ne pas les prendre pour des valeurs ;
 *   - diagnostic automatique réduit à ses 3 premières lignes (bouton pour tout afficher) ;
 *   - barres d'état en rouge seulement en cas d'erreur.
 * Les styles correspondants sont dans theme-v097.css.
 */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  document.documentElement.classList.add("ux");

  /* en-tête : version + état de l'appli */
  const badge = document.querySelector("header .top-badge");
  if (badge && !document.querySelector(".ux-head-right")) {
    const right = document.createElement("div"); right.className = "ux-head-right";
    badge.replaceWith(right);
    const st = $("pwaState"), inst = $("pwaInstallButton"), info = $("pwaInfo");
    if (st) right.append(st);
    if (inst) right.append(inst);
    right.append(badge);
    const syncTitle = () => { if (st && info) st.title = info.textContent.trim(); };
    if (info) new MutationObserver(syncTitle).observe(info, { childList: true, characterData: true, subtree: true });
    syncTitle();
  }

  /* réglages des essieux : titre qui montre les valeurs */
  function axleTitle() {
    const btn = document.querySelector("#transmissionReference>.mobile-section-toggle"); if (!btn) return;
    const d1 = $("transWheelDiameter1")?.value, d2 = $("transWheelDiameter2")?.value;
    const calc = !!window.DiametresTGV?.calculated?.();
    const html = `<span>Réglages des essieux<span class="ux-axle-chip e1">E1 ${d1} mm</span><span class="ux-axle-chip e2">E2 ${d2} mm</span><span class="ux-axle-src">${calc ? "calculés à partir du sifflement" : "valeurs de réglage"}</span></span>`;
    if (btn.dataset.ux !== html) { btn.innerHTML = html; btn.dataset.ux = html; }
  }
  document.addEventListener("input", (e) => { if (/transWheelDiameter/.test(e.target.id || "")) axleTitle(); });
  document.addEventListener("change", (e) => { if (/transWheelDiameter/.test(e.target.id || "")) axleTitle(); });
  setInterval(axleTitle, 1500);
  setTimeout(axleTitle, 300);

  /* enregistrement : un seul bouton, chronomètre */
  const state = $("acqState"), stop = $("acqStop");
  let t0 = 0, timer = null;
  const clock = document.createElement("span"); clock.className = "ux-rec-time"; clock.setAttribute("aria-live", "off");
  if (stop) stop.after(clock);
  const fmt = (s) => `${Math.floor(s / 3600) ? Math.floor(s / 3600) + " h " : ""}${String(Math.floor(s / 60) % 60).padStart(2, "0")} min ${String(s % 60).padStart(2, "0")} s`;
  function syncRec() {
    const rec = !!state && state.classList.contains("acq-live");
    document.documentElement.classList.toggle("ux-rec", rec);
    if (rec && !timer) { t0 = Date.now(); clock.textContent = "Enregistrement 00 min 00 s"; timer = setInterval(() => (clock.textContent = "Enregistrement " + fmt(Math.floor((Date.now() - t0) / 1000))), 1000); }
    if (!rec && timer) { clearInterval(timer); timer = null; }
  }
  if (state) new MutationObserver(syncRec).observe(state, { attributes: true, childList: true, characterData: true, subtree: true });
  syncRec();
  if ($("acqStart")) $("acqStart").textContent = "Démarrer l’enregistrement";
  if (stop) stop.textContent = "Arrêter";

  /* PC : état, mesures et commande juste sous le message d'état, avant les autorisations */
  if (document.documentElement.dataset.layout === "desktop") {
    const st = $("acqStatus"), kpis = document.querySelector("#acquisitionMode .acq-kpis"), cmd = document.querySelector("#acquisitionMode .acq-command-panel");
    if (st && kpis && cmd) { st.after(cmd); st.after(kpis); }
  }

  /* exemples des champs d'identification */
  ["rame", "motrice", "train", "acqRame", "acqMotrice", "acqTrain"].forEach((id) => {
    const el = $(id); if (el && el.placeholder && !/^ex\./.test(el.placeholder)) el.placeholder = "ex. " + el.placeholder;
  });

  /* barres d'état : rouge seulement pour une erreur */
  ["status", "acqStatus"].forEach((id) => {
    const el = $(id); if (!el) return;
    const sync = () => el.classList.toggle("ux-err", /erreur|impossible|refus|échec|bloqu/i.test(el.textContent));
    new MutationObserver(sync).observe(el, { childList: true, characterData: true, subtree: true }); sync();
  });

  /* diagnostic automatique : 3 lignes, puis « tout afficher » */
  const diag = $("campbellDiagnosis");
  if (diag) {
    diag.classList.add("ux-folded");
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "secondary ux-fold-btn"; btn.hidden = true;
    diag.after(btn);
    const sync = () => {
      const n = diag.querySelectorAll("li").length;
      btn.hidden = n <= 3;
      btn.textContent = diag.classList.contains("ux-folded") ? `Afficher tout le détail (${n} lignes)` : "Réduire le détail";
    };
    btn.addEventListener("click", () => { diag.classList.toggle("ux-folded"); sync(); });
    new MutationObserver(sync).observe(diag, { childList: true, subtree: true }); sync();
  }
})();
