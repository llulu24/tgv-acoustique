/* Sauvegarde automatique de la session lorsque l'utilisateur appuie sur Arrêter.
 * v0.9.6 : un seul fichier ZIP par session, contenant l'audio, le CSV, le JSON et le tracé GPS,
 * tous nommés Acquisition_TGV_R<rame>_<motrice>_T<train>_<date>_<heure>
 * (ou Acquisition_TGV_NonIdentifie_<date>_<heure> si rame et motrice ne sont pas renseignées).
 */
(() => {
  const startButton = document.getElementById("acqStart");
  const stopButton = document.getElementById("acqStop");
  if (!startButton || !stopButton) return;

  let automaticSaveRequested = false;
  let attachedRecorder = null;
  let recorderWatcher = null;
  let collected = [];
  let report = {};

  /* ---------- ZIP minimal (sans compression : le WAV ne se compresse presque pas) ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }
  /* Création du fichier ZIP sans bibliothèque externe.
   * Format ZIP « stocké » (sans compression : le WAV se compresse mal et cela reste rapide).
   * Pour chaque fichier : en-tête local + données, puis un répertoire central et un
   * enregistrement de fin. Le CRC32 (somme de contrôle) permet au lecteur de vérifier que
   * le fichier n'est pas abîmé ; le drapeau UTF-8 conserve les accents des noms. */
  async function buildZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const { time, date } = dosDateTime(new Date());
    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer()), name = enc.encode(f.name), crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(local.buffer, name, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true); cen.setUint16(12, time, true); cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
      central.push(cen.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const centralSize = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
  }

  window.AcqZip = { buildZip };

  function gpsPointCount() {
    try { return typeof routeGpsPoints === "function" ? routeGpsPoints().length : 0; }
    catch (error) { console.warn("Comptage GPS impossible", error); return 0; }
  }
  function capture(label, fn) {
    acqDownloadCapture = [];
    try { fn(); report[label] = acqDownloadCapture.length > 0; collected.push(...acqDownloadCapture); }
    catch (error) { console.error(`Sauvegarde ${label} impossible`, error); report[label] = false; }
    finally { acqDownloadCapture = null; }
  }
  function downloadFiles(files) {
    files.forEach((f) => downloadBlob(f.name, f.blob));
  }

  /* ---------- v0.9.9 : bouton « Enregistrer toute la session » + enregistrement automatique en cas d'oubli ----------
   * À l'arrêt, les fichiers sont préparés et mis tout de suite en sécurité dans le stockage local de l'application
   * (SessionStoreTGV). Le téléchargement du ZIP est ensuite proposé pendant AUTO_DELAY_S secondes :
   *   - si l'utilisateur appuie sur « Enregistrer toute la session », le ZIP est téléchargé et l'enregistrement
   *     automatique est ANNULÉ (il ne sera pas fait en double) ;
   *   - sinon (oubli), le ZIP est téléchargé automatiquement à la fin du délai ;
   *   - si une nouvelle acquisition est lancée avant la fin du délai, l'enregistrement a lieu immédiatement.
   * Pendant l'acquisition, le bouton enregistre un instantané (CSV, JSON, tracé GPS : l'audio n'existe qu'après l'arrêt). */
  const AUTO_DELAY_S = 20;
  let pending = null;       // { files, base, content, missing, timer, countdown } : session arrêtée, pas encore téléchargée
  const saveButton = document.getElementById("acqSaveAll");

  function describe(rep) {
    const content = [rep.audio && "audio", rep.CSV && "CSV", rep.JSON && "JSON", rep.GPS && "tracé GPS"].filter(Boolean).join(", ");
    const missing = [!rep.audio && "audio indisponible", !rep.GPS && "aucun point GPS précis"].filter(Boolean);
    return { content, missing };
  }
  async function downloadSession(files, base, rep, how) {
    const { content, missing } = describe(rep);
    const tail = (missing.length ? " — " + missing.join(", ") : "") + ".";
    try {
      const zip = await buildZip(files);
      downloadBlob(`${base}.zip`, zip);
      setAcqStatus(`Session enregistrée (${how}) dans ${base}.zip (${(zip.size / 1048576).toFixed(1).replace(".", ",")} Mo : ${content})` + tail, !rep.audio);
    } catch (error) {
      console.error("Création du ZIP impossible, téléchargement des fichiers séparés", error);
      downloadFiles(files);
      setAcqStatus(`ZIP impossible : ${files.length} fichier(s) téléchargé(s) séparément (${content}).`, true);
    }
  }
  function clearPending() { if (pending) { clearTimeout(pending.timer); clearInterval(pending.countdown); pending = null; } updateSaveButton(); }
  async function flushPending(how) {
    if (!pending) return false;
    const p = pending; clearPending();
    await downloadSession(p.files, p.base, p.report, how);
    return true;
  }
  function startCountdown() {
    let left = AUTO_DELAY_S;
    const say = () => setAcqStatus(`Arrêt terminé. Appuyez sur « Enregistrer toute la session » : sinon enregistrement automatique dans ${left} s (fichiers déjà mis en sécurité dans l'application).`);
    say();
    pending.countdown = setInterval(() => { left -= 1; if (left > 0 && pending) say(); }, 1000);
    pending.timer = setTimeout(() => { flushPending("automatique, bouton non utilisé"); }, AUTO_DELAY_S * 1000);
  }
  async function finishAutomaticSave() {
    if (!automaticSaveRequested) return;
    automaticSaveRequested = false;
    if (acqRecordedBlob?.size > 0) capture("audio", () => downloadAcqAudio());
    else report.audio = false;
    const files = collected; collected = [];
    if (!files.length) { setAcqStatus("Arrêt terminé. Sauvegarde automatique : aucun fichier créé.", true); return; }
    const base = acqSessionBaseName();
    clearPending();
    pending = { files, base, report: { ...report } };
    try { window.SessionStoreTGV?.storeFinalFiles(base, files); } catch (error) { console.warn("Stockage local de la session impossible", error); }
    updateSaveButton();
    startCountdown();
  }
  function updateSaveButton() {
    if (!saveButton) return;
    let has = false;
    try { has = !!pending || (typeof acqSamples !== "undefined" && acqSamples.length > 0); } catch (e) { has = false; }
    saveButton.disabled = !has;
  }
  if (saveButton) {
    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      try {
        if (pending) { await flushPending("bouton"); return; }
        if (typeof acqSamples === "undefined" || !acqSamples.length) { setAcqStatus("Aucune donnée à enregistrer : lancez une acquisition.", true); return; }
        // instantané pendant l'acquisition (ou session déjà enregistrée) : on regénère les fichiers
        collected = []; report = {};
        capture("CSV", () => exportAcqCsv());
        capture("JSON", () => exportAcqJson());
        if (gpsPointCount() > 0) capture("GPS", () => exportGpsGeoJson()); else report.GPS = false;
        if (typeof acqRecordedBlob !== "undefined" && acqRecordedBlob?.size > 0) capture("audio", () => downloadAcqAudio()); else report.audio = false;
        const files = collected, rep = { ...report }; collected = [];
        if (!files.length) { setAcqStatus("Aucun fichier créé.", true); return; }
        await downloadSession(files, acqSessionBaseName(), rep, typeof acqRunning !== "undefined" && acqRunning ? "instantané en cours d'acquisition, sans audio" : "bouton");
      } finally { updateSaveButton(); }
    });
    setInterval(updateSaveButton, 1000);
  }
  // nouvelle acquisition lancée alors que la session précédente n'est pas encore téléchargée : on l'enregistre d'abord
  startButton.addEventListener("click", () => { if (pending) flushPending("automatique avant nouvelle acquisition"); }, { capture: true });

  function attachRecorder(recorder) {
    if (!recorder || recorder === attachedRecorder) return;
    attachedRecorder = recorder;
    recorder.addEventListener("stop", () => setTimeout(finishAutomaticSave, 100), { once: true });
  }

  function watchForRecorder() {
    automaticSaveRequested = false;
    collected = []; report = {};
    attachedRecorder = null;
    if (recorderWatcher) clearInterval(recorderWatcher);
    let attempts = 0;
    recorderWatcher = setInterval(() => {
      attempts += 1;
      if (typeof acqMediaRecorder !== "undefined" && acqMediaRecorder) {
        attachRecorder(acqMediaRecorder);
        clearInterval(recorderWatcher); recorderWatcher = null;
      } else if (attempts >= 600) { clearInterval(recorderWatcher); recorderWatcher = null; }
    }, 100);
  }

  startButton.addEventListener("click", watchForRecorder);

  stopButton.addEventListener("click", () => {
    if (typeof acqRunning === "undefined" || !acqRunning) return;
    automaticSaveRequested = true;
    collected = []; report = {};
    if (typeof acqMediaRecorder !== "undefined" && acqMediaRecorder) attachRecorder(acqMediaRecorder);
    capture("CSV", () => exportAcqCsv());
    capture("JSON", () => exportAcqJson());
    if (gpsPointCount() > 0) capture("GPS", () => exportGpsGeoJson()); else report.GPS = false;
    if (!acqMediaRecorder) setTimeout(finishAutomaticSave, 150);
  }, { capture: true });
})();
