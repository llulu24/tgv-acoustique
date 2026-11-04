/* Analyse Acoustique TGV — v0.9.6
 * 1. Journal des acquisitions sur l'appareil (IndexedDB) : audio, données seconde par seconde,
 *    lignes Campbell et marqueurs sont enregistrés toutes les 5 s pendant l'acquisition.
 *    Après une actualisation, une fermeture ou un plantage, la session est reconstituée.
 * 2. Liste des sessions enregistrées : télécharger le ZIP, analyser, supprimer.
 * 3. Lecture directe des ZIP de session dans l'onglet Analyse (WAV + CSV associés).
 */
"use strict";

(() => {
  /* MÉTHODE — PAS DE PERTE DE DONNÉES
   * Toutes les 5 s pendant l'acquisition, ce qui est nouveau (audio, lignes CSV, lignes
   * Campbell, marqueurs) est écrit dans la base IndexedDB du navigateur, qui survit à une
   * actualisation, à la fermeture de l'onglet ou à un plantage. L'audio est stocké par
   * morceaux (« chunks ») ; les spectres Campbell sont compressés en entiers 16 bits.
   * Au redémarrage, une session non terminée est signalée et peut être reconstituée en ZIP.
   * Quand le ZIP final est créé, les morceaux sont supprimés et seul le résultat est gardé ;
   * les 30 dernières sessions sont conservées. */
  const DB_NAME = "AnalyseAcoustiqueTGV_Sessions", DB_VERSION = 1, SAVE_MS = 5000, KEEP = 30;
  const $ = (id) => document.getElementById(id);
  const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1).replace(".", ",") + " Mo" : Math.max(1, Math.round(b / 1024)) + " ko");
  const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s` : `${Math.round(s)} s`);
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

  /* ---------- IndexedDB ---------- */
  let dbPromise = null;
  function db() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("sessions")) d.createObjectStore("sessions", { keyPath: "id" });
        if (!d.objectStoreNames.contains("chunks")) { const c = d.createObjectStore("chunks", { autoIncrement: true }); c.createIndex("sid", "sid"); }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function tx(stores, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let result;
      Promise.resolve(fn(t)).then((r) => (result = r));
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const getSession = (id) => tx(["sessions"], "readonly", (t) => reqP(t.objectStore("sessions").get(id)));
  const putSession = (s) => tx(["sessions"], "readwrite", (t) => { t.objectStore("sessions").put(s); });
  const allSessions = () => tx(["sessions"], "readonly", (t) => reqP(t.objectStore("sessions").getAll()));
  const addChunk = (c) => tx(["chunks"], "readwrite", (t) => { t.objectStore("chunks").add(c); });
  const chunksOf = (sid) => tx(["chunks"], "readonly", (t) => reqP(t.objectStore("chunks").index("sid").getAll(IDBKeyRange.only(sid))));
  async function deleteChunks(sid) {
    await tx(["chunks"], "readwrite", (t) => {
      const idx = t.objectStore("chunks").index("sid");
      idx.openKeyCursor(IDBKeyRange.only(sid)).onsuccess = (e) => { const cur = e.target.result; if (cur) { t.objectStore("chunks").delete(cur.primaryKey); cur.continue(); } };
    });
  }
  async function deleteSession(id) {
    await deleteChunks(id);
    await tx(["sessions"], "readwrite", (t) => { t.objectStore("sessions").delete(id); });
  }

  /* ---------- journal pendant l'acquisition ---------- */
  const live = { id: null, seq: 0, pcm: 0, blobs: 0, samples: 0, rows: 0, busy: false, closing: false, wasRunning: false, lastSave: 0 };
  function identity() {
    return { rame: $("acqRame")?.value.trim() || "", motrice: $("acqMotrice")?.value.trim() || "", train: $("acqTrain")?.value.trim() || "", regime: $("acqRegime")?.value || "", notes: $("acqNotes")?.value.trim() || "" };
  }
  async function startJournal() {
    try { navigator.storage?.persist?.(); } catch (e) {}
    live.id = acqSessionBaseName();
    Object.assign(live, { seq: 0, pcm: 0, blobs: 0, samples: 0, rows: 0, closing: false, lastSave: performance.now() });
    await putSession({ id: live.id, name: live.id, startedAt: (acqSessionStartDate || new Date()).toISOString(), status: "en_cours", identity: identity(), duration: 0, bytes: 0, updatedAt: new Date().toISOString() });
    renderList();
  }
  async function flushJournal(final = false) {
    if (!live.id || live.busy || live.closing) return;
    live.busy = true;
    try {
      const rec = typeof acqMediaRecorder !== "undefined" ? acqMediaRecorder : null;
      let added = 0, rate = null, mime = typeof acqRecordedMime !== "undefined" ? acqRecordedMime : "";
      if (rec && Array.isArray(rec.chunks) && rec.rate) {
        rate = rec.rate;
        const fresh = rec.chunks.slice(live.pcm);
        if (fresh.length) {
          const n = fresh.reduce((s, c) => s + c.length, 0), all = new Int16Array(n);
          let o = 0; fresh.forEach((c) => { all.set(c, o); o += c.length; });
          await addChunk({ sid: live.id, seq: live.seq++, type: "pcm", data: all });
          live.pcm += fresh.length; added += all.byteLength;
        }
      } else if (typeof acqRecordedChunks !== "undefined" && acqRecordedChunks.length > live.blobs) {
        const fresh = acqRecordedChunks.slice(live.blobs);
        const blob = new Blob(fresh, { type: mime || "audio/webm" });
        await addChunk({ sid: live.id, seq: live.seq++, type: "blob", data: blob });
        live.blobs += fresh.length; added += blob.size;
      }
      if (typeof acqSamples !== "undefined" && acqSamples.length > live.samples) {
        const fresh = acqSamples.slice(live.samples);
        await addChunk({ sid: live.id, seq: live.seq++, type: "samples", data: fresh });
        live.samples += fresh.length;
      }
      const rows = window.CampbellTGV?._state?.source === "live" ? window.CampbellTGV._state.rows : [];
      if (rows.length > live.rows) {
        const fresh = rows.slice(live.rows).map((r) => ({ ...r, spec: Int16Array.from(r.spec, (v) => Math.round(Math.max(-160, v))) }));
        await addChunk({ sid: live.id, seq: live.seq++, type: "campbell", data: fresh });
        live.rows += fresh.length; added += fresh.length * 1100;
      }
      const s = (await getSession(live.id)) || { id: live.id, name: live.id };
      Object.assign(s, {
        identity: identity(), markers: typeof acqMarkers !== "undefined" ? acqMarkers : [], rate, mime,
        transmission: typeof transmissionExportConfig === "function" ? transmissionExportConfig() : null,
        duration: (performance.now() - acqStartTime) / 1000, bytes: (s.bytes || 0) + added, updatedAt: new Date().toISOString(),
        status: final ? "a_finaliser" : "en_cours",
      });
      await putSession(s);
      live.lastSave = performance.now();
      const el = $("sessionsJournalState");
      if (el) el.textContent = `Sauvegarde continue sur la tablette : ${fmtDur(s.duration)} enregistrées (${fmtSize(s.bytes)}).`;
    } catch (error) {
      console.error("Journal de session", error);
      const el = $("sessionsJournalState");
      if (el) el.textContent = "Sauvegarde continue impossible : " + (error?.message || error);
    } finally { live.busy = false; }
  }

  /* fichiers finaux transmis par la sauvegarde automatique (ZIP) */
  async function storeFinalFiles(base, files) {
    const id = live.id || base;
    live.closing = true;
    for (let i = 0; i < 50 && live.busy; i++) await new Promise((r) => setTimeout(r, 100));
    try {
      const s = (await getSession(id)) || { id, name: base, startedAt: new Date().toISOString() };
      Object.assign(s, { name: base, files, status: "terminee", bytes: files.reduce((t, f) => t + f.blob.size, 0), updatedAt: new Date().toISOString() });
      await putSession(s);
      await deleteChunks(id);
      await prune();
    } catch (error) { console.error("Enregistrement de la session terminée", error); }
    live.id = null;
    live.closing = false;
    renderList();
  }

  async function prune() {
    const list = (await allSessions()).filter((s) => s.status === "terminee").sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    for (const s of list.slice(KEEP)) await deleteSession(s.id);
  }

  /* ---------- reconstitution d'une session interrompue ---------- */
  function wavFromPcm(chunks, rate) {
    const n = chunks.reduce((t, c) => t + c.length, 0), header = new ArrayBuffer(44), v = new DataView(header);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
    return new Blob([header, ...chunks], { type: "audio/wav" });
  }
  function geojsonFromSamples(samples, name) {
    const pts = samples.filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude));
    if (pts.length < 2) return null;
    const gj = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name, source: "reconstitution" }, geometry: { type: "LineString", coordinates: pts.map((s) => [s.longitude, s.latitude]) } }] };
    return new Blob([JSON.stringify(gj, null, 2)], { type: "application/geo+json" });
  }
  async function rebuild(id) {
    if (typeof acqRunning !== "undefined" && acqRunning) { alertState("Arrêtez l’acquisition en cours avant de reconstituer une session.", true); return null; }
    const s = await getSession(id); if (!s) return null;
    const chunks = (await chunksOf(id)).sort((a, b) => a.seq - b.seq);
    const pcm = chunks.filter((c) => c.type === "pcm").map((c) => c.data), blobs = chunks.filter((c) => c.type === "blob").map((c) => c.data);
    const samples = chunks.filter((c) => c.type === "samples").flatMap((c) => c.data);
    const rows = chunks.filter((c) => c.type === "campbell").flatMap((c) => c.data).map((r) => ({ ...r, spec: Array.from(r.spec) }));
    // restauration dans l'interface, puis export par les fonctions habituelles
    const id0 = s.identity || {};
    if ($("acqRame")) $("acqRame").value = id0.rame || "";
    if ($("acqMotrice")) $("acqMotrice").value = id0.motrice || "";
    if ($("acqTrain")) $("acqTrain").value = id0.train || "";
    acqSessionStartDate = new Date(s.startedAt);
    acqSamples = samples;
    acqMarkers = s.markers || [];
    acqRecordedBlob = pcm.length ? wavFromPcm(pcm, s.rate || 24000) : blobs.length ? new Blob(blobs, { type: s.mime || "audio/webm" }) : null;
    acqRecordedMime = pcm.length ? "audio/wav" : s.mime || "audio/webm";
    if (rows.length && window.CampbellTGV) window.CampbellTGV.importData({ campbell: { format: "campbell_tgv", version: 1, gridStepHz: 5, gridMaxHz: 2500, rows }, identity: id0 }, s.name);
    const files = [];
    acqDownloadCapture = [];
    try {
      exportAcqCsv();
      exportAcqJson();
      if (acqRecordedBlob) downloadAcqAudio();
      files.push(...acqDownloadCapture);
    } finally { acqDownloadCapture = null; }
    const gj = geojsonFromSamples(samples, s.name);
    if (gj) files.push({ name: acqSessionBaseName() + "_GPS.geojson", blob: gj });
    ["acqExportJson", "acqExportCsv", "acqDownloadAudio", "acqSendAnalysis"].forEach((b) => { if ($(b)) $(b).disabled = false; });
    live.id = id;
    await storeFinalFiles(acqSessionBaseName(), files);
    return files;
  }

  /* ---------- ZIP : écriture (via la sauvegarde automatique) et lecture ---------- */
  async function zipBlob(files) { return window.AcqZip.buildZip(files); }
  async function readZip(file) {
    const buf = new DataView(await file.arrayBuffer());
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (buf.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("ZIP invalide");
    const count = buf.getUint16(eocd + 10, true); let p = buf.getUint32(eocd + 16, true);
    const dec = new TextDecoder(), out = [];
    for (let n = 0; n < count; n++) {
      if (buf.getUint32(p, true) !== 0x02014b50) break;
      const method = buf.getUint16(p + 10, true), csize = buf.getUint32(p + 20, true), nameLen = buf.getUint16(p + 28, true), extraLen = buf.getUint16(p + 30, true), commentLen = buf.getUint16(p + 32, true), local = buf.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(buf.buffer, p + 46, nameLen));
      const lNameLen = buf.getUint16(local + 26, true), lExtra = buf.getUint16(local + 28, true), start = local + 30 + lNameLen + lExtra;
      let data = new Uint8Array(buf.buffer, start, csize);
      if (method === 8) {
        if (typeof DecompressionStream === "undefined") throw new Error("ZIP compressé non pris en charge par ce navigateur");
        data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      } else if (method !== 0) throw new Error("Méthode de compression ZIP non prise en charge");
      if (!name.endsWith("/")) out.push({ name: name.split("/").pop(), blob: new Blob([data]) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }
  const typeFor = (name) => (/\.wav$/i.test(name) ? "audio/wav" : /\.csv$/i.test(name) ? "text/csv" : /\.json$/i.test(name) ? "application/json" : /\.(m4a|mp4)$/i.test(name) ? "audio/mp4" : /\.webm$/i.test(name) ? "audio/webm" : "application/octet-stream");

  /* ouverture d'une session (ZIP ou session enregistrée) dans l'onglet Analyse */
  async function openInAnalysis(files, label) {
    const audio = files.find((f) => /\.(wav|m4a|mp4|webm|ogg|mp3)$/i.test(f.name));
    const data = files.find((f) => /\.csv$/i.test(f.name)) || files.find((f) => /\.json$/i.test(f.name) && !/geojson/i.test(f.name));
    if (!audio) { alertState(`${label} : aucun fichier audio trouvé.`, true); return; }
    if (typeof setAppMode === "function") setAppMode("analysis");
    await originalAddFiles([new File([audio.blob], audio.name, { type: typeFor(audio.name) })]);
    if (data && window.AnalyseRaieTGV?.associateSpeedFile) {
      const rec = records.at(-1);
      if (rec && $("toneRecord")) { window.AnalyseRaieTGV.refresh?.(); $("toneRecord").value = String(rec.id); }
      await window.AnalyseRaieTGV.associateSpeedFile(new File([data.blob], data.name, { type: typeFor(data.name) }));
    }
    // v0.9.7 RC : données Campbell du JSON de session chargées pour l'onglet Diagnostic
    const json = files.find((f) => /\.json$/i.test(f.name) && !/geojson/i.test(f.name));
    if (json && window.CampbellTGV && !(typeof acqRunning !== "undefined" && acqRunning)) {
      try {
        const obj = JSON.parse(await json.blob.text());
        if (obj?.campbell?.rows?.length) window.CampbellTGV.importData(obj, json.name);
        // identification et date de la session reprises dans l'onglet Fichiers (si vides)
        const id = obj?.identity || {}, put = (fid, v) => { const el = $(fid); if (el && !el.value && v) el.value = v; };
        put("rame", id.rame); put("motrice", id.motrice); put("train", id.train);
        const ts = obj?.samples?.[0]?.timestamp; if (ts) put("date", String(ts).slice(0, 10));
      }
      catch (error) { console.warn("Campbell du ZIP non chargé", error); }
    }
    setStatus(`${label} ouvert : ${audio.name}${data ? " + vitesse et régime de " + data.name : ""}. Lancez « Analyser tous les fichiers ».`);
  }

  /* lecture directe des ZIP dans l'onglet Analyse */
  let originalAddFiles = null;
  function patchAddFiles() {
    if (typeof addFiles !== "function" || originalAddFiles) return;
    originalAddFiles = addFiles;
    // eslint-disable-next-line no-global-assign
    addFiles = async function addFilesWithZip(fileList) {
      const list = [...fileList], zips = list.filter((f) => /\.zip$/i.test(f.name) || /zip/i.test(f.type)), others = list.filter((f) => !zips.includes(f));
      if (others.length) await originalAddFiles(others);
      for (const z of zips) {
        try { setStatus(`Lecture du ZIP ${z.name}…`); await openInAnalysis(await readZip(z), z.name); }
        catch (error) { console.error(error); setStatus(`ZIP illisible (${z.name}) : ${error?.message || error}`, true); }
      }
    };
    const input = $("fileInput");
    if (input) input.accept = "audio/*,.wav,.zip,application/zip";
    const hint = document.querySelector("#drop .small");
    if (hint) hint.textContent = "Fichiers audio ou ZIP de session (audio + vitesse associés automatiquement)";
  }

  /* ---------- interface : bandeau de récupération et liste des sessions ---------- */
  function alertState(text, error = false) {
    const el = $("sessionsInfo"); if (el) { el.textContent = text; el.classList.toggle("status-error", error); }
  }
  function download(name, blob) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function buildUi() {
    const mode = $("acquisitionMode");
    if (!mode || $("sessionsSection")) return;
    const sec = document.createElement("section");
    sec.id = "sessionsSection"; sec.className = "card panel sessions-section";
    sec.innerHTML = `<h2 style="margin-top:0">Sessions enregistrées sur cet appareil</h2>
      <div class="small">Chaque acquisition est sauvegardée en continu sur l’appareil. Après une actualisation, une fermeture ou une coupure, la session est récupérable ici.</div>
      <div id="sessionsJournalState" class="small sessions-state"></div>
      <div id="sessionsInfo" class="small sessions-state" role="status" aria-live="polite"></div>
      <div class="acq-table-wrap"><table class="sessions-table"><thead><tr><th>Session</th><th>Durée</th><th>Taille</th><th>État</th><th></th></tr></thead><tbody id="sessionsBody"></tbody></table></div>
      <div id="sessionsStorage" class="small sessions-state"></div>`;
    mode.appendChild(sec);
    const banner = document.createElement("div");
    banner.id = "sessionsBanner"; banner.className = "sessions-banner hidden"; banner.setAttribute("role", "alert");
    document.querySelector("main")?.prepend(banner);
    $("sessionsBody").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]"); if (!btn) return;
      const id = btn.dataset.id, act = btn.dataset.act;
      btn.disabled = true;
      try {
        if (act === "rebuild") {
          alertState("Reconstitution en cours…");
          const files = await rebuild(id);
          if (files) { download(acqSessionBaseName() + ".zip", await zipBlob(files)); alertState(`Session reconstituée et téléchargée (${files.length} fichiers).`); }
        } else {
          const s = await getSession(id);
          if (act === "zip" && s?.files) download(s.name + ".zip", await zipBlob(s.files));
          if (act === "analyse" && s?.files) await openInAnalysis(s.files, s.name);
          if (act === "delete" && confirm(`Supprimer définitivement la session ${s?.name || id} de l’appareil ?`)) { await deleteSession(id); alertState("Session supprimée."); }
        }
      } catch (error) { console.error(error); alertState("Erreur : " + (error?.message || error), true); }
      btn.disabled = false;
      renderList();
    });
    $("sessionsBanner").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]"); if (!btn) return;
      if (btn.dataset.act === "hide") { $("sessionsBanner").classList.add("hidden"); return; }
      btn.disabled = true; btn.textContent = "Reconstitution…";
      try {
        const files = await rebuild(btn.dataset.id);
        if (files) download(acqSessionBaseName() + ".zip", await zipBlob(files));
        $("sessionsBanner").classList.add("hidden");
      } catch (error) { console.error(error); btn.textContent = "Échec : " + (error?.message || error); }
      renderList();
    });
  }
  const STATUS = { en_cours: "en cours", interrompue: "interrompue — à reconstituer", a_finaliser: "à finaliser", terminee: "terminée" };
  async function renderList() {
    const body = $("sessionsBody"); if (!body) return;
    let list = [];
    try { list = await allSessions(); } catch (e) { body.innerHTML = `<tr><td colspan="5">Stockage indisponible sur ce navigateur.</td></tr>`; return; }
    list.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    body.innerHTML = list.length ? list.map((s) => {
      const running = s.id === live.id && typeof acqRunning !== "undefined" && acqRunning;
      const actions = running ? "<em>enregistrement…</em>"
        : s.status === "terminee" ? `<button data-act="zip" data-id="${esc(s.id)}" class="secondary">ZIP</button> <button data-act="analyse" data-id="${esc(s.id)}" class="secondary">Analyser</button> <button data-act="delete" data-id="${esc(s.id)}" class="danger">×</button>`
        : `<button data-act="rebuild" data-id="${esc(s.id)}">Reconstituer</button> <button data-act="delete" data-id="${esc(s.id)}" class="danger">×</button>`;
      return `<tr><td>${esc(s.name)}<div class="small">${new Date(s.startedAt).toLocaleString("fr-FR")}</div></td><td>${fmtDur(s.duration || 0)}</td><td>${fmtSize(s.bytes || 0)}</td><td>${esc(running ? "en cours" : STATUS[s.status] || s.status)}</td><td class="sessions-actions">${actions}</td></tr>`;
    }).join("") : `<tr><td colspan="5">Aucune session enregistrée pour l’instant.</td></tr>`;
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) $("sessionsStorage").textContent = `Espace utilisé par l’application : ${fmtSize(est.usage || 0)} sur ${fmtSize(est.quota || 0)} disponibles.`;
    } catch (e) {}
  }
  async function checkInterrupted() {
    let list = [];
    try { list = await allSessions(); } catch (e) { return; }
    const broken = list.filter((s) => s.status === "en_cours" || s.status === "a_finaliser");
    for (const s of broken) { s.status = "interrompue"; await putSession(s); }
    const all = list.filter((s) => s.status === "interrompue" || broken.includes(s)).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    if (all.length) {
      const s = all[0], b = $("sessionsBanner");
      b.innerHTML = `<strong>Session interrompue récupérée :</strong> ${esc(s.name)} (${fmtDur(s.duration || 0)}, ${fmtSize(s.bytes || 0)}). <button data-act="rebuild" data-id="${esc(s.id)}">Reconstituer et télécharger le ZIP</button> <button data-act="hide" class="secondary">Plus tard</button>` + (all.length > 1 ? ` <span class="small">${all.length - 1} autre(s) dans « Sessions enregistrées ».</span>` : "");
      b.classList.remove("hidden");
    }
    renderList();
  }

  /* ---------- boucle ---------- */
  setInterval(() => {
    const running = typeof acqRunning !== "undefined" && acqRunning;
    if (running && !live.wasRunning) startJournal().catch((e) => console.error(e));
    if (!running && live.wasRunning) flushJournal(true);
    live.wasRunning = running;
    if (running && live.id && performance.now() - live.lastSave >= SAVE_MS) flushJournal(false);
  }, 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && live.id && typeof acqRunning !== "undefined" && acqRunning) flushJournal(false); });

  window.SessionStoreTGV = { storeFinalFiles, rebuild, readZip, openInAnalysis, renderList, _live: live };
  const init = () => { buildUi(); patchAddFiles(); checkInterrupted(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
