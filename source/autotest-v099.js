/* Analyse Acoustique TGV — v0.9.9 : essai automatique sur gros fichiers (tablette).
 * INACTIF sauf si l'adresse contient ?autotest=1 (lancé par Tester_gros_fichiers_tablette.cmd).
 * Pour chaque fichier listé dans /tests_gros_fichiers/liste.json : lecture, chargement par le chemin normal
 * de l'application (addFiles : décodage par blocs), puis « Analyser tous les fichiers » (analyzeAll).
 * Les durées, la mémoire JavaScript et les erreurs sont envoyées au serveur local (/__resultat) après chaque
 * fichier : si le navigateur plante, le dernier résultat indique quel fichier posait problème.
 * Limite : le fichier est lu par le réseau local (tunnel USB) puis passé à l'application comme un File ; ce n'est pas
 * exactement le sélecteur de fichiers d'Android, mais le décodage et l'analyse sont ceux de l'application. */
(() => {
  if (!/[?&]autotest=1/.test(location.search)) return;
  const out = { fin: false, debut: new Date().toISOString(), agent: navigator.userAgent, ecran: `${screen.width}x${screen.height}`, memoireAppareil_Go: navigator.deviceMemory || null, noyauRust: null, erreursPage: [], fichiers: [] };
  window.addEventListener("error", (e) => out.erreursPage.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => out.erreursPage.push("promesse : " + String(e.reason)));
  const post = (extra = {}) => fetch("/__resultat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...out, ...extra }) }).catch(() => {});
  const heap = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
  const sec = (t) => Math.round(t) / 1000;
  async function one(f) {
    const r = { nom: f.name, taille_Mo: Math.round(f.size / 1048576), etat: "début" };
    out.fichiers.push(r); await post();
    try {
      let t = performance.now();
      const resp = await fetch("/tests_gros_fichiers/" + encodeURIComponent(f.name), { cache: "no-store" });
      if (!resp.ok) throw new Error("lecture HTTP " + resp.status);
      const blob = await resp.blob(); r.lecture_s = sec(performance.now() - t);
      const file = new File([blob], f.name, { type: blob.type || "" });
      records.splice(0, records.length);
      t = performance.now(); await addFiles([file]); r.chargement_s = sec(performance.now() - t); r.memoire_apres_chargement_Mo = heap();
      const rec = records[0];
      if (!rec) { r.etat = "refusé ou illisible"; r.message = (document.getElementById("status") || {}).textContent || ""; return; }
      r.duree_s = Math.round(rec.duration); r.frequence_hz = rec.sampleRate; r.echantillons = rec.samples.length;
      t = performance.now(); await analyzeAll(); r.analyse_s = sec(performance.now() - t);
      r.pics = rec.peaks.length; r.premiersPics_Hz = rec.peaks.slice(0, 3).map((p) => Math.round(p.f));
      r.etat = "ok"; r.memoire_apres_analyse_Mo = heap();
    } catch (e) { r.etat = "erreur"; r.message = String(e && e.message || e); }
    finally { try { records.splice(0, records.length); if (typeof renderFileList === "function") renderFileList(); } catch (e) { /* ignore */ } r.memoire_apres_liberation_Mo = heap(); await post(); }
  }
  async function run() {
    try { out.noyauRust = window.TgvCore ? await window.TgvCore.ready : false; } catch (e) { out.noyauRust = false; }
    try {
      const list = await (await fetch("/tests_gros_fichiers/liste.json", { cache: "no-store" })).json();
      for (const f of list) await one(f);
    } catch (e) { out.erreursPage.push("liste : " + e.message); }
    out.fin = true; out.finLe = new Date().toISOString(); await post();
  }
  window.addEventListener("load", () => setTimeout(run, 3000));
})();
