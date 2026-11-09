"use strict";
/* =====================================================================================
 * ANALYSE ACOUSTIQUE TGV — MOTEUR PRINCIPAL (v0.9.7 RC)
 * Développement : Ludovic Léone — SNCF Technicentre Le Landy, Pôle Fiabilité
 *
 * BUT DU LOGICIEL
 *   Retrouver l'origine des bruits gênants en cabine, en particulier le sifflement
 *   de 1 500 à 1 700 Hz entendu en traction à haute vitesse, en reliant le son
 *   (micro) à la vitesse du train (GPS) et à la chaîne de transmission (dents des pignons,
 *   diamètre des roues).
 *
 * PRINCIPE GÉNÉRAL DE LA MÉTHODE
 *   1. On transforme le son en SPECTRE : niveau sonore pour chaque fréquence (FFT).
 *   2. On cherche les PICS du spectre qui dépassent nettement le bruit voisin
 *      (« émergence ») : ce sont les sons « purs » qui gênent l'oreille.
 *   3. On calcule les FRÉQUENCES THÉORIQUES de chaque organe tournant à la vitesse
 *      du train : essieu, moteur, engrènement du réducteur, engrènement du pont.
 *   4. Si un pic suit la fréquence théorique d'un organe quand la vitesse change,
 *      cet organe est la source. Le diagramme de Campbell (campbell-v096.js) montre
 *      cette relation fréquence / vitesse sur tout un trajet.
 *   5. Les BANDES LATÉRALES autour du pic (écart = fréquence de rotation d'un arbre)
 *      désignent l'arbre qui module l'engrènement (faux-rond, défaut de denture…).
 *
 * ORGANISATION DES FICHIERS
 *   - AnalyseAcoustiqueTGV_v0.9.6_engine.js : ce fichier. Décodage audio, FFT, spectre,
 *     pics, fréquences théoriques, acquisition temps réel (micro + GPS), exports, REX.
 *   - wav-decoder-v096.js   : lecture des longs fichiers WAV par blocs, réduction à 8 kHz.
 *   - wav-recorder-v096.js  : enregistrement du micro en WAV pendant l'acquisition.
 *   - campbell-v096.js      : diagramme de Campbell en direct, comparaison traction / erre,
 *                             diagnostic automatique.
 *   - analyse-raie-v096.js  : analyse fine du sifflement d'un fichier (suivi dans le temps,
 *                             spectre en ordres, bandes latérales).
 *   - sessions-v096.js      : sauvegarde continue des acquisitions (pas de perte de données).
 *   - auto-save-acquisition.js : création du ZIP de fin de session.
 *   - affichage-v096.js/.css, mobile-v4.* : mise en page PC / tablette / téléphone.
 *   - sw.js                 : service worker (fonctionnement hors ligne de la PWA).
 *
 * UNITÉS
 *   Fréquences en Hz, vitesses en km/h, diamètres en mm, niveaux en dB RELATIFS
 *   (pas de calibration acoustique : on compare des niveaux entre eux, ce n'est pas
 *   une mesure sonométrique réglementaire).
 * ===================================================================================== */

/* Limites de fonctionnement.
 * - Fichiers : les WAV sont lus par blocs (peu de mémoire), d'où des limites plus larges
 *   que pour les formats compressés (M4A, MP3) que le navigateur doit décoder en entier.
 * - GPS : une position n'est utilisée pour la vitesse que si sa précision est meilleure
 *   que 25 m ; au-delà de 80 m elle n'est même pas affichée. Une vitesse supérieure à
 *   326,4 km/h ou une accélération supérieure à 3,5 m/s² est physiquement impossible
 *   pour un TGV : la mesure est rejetée. */
const STABILITY_CONFIG = Object.freeze({
  applicationVersion: "0.9.7-rc",
  schemaVersion: 2,
  maxFiles: 10,
  // v0.9.6 : WAV lus par blocs et ramenés à 8 kHz (≈ 115 Mo par heure en mémoire)
  maxFileBytes: 300 * 1024 * 1024, // formats compressés (M4A, MP3, WebM…)
  maxWavFileBytes: 4 * 1024 * 1024 * 1024,
  maxFileDurationSeconds: 1800, // formats compressés : 30 min
  maxWavFileDurationSeconds: 7200, // WAV : 2 h par fichier
  maxTotalDurationSeconds: 9000, // 2 h 30 au total
  gpsMaxAccuracyMeters: 80,
  gpsSpeedMaxAccuracyMeters: 25,
  gpsMinIntervalSeconds: 0.8,
  gpsMaxSpeedKmh: 326.4,
  gpsMaxAccelerationMps2: 3.5,
  maxFilenameLength: 80,
});

function safeFilenamePart(value, fallback = "non-renseigne") {
  const normalized = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const clean = normalized
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[. ]+$/g, "");
  return (clean || fallback).slice(0, STABILITY_CONFIG.maxFilenameLength);
}
function safeCsvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function releaseRecordResources(record) {
  if (!record) return;
  record.samples = null;
  record.spectrum = null;
  record.spectrogram = null;
  record.peaks = [];
}
function reportError(error, userMessage, context = "") {
  console.error(context || userMessage, error);
  setStatus(userMessage, true);
}
function prefersReducedMotion() {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true
  );
}

function peakDisplayedLevel(peak) {
  return (aWeightingEnabled() ? peak.aV : peak.rawV) + levelCalOffset();
}
/* Calibration de niveau (dB absolu).
 * Le logiciel ne connaît que le niveau numérique du micro (dB par rapport à la pleine échelle).
 * Un décalage C relie ce niveau à la pression acoustique : niveau (dB SPL) = niveau numérique + C.
 * C se règle soit avec un calibrateur (ex. 94 dB à 1 kHz), soit avec un sonomètre (niveau moyen du
 * fichier). Une fréquence pure de niveau efficace L apparaît dans la FFT (fenêtre de Hann) à L − 9,03 dB :
 * on ajoute donc 9,03 dB pour afficher le niveau d'un son pur. Sans calibration : dB relatifs. */
const HANN_TONE_DB = 9.03;
const levelCal = { offset: null, how: "" };
try {
  const saved = JSON.parse(localStorage.getItem("tgvLevelCal") || "null");
  if (saved && Number.isFinite(saved.offset)) { levelCal.offset = saved.offset; levelCal.how = saved.how || ""; }
} catch (e) {}
function levelCalActive() { return levelCal.offset != null; }
function levelCalOffset() { return levelCalActive() ? levelCal.offset + HANN_TONE_DB : 0; }
function hideBelowHz() {
  const v = parseFloat(document.getElementById("hideBelow")?.value);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
/* niveau global du fichier en dB par rapport à la pleine échelle (somme des puissances du spectre) */
function overallLevelDbfs(record, weighted) {
  const s = record?.spectrum;
  if (!s) return null;
  let sum = 0;
  for (let k = 0; k < s.freq.length; k++) {
    if (s.freq[k] < 20) continue;
    const p = Math.pow(10, (weighted ? s.dbA[k] : s.db[k]) / 10);
    if (Number.isFinite(p)) sum += p;
  }
  return 10 * Math.log10((2 * sum) / 0.375);
}
function setLevelCal(offset, how) {
  levelCal.offset = offset; levelCal.how = how || "";
  try { if (offset == null) localStorage.removeItem("tgvLevelCal"); else localStorage.setItem("tgvLevelCal", JSON.stringify({ offset, how })); } catch (e) {}
  refreshAnalysisForWeighting();
  updateLevelCalUi();
}
function currentRecordForCal() {
  return (records[selectedIndex]?.spectrum ? records[selectedIndex] : null) || records.find((x) => x.spectrum) || null;
}
function updateLevelCalUi() {
  const st = document.getElementById("levelCalStatus"); if (!st) return;
  const rec = currentRecordForCal();
  const g = rec?.spectrum ? overallLevelDbfs(rec, aWeightingEnabled()) : null;
  st.className = "frequency-calibration-status " + (levelCalActive() ? "ok" : "neutral");
  st.textContent = levelCalActive()
    ? `Calibration active : décalage ${levelCal.offset.toFixed(1)} dB (${levelCal.how}). Niveaux en ${aWeightingEnabled() ? "dB(A)" : "dB SPL"}, précision indicative ± 3 dB.` + (g != null ? ` Niveau global du fichier affiché : ${(g + levelCal.offset).toFixed(1)} ${aWeightingEnabled() ? "dB(A)" : "dB SPL"}.` : "")
    : "Calibration inactive : niveaux relatifs (dB par rapport à la pleine échelle)." + (g != null ? ` Niveau global du fichier : ${g.toFixed(1)} dB relatif.` : "");
}
function initLevelCalUi() {
  const $$ = (id) => document.getElementById(id);
  $$("levelCalSono")?.addEventListener("click", () => {
    const rec = currentRecordForCal(); const x = parseFloat($$("levelCalSonoValue").value);
    if (!rec?.spectrum || !Number.isFinite(x)) { setStatus("Calibration : analysez d'abord un fichier et saisissez le niveau du sonomètre."); return; }
    const L = overallLevelDbfs(rec, true);
    setLevelCal(x - L, `sonomètre ${x} dB(A) sur ce fichier`);
  });
  $$("levelCalTone")?.addEventListener("click", () => {
    const rec = currentRecordForCal(); const ref = parseFloat($$("levelCalToneValue").value);
    if (!rec?.spectrum || !Number.isFinite(ref)) { setStatus("Calibration : analysez d'abord l'enregistrement du calibrateur."); return; }
    let m = -Infinity; for (let k = 0; k < rec.spectrum.freq.length; k++) { const f = rec.spectrum.freq[k]; if (f >= 900 && f <= 1100) m = Math.max(m, rec.spectrum.db[k]); }
    if (!Number.isFinite(m)) { setStatus("Calibration : aucune fréquence trouvée entre 900 et 1100 Hz."); return; }
    setLevelCal(ref - (m + HANN_TONE_DB), `calibrateur ${ref} dB à 1 kHz`);
  });
  $$("levelCalManual")?.addEventListener("click", () => {
    const c = parseFloat($$("levelCalManualValue").value);
    if (Number.isFinite(c)) setLevelCal(c, "décalage saisi");
  });
  $$("levelCalReset")?.addEventListener("click", () => setLevelCal(null, ""));
  ["hideBelow", "showRawOverlay"].forEach((id) => $$(id)?.addEventListener("change", () => { drawCurrent(); }));
  updateLevelCalUi();
}
/* Calibration en fréquence (optionnelle).
 * L'horloge audio d'une tablette peut être légèrement fausse (quelques pour mille).
 * L'utilisateur joue un son de fréquence connue ; le rapport fréquence réelle / fréquence
 * mesurée devient un facteur appliqué à toutes les fréquences de la même fréquence
 * d'échantillonnage. Sans calibration, le facteur vaut 1. */
function frequencyCalibrationFactorFor(sampleRate) {
  return frequencyCalibration.active &&
    Number.isFinite(frequencyCalibration.sampleRate) &&
    Math.abs(sampleRate - frequencyCalibration.sampleRate) < 1
    ? frequencyCalibration.factor
    : 1;
}
function frequencyCalibrationExport() {
  return {
    active: frequencyCalibration.active,
    factor: Number(frequencyCalibration.factor.toFixed(9)),
    referenceHz: frequencyCalibration.reference,
    measuredHz: frequencyCalibration.measured,
    errorHz: frequencyCalibration.errorHz,
    errorPct: frequencyCalibration.errorPct,
    sampleRate: frequencyCalibration.sampleRate,
  };
}
function setFrequencyCalibrationStatus(text, kind = "neutral") {
  const el = $("frequencyCalibrationStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "frequency-calibration-status " + kind;
}
function applyCalibrationToAnalyses() {
  for (const record of records) {
    if (!record.spectrum) continue;
    const raw =
      record.spectrum.freqRaw ||
      Float64Array.from(
        record.spectrum.freq,
        (value) => value / (frequencyCalibration.previousFactor || 1),
      );
    record.spectrum.freqRaw = raw;
    const factor = frequencyCalibrationFactorFor(record.sourceSampleRate || record.sampleRate),
      freq = Float64Array.from(raw, (value) => value * factor);
    record.spectrum.freq = freq;
    record.spectrum.dbA = Float64Array.from(
      record.spectrum.db,
      (value, index) => value + aWeightingCorrection(freq[index]),
    );
    findPeaks(record);
  }
  refreshAnalysisOutputs();
  if (acqRunning) {
    const peaks = detectLivePeaks();
    acqLastPeaks = peaks;
    drawLiveSpectrum(peaks);
  }
}
function measureFrequencyCalibration() {
  const record = records[selectedIndex],
    reference = parseFloat($("frequencyCalibrationReference")?.value);
  if (!record?.spectrum) {
    setFrequencyCalibrationStatus(
      "Analysez d’abord un fichier contenant le signal de référence.",
      "error",
    );
    return;
  }
  if (!Number.isFinite(reference) || reference < 20 || reference > 5000) {
    setFrequencyCalibrationStatus(
      "Fréquence de référence autorisée : 20 à 5 000 Hz.",
      "error",
    );
    return;
  }
  const freq = record.spectrum.freqRaw || record.spectrum.freq,
    values = record.spectrum.db,
    radius = Math.max(40, reference * 0.12);
  let best = -1;
  for (let i = 2; i < freq.length - 2; i++) {
    if (freq[i] < reference - radius) continue;
    if (freq[i] > reference + radius) break;
    if (
      values[i] > values[i - 1] &&
      values[i] > values[i + 1] &&
      (best < 0 || values[i] > values[best])
    )
      best = i;
  }
  if (best < 0) {
    setFrequencyCalibrationStatus(
      "Aucun pic net trouvé près de la référence.",
      "error",
    );
    return;
  }
  const refined = interpolatePeak(freq, values, best),
    measured = refined.frequency,
    factor = reference / measured,
    errorHz = measured - reference,
    errorPct = (errorHz / reference) * 100,
    valid = Math.abs(factor - 1) <= 0.02;
  frequencyCalibration.pending = {
    factor,
    reference,
    measured,
    errorHz,
    errorPct,
    sampleRate: record.sourceSampleRate || record.sampleRate,
  };
  $("frequencyCalibrationApply").disabled = !valid;
  setFrequencyCalibrationStatus(
    `Mesuré ${measured.toFixed(2)} Hz · erreur ${errorHz >= 0 ? "+" : ""}${errorHz.toFixed(2)} Hz (${errorPct >= 0 ? "+" : ""}${errorPct.toFixed(3)} %) · coefficient ${factor.toFixed(7)}${valid ? "" : " · écart supérieur à 2 %, application refusée"}`,
    valid ? "ready" : "error",
  );
}
function applyFrequencyCalibration() {
  const pending = frequencyCalibration.pending;
  if (!pending) return;
  frequencyCalibration.previousFactor = frequencyCalibration.factor;
  Object.assign(frequencyCalibration, pending, { active: true, pending: null });
  try {
    localStorage.setItem(
      "AnalyseAcoustiqueTGV_FrequencyCalibration_v1",
      JSON.stringify(frequencyCalibrationExport()),
    );
  } catch (error) {
    console.warn("Calibration non mémorisée", error);
  }
  $("frequencyCalibrationApply").disabled = true;
  applyCalibrationToAnalyses();
  setFrequencyCalibrationStatus(
    `Calibration active : ×${frequencyCalibration.factor.toFixed(7)} à ${frequencyCalibration.sampleRate} Hz.`,
    "active",
  );
}
function resetFrequencyCalibration() {
  frequencyCalibration.previousFactor = frequencyCalibration.factor;
  Object.assign(frequencyCalibration, {
    active: false,
    factor: 1,
    reference: null,
    measured: null,
    errorHz: null,
    errorPct: null,
    sampleRate: null,
    pending: null,
  });
  try {
    localStorage.removeItem("AnalyseAcoustiqueTGV_FrequencyCalibration_v1");
  } catch (error) {}
  $("frequencyCalibrationApply").disabled = true;
  applyCalibrationToAnalyses();
  setFrequencyCalibrationStatus(
    "Calibration inactive — fréquence issue directement de l’horloge audio.",
  );
}
function initFrequencyCalibration() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("AnalyseAcoustiqueTGV_FrequencyCalibration_v1") ||
        "null",
    );
    if (
      saved?.active &&
      Number.isFinite(saved.factor) &&
      saved.factor >= 0.98 &&
      saved.factor <= 1.02 &&
      Number.isFinite(saved.sampleRate)
    ) {
      Object.assign(frequencyCalibration, saved, {
        pending: null,
        previousFactor: 1,
      });
      if (
        $("frequencyCalibrationReference") &&
        Number.isFinite(saved.referenceHz)
      )
        $("frequencyCalibrationReference").value = String(saved.referenceHz);
      frequencyCalibration.reference = saved.referenceHz;
      frequencyCalibration.measured = saved.measuredHz;
      setFrequencyCalibrationStatus(
        `Calibration mémorisée active : ×${saved.factor.toFixed(7)} à ${saved.sampleRate} Hz.`,
        "active",
      );
    }
  } catch (error) {
    console.warn("Lecture calibration", error);
  }
  $("frequencyCalibrationMeasure")?.addEventListener(
    "click",
    measureFrequencyCalibration,
  );
  $("frequencyCalibrationApply")?.addEventListener(
    "click",
    applyFrequencyCalibration,
  );
  $("frequencyCalibrationReset")?.addEventListener(
    "click",
    resetFrequencyCalibration,
  );
}
function diagnosticBinWidth() {
  const N = parseInt($("fftSize")?.value) || 8192,
    widths = records
      .filter((record) => Number.isFinite(record.sampleRate))
      .map(
        (record) =>
          (record.sampleRate / N) *
          frequencyCalibrationFactorFor(record.sourceSampleRate || record.sampleRate),
      );
  return widths.length ? Math.max(...widths) : 48000 / N;
}
/* Interpolation parabolique d'un pic.
 * La FFT ne donne le niveau qu'à des fréquences espacées d'un « pas » (par exemple
 * 0,98 Hz). Le vrai sommet est souvent entre deux cases. On fait passer une parabole par
 * les 3 points autour du maximum (gauche, centre, droite) : son sommet donne la fréquence
 * exacte (décalage delta entre -1 et +1 case) et le niveau exact du pic. */
function interpolatePeak(freq, values, index) {
  const left = values[index - 1],
    center = values[index],
    right = values[index + 1];
  const denominator = left - 2 * center + right;
  let delta =
    Number.isFinite(denominator) && Math.abs(denominator) > 1e-12
      ? (0.5 * (left - right)) / denominator
      : 0;
  delta = Math.max(-1, Math.min(1, delta));
  const binWidth = freq[index + 1] - freq[index];
  return {
    frequency: freq[index] + delta * binWidth,
    level: center - 0.25 * (left - right) * delta,
    delta,
  };
}
function refreshAnalysisOutputs() {
  const ready = records.some((record) => record.spectrum);
  if (ready) {
    renderPeakTable();
    renderCommonFrequencies();
    buildSummary();
    renderFrequencyGuidance();
    renderRexMatches();
  } else {
    $("peaksBody").innerHTML = "";
    $("commonBody").innerHTML = "";
    $("commonInfo").textContent = "Aucune analyse disponible.";
    $("summary").textContent = "Aucune analyse disponible.";
    $("frequencyGuidance").textContent =
      "Lancez une analyse pour identifier les familles fréquentielles.";
    $("metricCommon").textContent = "0";
  }
  $("fullPdf").disabled = !ready;
  $("saveRex").disabled = !ready;
  $("saveRexSecondary").disabled = !ready;
  updateMetrics(ready ? "Analyse disponible" : "En attente");
  drawCurrent();
  drawAnalysisTheoryChart();
}
function currentNormalizedSignature() {
  const values = [];
  records.forEach((record) => {
    const speed = parseFloat(record.speed);
    if (!Number.isFinite(speed) || speed <= 0) return;
    record.peaks.slice(0, 6).forEach((peak) => values.push(peak.f / speed));
  });
  values.sort((a, b) => a - b);
  const clustered = [];
  const tolerance = 0.04;
  values.forEach((value) => {
    const index = clustered.findIndex(
      (existing) => Math.abs(existing - value) <= tolerance,
    );
    if (index >= 0) clustered[index] = (clustered[index] + value) / 2;
    else clustered.push(value);
  });
  return clustered.filter(Number.isFinite).slice(0, 20);
}
function safeRexString(value, maxLength = 4000) {
  return typeof value === "string"
    ? value.slice(0, maxLength)
    : value == null
      ? ""
      : String(value).slice(0, maxLength);
}
function safeRexId(value) {
  const candidate = safeRexString(value, 80);
  return /^[A-Za-z0-9_-]{1,80}$/.test(candidate) ? candidate : newId();
}
function safeNumberArray(value, strict = false) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    if (strict)
      throw new Error(
        "Signature REX invalide : un tableau numérique est requis.",
      );
    return [];
  }
  return value.map(Number).filter(Number.isFinite).slice(0, 100);
}
function normalizeRexIntervention(value, strict = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strict) throw new Error("Intervention REX invalide.");
    return null;
  }
  return {
    id: safeRexId(value.id),
    date: safeRexString(value.date, 40),
    organ: safeRexString(value.organ, 500),
    action: safeRexString(value.action, 2000),
    outcome: safeRexString(value.outcome, 200),
    confirmsCause: Boolean(value.confirmsCause),
    notes: safeRexString(value.notes, 4000),
    createdAt: safeRexString(value.createdAt, 60),
  };
}
function normalizeRexCase(value, strict = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strict) throw new Error("Dossier REX invalide.");
    return null;
  }
  if (strict && value.signature != null && !Array.isArray(value.signature))
    throw new Error("Dossier REX invalide : signature doit être un tableau.");
  if (
    strict &&
    value.signatureNormalized != null &&
    !Array.isArray(value.signatureNormalized)
  )
    throw new Error(
      "Dossier REX invalide : signatureNormalized doit être un tableau.",
    );
  const interventions = Array.isArray(value.interventions)
    ? value.interventions
        .map((item) => normalizeRexIntervention(item, strict))
        .filter(Boolean)
    : [];
  return {
    id: safeRexId(value.id),
    version: safeRexString(value.version, 30) || "antérieure",
    createdAt: safeRexString(value.createdAt, 60),
    updatedAt: safeRexString(value.updatedAt, 60),
    rame: safeRexString(value.rame, 200),
    motrice: safeRexString(value.motrice, 200),
    train: safeRexString(value.train, 200),
    date: safeRexString(value.date, 40),
    notes: safeRexString(value.notes, 4000),
    summary: safeRexString(value.summary, 12000),
    transmission: normalizeTransmissionConfig(value.transmission),
    signature: safeNumberArray(value.signature, strict),
    signatureNormalized: safeNumberArray(value.signatureNormalized, strict),
    signatureBasis: safeRexString(value.signatureBasis, 60),
    commonFrequencies: Array.isArray(value.commonFrequencies)
      ? value.commonFrequencies.slice(0, 100)
      : [],
    files: Array.isArray(value.files) ? value.files.slice(0, 100) : [],
    weighting:
      value.weighting && typeof value.weighting === "object"
        ? {
            enabled: Boolean(value.weighting.enabled),
            mode: safeRexString(value.weighting.mode, 50),
            unit: safeRexString(value.weighting.unit, 50),
            absoluteMeasurement: false,
            notice: safeRexString(value.weighting.notice, 500),
          }
        : null,
    status: safeRexString(value.status, 100) || "En investigation",
    confirmedCause: safeRexString(value.confirmedCause, 2000),
    conclusion: safeRexString(value.conclusion, 4000),
    interventions,
  };
}

/* Pondération A (norme CEI 61672).
 * L'oreille entend moins bien les graves et les très aigus. La pondération A corrige
 * chaque fréquence pour se rapprocher de la sensation auditive (dB(A)). Elle vaut 0 dB à
 * 1 000 Hz, environ +1 dB vers 2 000–3 000 Hz et -19 dB à 100 Hz. Formule officielle
 * ci-dessous (le +2 dB recale la courbe à 0 dB à 1 kHz). */
function aWeightingCorrection(frequency) {
  if (!Number.isFinite(frequency) || frequency <= 0) return -120;
  const f2 = frequency * frequency;
  const numerator = 12194 * 12194 * f2 * f2;
  const denominator =
    (f2 + 20.6 * 20.6) *
    Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) *
    (f2 + 12194 * 12194);
  return 20 * Math.log10(numerator / denominator) + 2;
}
function aWeightingEnabled() {
  return Boolean($("aWeighting")?.checked);
}
function activeSpectrumDb(record) {
  const base = aWeightingEnabled() && record?.spectrum?.dbA
    ? record.spectrum.dbA
    : record?.spectrum?.db;
  const off = levelCalOffset();
  if (!base || !off) return base;
  const c = record._calCache;
  if (c && c.base === base && c.off === off) return c.arr;
  const arr = Float64Array.from(base, (v) => v + off);
  record._calCache = { base, off, arr };
  return arr;
}
function activeModeName() {
  return aWeightingEnabled() ? "pondéré A" : "brut";
}
function activeLevelLabel() {
  if (levelCalActive()) return aWeightingEnabled() ? "dB(A) calibré" : "dB SPL calibré";
  return aWeightingEnabled() ? "dB(A) relatif" : "dB relatif";
}
function activeLevelUnit() {
  return activeLevelLabel();
}
function weightingDisclaimer() {
  if (levelCalActive()) return `Niveaux calibrés (${levelCal.how}, décalage ${levelCal.offset.toFixed(1)} dB) : valeurs indicatives à ± 3 dB, qui ne constituent pas une mesure sonométrique réglementaire.`;
  return "Les niveaux sont relatifs : sans calibration acoustique, ils ne constituent pas une mesure sonométrique absolue ou réglementaire.";
}
function refreshAnalysisForWeighting() {
  if (records.some((record) => record.spectrum)) {
    renderPeakTable();
    buildSummary();
    renderFrequencyGuidance();
  }
  drawCurrent();
  drawAnalysisTheoryChart();
  if (acqRunning) {
    drawLiveSpectrum(acqLastPeaks);
    updateLiveSummary(acqLastPeaks);
  }
  updateLevelCalUi();
  const state = $("aWeightingState");
  if (state)
    state.textContent = aWeightingEnabled()
      ? "Pondération A affichée. Diagnostic sur le spectre brut."
      : "Spectre brut affiché.";
  setStatus(
    aWeightingEnabled()
      ? "Affichage pondéré A actif."
      : "Affichage brut actif.",
  );
}
function initAWeightingUi() {
  initLevelCalUi();
  const control = $("aWeighting");
  if (control) control.addEventListener("change", refreshAnalysisForWeighting);
  const state = $("aWeightingState");
  if (state) state.textContent = "Spectre brut affiché.";
  const fft = $("fftSize");
  if (fft)
    fft.addEventListener("change", () => {
      records.forEach((record) => (record.spectrogram = null));
      if (currentView === "spectrogram") drawCurrent();
      setStatus("Taille FFT modifiée. Relancez l’analyse.");
    });
}
const $ = (id) => document.getElementById(id);
const canvas = $("chart"),
  ctx = canvas.getContext("2d");
const colors = [
  "#0088CE",
  "#E05206",
  "#009AA6",
  "#6E1E78",
  "#D52B1E",
  "#009AA6",
  "#3C3732",
  "#747678",
  "#A1006B",
  "#009AA6",
];
let records = [],
  currentView = "compare",
  selectedIndex = 0,
  nextId = 1,
  spectrumZoomRange = null,
  frequencyCalibration = {
    active: false,
    factor: 1,
    reference: null,
    measured: null,
    errorHz: null,
    errorPct: null,
    sampleRate: null,
    pending: null,
    previousFactor: 1,
  };
const HISTORY_KEY = "AnalyseAcoustiqueTGV_REX_v1";
let historyCases = [];
let selectedHistoryId = null;
let storageAvailable = true;
function setStatus(text, error = false) {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("status-error", error);
}
function updateMetrics(stateText = "En attente") {
  $("metricFiles").textContent = records.length;
  $("metricState").textContent = stateText;
}
function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(800, Math.floor(rect.width * ratio));
  canvas.height = Math.floor(460 * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}
function clearCanvas() {
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
}
function axes(ctxLocal, w, h, title, xlabel, ylabel, xmax, ymin, ymax) {
  const L = 68,
    R = 22,
    T = 38,
    B = 50;
  ctxLocal.strokeStyle = "#3C3732";
  ctxLocal.lineWidth = 1;
  ctxLocal.beginPath();
  ctxLocal.moveTo(L, T);
  ctxLocal.lineTo(L, h - B);
  ctxLocal.lineTo(w - R, h - B);
  ctxLocal.stroke();
  ctxLocal.fillStyle = "#3C3732";
  ctxLocal.font = "14px Segoe UI";
  ctxLocal.fillText(title, L, T - 14);
  ctxLocal.font = "12px Segoe UI";
  ctxLocal.fillText(xlabel, w / 2 - 40, h - 12);
  ctxLocal.save();
  ctxLocal.translate(17, h / 2 + 40);
  ctxLocal.rotate(-Math.PI / 2);
  ctxLocal.fillText(ylabel, 0, 0);
  ctxLocal.restore();
  for (let i = 0; i <= 5; i++) {
    const x = L + ((w - L - R) * i) / 5,
      val = (xmax * i) / 5;
    ctxLocal.fillStyle = "#4D4F53";
    ctxLocal.fillText(val.toFixed(val < 10 ? 1 : 0), x - 12, h - B + 18);
    ctxLocal.strokeStyle = "#E1E1E1";
    ctxLocal.beginPath();
    ctxLocal.moveTo(x, T);
    ctxLocal.lineTo(x, h - B);
    ctxLocal.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    const y = T + ((h - T - B) * i) / 5,
      val = ymax - ((ymax - ymin) * i) / 5;
    ctxLocal.fillStyle = "#4D4F53";
    ctxLocal.fillText(val.toFixed(0), 7, y + 4);
    ctxLocal.strokeStyle = "#E1E1E1";
    ctxLocal.beginPath();
    ctxLocal.moveTo(L, y);
    ctxLocal.lineTo(w - R, y);
    ctxLocal.stroke();
  }
  return { w, h, L, R, T, B };
}
/* Réduction de la fréquence d'échantillonnage à 8 000 Hz pour l'analyse.
 * Pourquoi : on n'analyse que jusqu'à 2 500 Hz. D'après Shannon, il suffit d'échantillonner
 * à plus de 2 × 2 500 = 5 000 Hz ; 8 000 Hz laisse de la marge (analyse possible jusqu'à
 * 4 000 Hz).
 * Avantages : 6 fois moins de mémoire qu'à 48 kHz, et une FFT de 8 192 points couvre
 * 1,024 s de signal, donc un pas en fréquence de 8000 / 8192 = 0,98 Hz (6 fois plus fin
 * qu'à 48 kHz avec la même FFT).
 * Les fichiers WAV passent par wav-decoder-v096.js (lecture par blocs) ; les autres
 * formats sont décodés par le navigateur puis rééchantillonnés par OfflineAudioContext,
 * qui applique lui-même un filtre anti-repliement. */
const ANALYSIS_SAMPLE_RATE = 8000;
async function decodeFile(file) {
  if (window.isWavFile?.(file) && window.decodeWavFile) {
    try {
      return await window.decodeWavFile(file, (p) =>
        setStatus(`Lecture de ${file.name} : ${Math.round(p * 100)} %`),
      );
    } catch (error) {
      console.warn("Lecture WAV par blocs impossible, décodage navigateur", error);
    }
  }
  const ab = await file.arrayBuffer();
  // v0.9.6 : décodage direct à 8 kHz (analyse limitée à 2 500 Hz).
  // Résolution FFT ×6 et mémoire ÷6 par rapport à 48 kHz.
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let sourceSampleRate = null;
  try {
    const probe = new (window.AudioContext || window.webkitAudioContext)();
    sourceSampleRate = probe.sampleRate;
    try {
      const original = await probe.decodeAudioData(ab.slice(0));
      sourceSampleRate = original.sampleRate;
      if (Offline) {
        const outLength = Math.max(
          1,
          Math.ceil((original.duration || original.length / original.sampleRate) * ANALYSIS_SAMPLE_RATE),
        );
        const offline = new Offline(1, outLength, ANALYSIS_SAMPLE_RATE);
        const src = offline.createBufferSource();
        src.buffer = original;
        // Le rééchantillonneur du navigateur applique son propre filtre anti-repliement.
        src.connect(offline.destination);
        src.start(0);
        const rendered = await offline.startRendering();
        const samples = new Float32Array(rendered.getChannelData(0));
        return {
          samples,
          sampleRate: ANALYSIS_SAMPLE_RATE,
          sourceSampleRate,
          duration: samples.length / ANALYSIS_SAMPLE_RATE,
        };
      }
      const channels = original.numberOfChannels,
        len = original.length,
        samples = new Float32Array(len);
      for (let c = 0; c < channels; c++) {
        const ch = original.getChannelData(c);
        for (let i = 0; i < len; i++) samples[i] += ch[i] / channels;
      }
      return {
        samples,
        sampleRate: original.sampleRate,
        sourceSampleRate,
        duration: len / original.sampleRate,
      };
    } finally {
      try {
        await probe.close();
      } catch (error) {
        console.warn("Fermeture AudioContext :", error);
      }
    }
  } catch (error) {
    throw error;
  }
}
async function addFiles(fileList) {
  const remaining = Math.max(0, STABILITY_CONFIG.maxFiles - records.length);
  const files = [...fileList].slice(0, remaining);
  if (!files.length) {
    setStatus("La limite de 10 fichiers est atteinte.", true);
    return;
  }
  setStatus(`Chargement de ${files.length} fichier(s)…`);
  let totalDuration = records.reduce(
    (sum, record) => sum + (Number(record.duration) || 0),
    0,
  );
  const rejected = [];
  for (const file of files) {
    const isWav = window.isWavFile?.(file),
      maxBytes = isWav ? STABILITY_CONFIG.maxWavFileBytes : STABILITY_CONFIG.maxFileBytes,
      maxDuration = isWav
        ? STABILITY_CONFIG.maxWavFileDurationSeconds
        : STABILITY_CONFIG.maxFileDurationSeconds;
    if (file.size > maxBytes) {
      rejected.push(`${file.name} (plus de ${Math.round(maxBytes / 1048576)} Mo)`);
      continue;
    }
    try {
      const decoded = await decodeFile(file);
      if (decoded.duration > maxDuration) {
        rejected.push(
          `${file.name} (plus de ${Math.round(maxDuration / 60)} min${isWav ? "" : " : convertissez-le en WAV pour les fichiers longs"})`,
        );
        continue;
      }
      if (
        totalDuration + decoded.duration >
        STABILITY_CONFIG.maxTotalDurationSeconds
      ) {
        rejected.push(
          `${file.name} (limite totale de ${Math.round(STABILITY_CONFIG.maxTotalDurationSeconds / 60)} min)`,
        );
        continue;
      }
      totalDuration += decoded.duration;
      records.push({
        id: nextId++,
        name: file.name,
        samples: decoded.samples,
        sampleRate: decoded.sampleRate,
        sourceSampleRate: decoded.sourceSampleRate || decoded.sampleRate,
        duration: decoded.duration,
        sourceBytes: file.size,
        speed: "",
        regime: "Non renseigné",
        spectrum: null,
        spectrogram: null,
        peaks: [],
      });
    } catch (error) {
      reportError(
        error,
        `Impossible de décoder : ${file.name}. Essayez un fichier WAV, M4A ou MP3 valide.`,
        "Décodage audio",
      );
    }
  }
  renderFileList();
  updateRecordSelector();
  $("analyze").disabled = records.length === 0;
  $("fullPdf").disabled = !records.some((r) => r.spectrum);
  $("saveRex").disabled = !records.some((r) => r.spectrum);
  $("saveRexSecondary").disabled = !records.some((r) => r.spectrum);
  updateMetrics("Fichiers chargés");
  setStatus(
    rejected.length
      ? `${records.length} fichier(s) chargé(s). Refusé(s) : ${rejected.join(", ")}`
      : `${records.length} fichier(s) chargé(s). Renseignez les vitesses puis lancez l’analyse.`,
    rejected.length > 0,
  );
  drawCurrent();
  drawAnalysisTheoryChart();
}
$("fileInput").addEventListener("change", (e) => addFiles(e.target.files));
const drop = $("drop");
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
  }),
);
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
function renderFileList() {
  const box = $("fileList");
  box.innerHTML = "";
  if (!records.length) {
    box.innerHTML =
      '<div class="small" style="padding:10px">Aucun fichier chargé.</div>';
    return;
  }
  records.forEach((record, index) => {
    const row = document.createElement("div");
    row.className = "file-row";
    const name = document.createElement("div");
    name.className = "file-name";
    name.title = record.name;
    name.textContent = record.name;
    const speed = document.createElement("input");
    speed.type = "number";
    speed.min = "0";
    speed.step = "1";
    speed.placeholder = "km/h";
    speed.value = record.speed;
    speed.addEventListener("change", () => {
      record.speed = speed.value;
      drawCurrent();
      drawAnalysisTheoryChart();
      renderRexMatches();
    });
    const regime = document.createElement("select");
    [
      "Non renseigné",
      "Traction",
      "Erre",
      "Freinage",
      "FRH",
      "Statique",
    ].forEach((value) => {
      const option = document.createElement("option");
      option.textContent = value;
      option.value = value;
      if (value === record.regime) option.selected = true;
      regime.appendChild(option);
    });
    regime.addEventListener("change", () => (record.regime = regime.value));
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = "×";
    remove.title = "Supprimer";
    remove.addEventListener("click", () => {
      releaseRecordResources(records[index]);
      records.splice(index, 1);
      selectedIndex = Math.min(selectedIndex, Math.max(0, records.length - 1));
      renderFileList();
      updateRecordSelector();
      refreshAnalysisOutputs();
      $("analyze").disabled = records.length === 0;
    });
    row.append(name, speed, regime, remove);
    box.appendChild(row);
  });
}
function updateRecordSelector() {
  const sel = $("recordSelector");
  sel.innerHTML = "";
  records.forEach((r, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = r.name;
    if (i === selectedIndex) o.selected = true;
    sel.appendChild(o);
  });
}
$("recordSelector").addEventListener("change", (e) => {
  selectedIndex = parseInt(e.target.value) || 0;
  drawCurrent();
});
/* Fenêtre de Hann.
 * Une FFT suppose que le morceau de signal se répète à l'infini. Si on coupe brutalement
 * le signal, les bords créent de faux sons dans tout le spectre (« fuite spectrale »).
 * La fenêtre de Hann atténue progressivement le début et la fin du morceau (forme en
 * cloche, de 0 à 1 puis 0), ce qui supprime presque toute la fuite. */
function hann(n, N) {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
}
/* Transformée de Fourier rapide (FFT, algorithme de Cooley-Tukey radix 2).
 * Elle décompose un morceau de N échantillons (N = puissance de 2) en N/2 fréquences.
 * La case k correspond à la fréquence k × fe / N (fe = fréquence d'échantillonnage).
 * Étapes : 1) réordonnancement des échantillons par « inversion des bits » de leur
 * indice ; 2) combinaison par « papillons » de taille 2, 4, 8 … N, chaque papillon
 * associant deux demi-transformées avec un facteur de rotation e^(-2iπk/len).
 * Coût : N × log2(N) opérations au lieu de N² pour un calcul direct. */
function fftReal(input) {
  const N = input.length,
    re = new Float64Array(N),
    im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = input[i];
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len,
      wr0 = Math.cos(ang),
      wi0 = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let wr = 1,
        wi = 0;
      for (let k = 0; k < len / 2; k++) {
        const uR = re[i + k],
          uI = im[i + k];
        const vR = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vI = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = uR + vR;
        im[i + k] = uI + vI;
        re[i + k + len / 2] = uR - vR;
        im[i + k + len / 2] = uI - vI;
        const nwr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = nwr;
      }
    }
  }
  return { re, im };
}
/* Spectre moyen d'un fichier (méthode de Welch).
 * 1. On découpe le signal en morceaux de N échantillons qui se chevauchent de 50 %
 *    (pas = N/2). Pour un long fichier on n'en garde qu'un sur « stride » (180 au plus)
 *    pour rester rapide.
 * 2. Pour chaque morceau : on retire la moyenne (composante continue), on applique la
 *    fenêtre de Hann, puis la FFT.
 * 3. On additionne les PUISSANCES (re² + im²) de tous les morceaux puis on divise par
 *    leur nombre : moyenner les puissances, et non les dB, donne un spectre stable où le
 *    bruit aléatoire est lissé et les sons permanents ressortent.
 * 4. Conversion en dB : 10 × log10(puissance). Version pondérée A en plus (dbA).
 * Résolution : pas en fréquence = fe / N (0,98 Hz pour 8 kHz et N = 8192). */
function computeSpectrum(record) {
  // v0.9.8 Rust : noyau WebAssembly si disponible, sinon le calcul JavaScript ci-dessous.
  if (window.TgvCore?.available && window.TgvCore.fits(record.samples.length)) {
    try {
      record.spectrum = window.TgvCore.welch(record.samples, parseInt($("fftSize").value), record.sampleRate, frequencyCalibrationFactorFor(record.sourceSampleRate || record.sampleRate));
      return;
    } catch (e) { console.warn("Noyau Rust (spectre) : repli sur le JavaScript", e); }
  }
  const N = parseInt($("fftSize").value),
    hop = N >> 1,
    bins = N >> 1,
    acc = new Float64Array(bins),
    total = Math.max(1, Math.floor((record.samples.length - N) / hop) + 1),
    stride = Math.max(1, Math.ceil(total / 180));
  let frames = 0;
  for (
    let fi = 0, start = 0;
    start + N <= record.samples.length;
    fi++, start += hop
  ) {
    if (fi % stride) continue;
    const frame = new Float64Array(N);
    let mean = 0;
    for (let i = 0; i < N; i++) mean += record.samples[start + i];
    mean /= N;
    for (let i = 0; i < N; i++)
      frame[i] = (record.samples[start + i] - mean) * hann(i, N);
    const F = fftReal(frame);
    for (let k = 0; k < bins; k++)
      acc[k] += (F.re[k] * F.re[k] + F.im[k] * F.im[k]) / (N * N);
    frames++;
  }
  const freqRaw = new Float64Array(bins),
    freq = new Float64Array(bins),
    db = new Float64Array(bins),
    dbA = new Float64Array(bins),
    factor = frequencyCalibrationFactorFor(record.sourceSampleRate || record.sampleRate);
  for (let k = 0; k < bins; k++) {
    freqRaw[k] = (k * record.sampleRate) / N;
    freq[k] = freqRaw[k] * factor;
    db[k] = 10 * Math.log10(acc[k] / Math.max(1, frames) + 1e-20);
    dbA[k] = db[k] + aWeightingCorrection(freq[k]);
  }
  record.spectrum = { freqRaw, freq, db, dbA };
}
/* Recherche des pics du spectre.
 * 1. Un pic est un point plus haut que ses 2 voisins de chaque côté.
 * 2. Son ÉMERGENCE = niveau du pic − niveau médian du voisinage (±40 Hz, en excluant le
 *    pic lui-même). La médiane représente le « bruit de fond » local sans être faussée
 *    par d'autres pics proches. Seuls les pics qui dépassent ce fond de plus de 3 dB
 *    sont gardés.
 * 3. Classement par émergence (par défaut) : un sifflement de niveau moyen mais très
 *    pur passe devant un bruit grave fort mais large. Le classement « par niveau »
 *    reste disponible (menu peakRanking).
 * 4. Deux pics retenus doivent être séparés d'au moins 8 Hz (ou d'une case FFT).
 * 5. Fréquence et niveau précisés par interpolation parabolique (interpolatePeak). */
function findPeaks(record, maxF = 2500) {
  const count = parseInt($("peakCount").value) || 10,
    s = record.spectrum,
    values = s?.db,
    candidates = [];
  if (!s || !values) {
    record.peaks = [];
    return;
  }
  const minSeparation = Math.max(
    8,
    record.sampleRate / (parseInt($("fftSize").value) || 8192),
  );
  for (let i = 2; i < s.freq.length - 2; i++) {
    const f = s.freq[i],
      v = values[i];
    if (f < 20 || f > Math.min(maxF, record.sampleRate / 2)) continue;
    if (
      v > values[i - 1] &&
      v > values[i + 1] &&
      v > values[i - 2] &&
      v > values[i + 2]
    ) {
      // v0.9.6 : émergence = niveau du pic − médiane du voisinage (±40 Hz),
      // insensible aux fréquences voisines et au balayage de la fréquence pendant l'enregistrement.
      const binHz = s.freq[1] - s.freq[0] || 1,
        halfWin = Math.max(30, Math.round(40 / binHz)),
        left = Math.max(0, i - halfWin),
        right = Math.min(values.length - 1, i + halfWin),
        around = [];
      for (let j = left; j <= right; j++)
        if (Math.abs(j - i) > 3) around.push(values[j]);
      around.sort((a, b) => a - b);
      const baseline = around[Math.floor(around.length / 2)];
      if (v - baseline > 3) {
        const refined = interpolatePeak(s.freq, values, i),
          rawV = refined.level;
        candidates.push({
          i,
          f: refined.frequency,
          v: rawV,
          rawV,
          aV: rawV + aWeightingCorrection(refined.frequency),
          prominence: v - baseline,
        });
      }
    }
  }
  // v0.9.6 : classement par émergence (par défaut) ou par niveau
  const byLevel = $("peakRanking")?.value === "level";
  candidates.sort((a, b) =>
    byLevel ? b.rawV - a.rawV : b.prominence - a.prominence,
  );
  const chosen = [];
  for (const peak of candidates) {
    if (chosen.every((other) => Math.abs(other.f - peak.f) > minSeparation)) {
      chosen.push(peak);
      if (chosen.length >= count) break;
    }
  }
  record.peaks = chosen;
}
/* Spectrogramme (fréquence en fonction du temps).
 * Même calcul que le spectre (fenêtre de Hann + FFT) mais sans moyenne : chaque morceau
 * donne une colonne de l'image. Environ 150 colonnes réparties sur toute la durée. */
function computeSpectrogram(record) {
  const N = parseInt($("fftSize").value),
    bins = N >> 1,
    target = 150,
    hop = Math.max(N / 4, Math.floor((record.samples.length - N) / target)),
    frames = [];
  for (let start = 0; start + N <= record.samples.length; start += hop) {
    const frame = new Float64Array(N);
    let mean = 0;
    for (let i = 0; i < N; i++) mean += record.samples[start + i];
    mean /= N;
    for (let i = 0; i < N; i++)
      frame[i] = (record.samples[start + i] - mean) * hann(i, N);
    const F = fftReal(frame),
      row = new Float32Array(bins);
    for (let k = 0; k < bins; k++)
      row[k] = 20 * Math.log10(Math.hypot(F.re[k], F.im[k]) / N + 1e-12);
    frames.push(row);
  }
  record.spectrogram = { frames, N, hop, mode: "raw" };
}
async function analyzeAll() {
  if (!records.length) return;
  $("analyze").disabled = true;
  $("peaksBody").innerHTML = "";
  $("commonBody").innerHTML = "";
  for (let i = 0; i < records.length; i++) {
    setStatus(
      `Analyse du fichier ${i + 1}/${records.length} : ${records[i].name}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    computeSpectrum(records[i]);
    findPeaks(records[i]);
  }
  renderPeakTable();
  renderCommonFrequencies();
  buildSummary();
  renderFrequencyGuidance();
  $("fullPdf").disabled = false;
  $("saveRex").disabled = false;
  $("saveRexSecondary").disabled = false;
  $("analyze").disabled = false;
  renderRexMatches();
  updateMetrics("Analyse terminée");
  setStatus(`Analyse terminée : ${records.length} fichier(s) comparé(s).`);
  drawCurrent();
  drawAnalysisTheoryChart();
}
$("analyze").addEventListener("click", analyzeAll);
/* Tolérance pour reconnaître une harmonique (2f, 3f…) : au moins 4 Hz, la tolérance
 * réglée par l'utilisateur, une case FFT, et 2 % de la fréquence visée (la vitesse varie
 * légèrement pendant un enregistrement, ce qui élargit les pics). */
function harmonicToleranceHz(targetFrequency) {
  const configured = parseFloat($("commonTolerance").value) || 8;
  return Math.max(4, configured, diagnosticBinWidth(), targetFrequency * 0.02);
}
/* Familles d'harmoniques.
 * Un son périodique non sinusoïdal produit des pics à f, 2f, 3f… Pour chaque pic de
 * base, on cherche les pics présents aux multiples 2 à 6 (jusqu'à 2 500 Hz). Un groupe de
 * pics en rapport entier indique une seule source (par exemple l'engrènement et ses
 * harmoniques) au lieu de plusieurs bruits indépendants. */
function buildHarmonicFamilies(record) {
  const peaks = [...record.peaks].sort((a, b) => a.f - b.f);
  const candidates = [];
  peaks.forEach((base) => {
    const members = [];
    for (let order = 2; order <= 6; order++) {
      const expected = base.f * order;
      if (expected > 2500) break;
      const tolerance = harmonicToleranceHz(expected);
      let best = null,
        bestDistance = Infinity;
      peaks.forEach((p) => {
        if (p === base) return;
        const distance = Math.abs(p.f - expected);
        if (distance <= tolerance && distance < bestDistance) {
          best = p;
          bestDistance = distance;
        }
      });
      if (best) {
        members.push({
          peak: best,
          order,
          expected,
          errorPct: (100 * bestDistance) / expected,
        });
      }
    }
    if (!members.length) return;
    const meanError =
      members.reduce((s, m) => s + m.errorPct, 0) / members.length;
    const hasLowOrder = members.some((m) => m.order === 2 || m.order === 3);
    const score =
      members.length * 100 +
      members.reduce((s, m) => s + (7 - m.order) * 12, 0) +
      (hasLowOrder ? 35 : 0) -
      meanError * 10;
    let confidence = "Faible";
    if (members.length >= 2 && hasLowOrder && meanError <= 1.5)
      confidence = "Forte";
    else if (
      members.length >= 2 ||
      (members.some((m) => m.order === 2) && meanError <= 1.0)
    )
      confidence = "Moyenne";
    candidates.push({ base, members, score, confidence, meanError });
  });
  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  const assignedHarmonics = new Set();
  const selectedBases = new Set();
  for (const family of candidates) {
    if (assignedHarmonics.has(family.base)) continue;
    const freeMembers = family.members.filter(
      (m) => !assignedHarmonics.has(m.peak) && !selectedBases.has(m.peak),
    );
    if (!freeMembers.length) continue;
    selected.push({ ...family, members: freeMembers });
    selectedBases.add(family.base);
    freeMembers.forEach((m) => assignedHarmonics.add(m.peak));
  }
  return selected;
}
function classifyRecordPeaks(record) {
  const families = buildHarmonicFamilies(record);
  const classifications = new Map();
  record.peaks.forEach((p, index) => {
    classifications.set(p, {
      type:
        index === 0
          ? $("peakRanking")?.value === "level"
            ? "Pic dominant"
            : "Pic le plus émergent"
          : "Pic spectral",
      family: "",
      orientation:
        index === 0
          ? `${$("peakRanking")?.value === "level" ? "Pic de niveau le plus élevé" : "Pic le plus émergent du bruit de fond"} : suivre ${p.f.toFixed(1)} Hz si aucune fondamentale plus crédible n’est identifiée.`
          : "Pic secondaire : surveiller son évolution avec la vitesse et les interventions.",
      role: "peak",
      familyBase: null,
      order: null,
      confidence: null,
    });
  });
  families.forEach((family) => {
    const baseInfo = classifications.get(family.base);
    if (!baseInfo) return;
    const probable =
      family.confidence === "Forte" || family.confidence === "Moyenne";
    baseInfo.type = probable
      ? "Fondamentale probable"
      : "Fondamentale possible";
    baseInfo.family = `Famille ${family.base.f.toFixed(1)} Hz — ${family.members.map((m) => "×" + m.order).join(", ")} — confiance ${family.confidence.toLowerCase()}`;
    baseInfo.orientation = `Fréquence de travail : ${family.base.f.toFixed(1)} Hz. Suivre cette fondamentale et vérifier que ses harmoniques évoluent ou disparaissent avec elle.`;
    baseInfo.role = "fundamental";
    baseInfo.familyBase = family.base.f;
    baseInfo.confidence = family.confidence;
    family.members.forEach((member) => {
      const info = classifications.get(member.peak);
      if (!info) return;
      info.type = `Harmonique possible ×${member.order}`;
      info.family = `de ${family.base.f.toFixed(1)} Hz — écart ${member.errorPct.toFixed(2)} %`;
      info.orientation = `Ne pas cibler ${member.peak.f.toFixed(1)} Hz seule : travailler d’abord sur la fondamentale ${family.base.f.toFixed(1)} Hz.`;
      info.role = "harmonic";
      info.familyBase = family.base.f;
      info.order = member.order;
      info.confidence = family.confidence;
    });
  });
  return { families, classifications };
}
function peakClassification(record, p) {
  return (
    classifyRecordPeaks(record).classifications.get(p) || {
      type: "Pic spectral",
      family: "",
      orientation: "À surveiller.",
      role: "peak",
    }
  );
}
function harmonicText(record, p) {
  const info = peakClassification(record, p);
  return info.type + (info.family ? ` — ${info.family}` : "");
}
function bestWorkingFrequency(record) {
  const analysis = classifyRecordPeaks(record);
  const families = [...analysis.families].sort((a, b) => b.score - a.score);
  const dominant = record.peaks[0] || null;
  if (families.length) {
    const best = families[0];
    return {
      primary: best.base.f,
      confidence: best.confidence,
      reason: `famille harmonique ${best.base.f.toFixed(1)} Hz avec ${best.members.length} harmonique(s) détectée(s) (${best.members.map((m) => "×" + m.order).join(", ")})`,
      dominant: dominant ? dominant.f : null,
      dominantIsPrimary: dominant === best.base,
      secondaryFamilies: families.slice(1, 3),
    };
  }
  return {
    primary: dominant ? dominant.f : null,
    confidence: "Faible",
    reason: dominant
      ? "aucune famille harmonique suffisamment structurée ; orientation sur le pic dominant"
      : "aucun pic détecté",
    dominant: dominant ? dominant.f : null,
    dominantIsPrimary: true,
    secondaryFamilies: [],
  };
}
function renderFrequencyGuidance() {
  const box = $("frequencyGuidance");
  if (!box) return;
  if (!records.some((record) => record.spectrum)) {
    box.textContent =
      "Lancez une analyse pour identifier les familles fréquentielles.";
    return;
  }
  const cfg = getTransmissionConfig();
  let text = `Diagnostic mécanique brut ; affichage actuel : ${activeModeName()} (${activeLevelUnit()}).\n${weightingDisclaimer()}\nDeux essieux : E1 Ø${cfg.diameter1.toFixed(0)} mm ; E2 Ø${cfg.diameter2.toFixed(0)} mm. Sous 60 Hz, la pondération A n’écarte aucune fréquence du diagnostic.\n\n`;
  records.forEach((record) => {
    const work = bestWorkingFrequency(record);
    text += `${record.name}\n`;
    if (work.primary === null) {
      text += "Aucune fréquence de travail proposée.\n\n";
      return;
    }
    text += `→ Fréquence de travail brute : ${work.primary.toFixed(2)} Hz — confiance ${work.confidence.toLowerCase()}.\nMotif : ${work.reason}.\n`;
    const speed = parseFloat(record.speed);
    if (Number.isFinite(speed)) {
      const assignment = axleAssignment(
        work.primary,
        speed,
        cfg.reference,
        cfg,
      );
      if (assignment)
        text += assignment.ambiguous
          ? `→ E1/E2 indéterminé : écart théorique ${assignment.separation.toFixed(2)} Hz, résolution FFT ${assignment.resolution.toFixed(2)} Hz. Examiner les harmoniques et engrènements.\n`
          : `→ Courbe théorique la plus proche : ${assignment.best.id} Ø${assignment.best.diameter.toFixed(0)} mm (${assignment.best.frequency.toFixed(2)} Hz).\n`;
    }
    if (work.secondaryFamilies.length)
      text += `→ Autres fondamentales possibles : ${work.secondaryFamilies.map((family) => `${family.base.f.toFixed(2)} Hz (${family.confidence.toLowerCase()})`).join(", ")}.\n`;
    text +=
      "Conseil : confirmer sur plusieurs vitesses/régimes et après intervention.\n\n";
  });
  text +=
    "La pondération A sert uniquement à la représentation perceptive et au rapport des niveaux ; elle ne change pas le diagnostic mécanique.";
  box.textContent = text.trim();
}
function renderPeakTable() {
  const body = $("peaksBody");
  body.innerHTML = "";
  records.forEach((record) => {
    const analysis = classifyRecordPeaks(record);
    record.peaks.forEach((peak, index) => {
      const info = analysis.classifications.get(peak),
        tr = document.createElement("tr");
      tr.innerHTML = `<td title="${escapeHtml(record.name)}">${escapeHtml(shortName(record.name, 34))}</td><td>${index + 1}</td><td>${peak.f.toFixed(2)} Hz</td><td>${activeModeName()} (affichage)</td><td>${peakDisplayedLevel(peak).toFixed(1)} ${activeLevelUnit()}</td><td>${peak.rawV.toFixed(1)} dB relatif</td><td>${peak.aV.toFixed(1)} dB(A) relatif</td><td>${escapeHtml(info.type)}</td><td>${escapeHtml(info.family || "—")}</td><td>${escapeHtml(info.orientation)}</td>`;
      body.appendChild(tr);
    });
  });
  renderFrequencyGuidance();
}
function clusterCommonPeaks() {
  const tolerance = parseFloat($("commonTolerance").value) || 8;
  const clusters = [];
  records.forEach((record, recordIndex) => {
    record.peaks.forEach((p) => {
      let best = null,
        bestDistance = Infinity;
      clusters.forEach((c) => {
        const d = Math.abs(c.mean - p.f);
        if (
          d <= tolerance &&
          d < bestDistance &&
          !c.recordIndexes.has(recordIndex)
        ) {
          best = c;
          bestDistance = d;
        }
      });
      if (best) {
        best.values.push(p.f);
        best.recordIndexes.add(recordIndex);
        best.names.push(record.name);
        best.mean = best.values.reduce((a, b) => a + b, 0) / best.values.length;
      } else {
        clusters.push({
          mean: p.f,
          values: [p.f],
          recordIndexes: new Set([recordIndex]),
          names: [record.name],
        });
      }
    });
  });
  return clusters
    .filter((c) => c.recordIndexes.size >= 2)
    .sort(
      (a, b) => b.recordIndexes.size - a.recordIndexes.size || a.mean - b.mean,
    );
}
function renderCommonFrequencies() {
  const clusters = clusterCommonPeaks(),
    body = $("commonBody");
  body.innerHTML = "";
  if (!clusters.length) {
    $("commonInfo").textContent =
      "Aucune fréquence commune détectée dans les principaux pics.";
    $("metricCommon").textContent = "0";
    return;
  }
  const all = clusters.filter((c) => c.recordIndexes.size === records.length);
  $("commonInfo").textContent =
    `${clusters.length} groupe(s) de fréquences présents dans au moins deux fichiers, dont ${all.length} présent(s) dans tous les fichiers.`;
  $("metricCommon").textContent = all.length;
  clusters.forEach((c) => {
    const tr = document.createElement("tr");
    const names = [...new Set(c.names)].map((n) => shortName(n, 28)).join(", ");
    tr.innerHTML = `<td>${c.mean.toFixed(1)} Hz</td><td>${c.recordIndexes.size}/${records.length}</td><td>${escapeHtml(names)}</td>`;
    body.appendChild(tr);
  });
}
function buildSummary() {
  const clusters = clusterCommonPeaks(),
    commonAll = clusters.filter(
      (cluster) => cluster.recordIndexes.size === records.length,
    ),
    cfg = getTransmissionConfig();
  let text = `Rame : ${$("rame").value || "non renseignée"} — Motrice : ${$("motrice").value || "non renseignée"}\nTrain : ${$("train").value || "non renseigné"} — Date : ${$("date").value || "non renseignée"}\nDiagnostic mécanique calculé sur le spectre brut. Affichage des niveaux : ${activeModeName()} — ${activeLevelUnit()}.\n${weightingDisclaimer()}\nDeux essieux théoriques : E1 Ø${cfg.diameter1.toFixed(0)} mm (cyan continu) ; E2 Ø${cfg.diameter2.toFixed(0)} mm (orange pointillé).\n${records.length} bandes sonores ont été analysées simultanément.\n`;
  text += commonAll.length
    ? `Fréquences brutes retrouvées dans tous les fichiers : ${commonAll.map((cluster) => cluster.mean.toFixed(2) + " Hz").join(", ")}.\n`
    : "Aucune fréquence ne figure parmi les principaux pics bruts de tous les fichiers.\n";
  records.forEach((record) => {
    const analysis = classifyRecordPeaks(record),
      work = bestWorkingFrequency(record),
      families = analysis.families.map(
        (family) =>
          `${family.base.f.toFixed(2)} Hz (${family.confidence.toLowerCase()}, ${family.members.map((member) => "H" + member.order).join("/")})`,
      );
    text += `\n${record.name}\nVitesse : ${record.speed || "non renseignée"} km/h — Régime : ${record.regime}.\n`;
    if (record.peaks.length) {
      const peak = record.peaks[0];
      text += `Pic dominant brut : ${peak.f.toFixed(2)} Hz — brut ${peak.rawV.toFixed(1)} dB relatif ; pondéré ${peak.aV.toFixed(1)} dB(A) relatif.\n`;
    } else text += "Pic dominant : aucun.\n";
    text += `Fondamentales détectées sur le brut : ${families.length ? families.join(", ") : "aucune famille harmonique structurée"}.\n`;
    if (work.primary !== null) {
      text += `Fréquence de travail prioritaire : ${work.primary.toFixed(2)} Hz — confiance ${work.confidence.toLowerCase()}.\n`;
      const speed = parseFloat(record.speed);
      if (Number.isFinite(speed)) {
        const assignment = axleAssignment(
          work.primary,
          speed,
          cfg.reference,
          cfg,
        );
        if (assignment)
          text += assignment.ambiguous
            ? `Attribution essieu : E1/E2 indéterminée, séparation théorique ${assignment.separation.toFixed(2)} Hz inférieure à la résolution FFT ${assignment.resolution.toFixed(2)} Hz.\n`
            : `Attribution théorique la plus proche : ${assignment.best.id} Ø${assignment.best.diameter.toFixed(0)} mm, écart ${assignment.best.delta.toFixed(2)} Hz.\n`;
      }
    }
  });
  text +=
    "\nInterprétation en développement : la pondération A n’influence ni les pics ni la fréquence de travail. Confirmer l’essieu par les harmoniques, les engrènements, la variation de vitesse et le REX.";
  if ($("notes").value.trim())
    text += `\n\nObservations générales : ${$("notes").value.trim()}`;
  $("summary").textContent = text;
}
function spectrumRange(record, maxF, normalized) {
  const s = record.spectrum,
    values = activeSpectrumDb(record);
  let max = -Infinity,
    min = Infinity;
  for (let i = 0; i < s.freq.length && s.freq[i] <= maxF; i++)
    if (s.freq[i] >= Math.max(20, hideBelowHz())) {
      min = Math.min(min, values[i]);
      max = Math.max(max, values[i]);
    }
  const offset = normalized ? max : 0;
  return { min: min - offset, max: max - offset, offset };
}
function spectrumAxesRange(
  ctxLocal,
  w,
  h,
  title,
  xlabel,
  ylabel,
  xmin,
  xmax,
  ymin,
  ymax,
) {
  const L = 68,
    R = 22,
    T = 38,
    B = 50;
  ctxLocal.strokeStyle = "#3C3732";
  ctxLocal.lineWidth = 1;
  ctxLocal.beginPath();
  ctxLocal.moveTo(L, T);
  ctxLocal.lineTo(L, h - B);
  ctxLocal.lineTo(w - R, h - B);
  ctxLocal.stroke();
  ctxLocal.fillStyle = "#3C3732";
  ctxLocal.font = "14px Segoe UI";
  ctxLocal.fillText(title, L, T - 14);
  ctxLocal.font = "12px Segoe UI";
  ctxLocal.fillText(xlabel, w / 2 - 40, h - 12);
  ctxLocal.save();
  ctxLocal.translate(17, h / 2 + 40);
  ctxLocal.rotate(-Math.PI / 2);
  ctxLocal.fillText(ylabel, 0, 0);
  ctxLocal.restore();
  for (let i = 0; i <= 5; i++) {
    const x = L + ((w - L - R) * i) / 5,
      val = xmin + ((xmax - xmin) * i) / 5;
    ctxLocal.fillStyle = "#4D4F53";
    ctxLocal.fillText(val.toFixed(0), x - 13, h - B + 18);
    ctxLocal.strokeStyle = "#E1E1E1";
    ctxLocal.beginPath();
    ctxLocal.moveTo(x, T);
    ctxLocal.lineTo(x, h - B);
    ctxLocal.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    const y = T + ((h - T - B) * i) / 5,
      val = ymax - ((ymax - ymin) * i) / 5;
    ctxLocal.fillStyle = "#4D4F53";
    ctxLocal.fillText(val.toFixed(0), 7, y + 4);
    ctxLocal.strokeStyle = "#E1E1E1";
    ctxLocal.beginPath();
    ctxLocal.moveTo(L, y);
    ctxLocal.lineTo(w - R, y);
    ctxLocal.stroke();
  }
  return { w, h, L, R, T, B, xMin: xmin, xMax: xmax };
}
function spectrumWindowRange(record, minF, maxF, normalized) {
  const values = activeSpectrumDb(record),
    freq = record.spectrum.freq;
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] < minF) continue;
    if (freq[i] > maxF) break;
    const value = values[i];
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = -80;
    max = 0;
  }
  const offset = normalized ? max : 0;
  return { min: min - offset, max: max - offset, offset };
}
function updateSpectrumZoomUi(text = "Vue complète : 20–2 500 Hz") {
  const label = $("spectrumZoomState");
  if (label) label.textContent = text;
}
function resetSpectrumZoom() {
  spectrumZoomRange = null;
  updateSpectrumZoomUi();
  drawCurrent();
}
function zoomSpectrumToTheory() {
  const record = records[selectedIndex];
  if (!record?.spectrum) {
    updateSpectrumZoomUi("Analysez d’abord le fichier.");
    return;
  }
  const cfg = getTransmissionConfig(),
    recordSpeed = parseFloat(record.speed),
    speed = Number.isFinite(recordSpeed) && recordSpeed > 0 ? recordSpeed : cfg.previewSpeed,
    f1 = transmissionFrequencies(speed, cfg.diameter1)?.[cfg.reference],
    f2 = transmissionFrequencies(speed, cfg.diameter2)?.[cfg.reference];
  if (!Number.isFinite(f1) || !Number.isFinite(f2)) {
    updateSpectrumZoomUi("Repères théoriques indisponibles.");
    return;
  }
  const candidates = (record.peaks || []).filter(
      (peak) => peak.f >= 20 && peak.f <= 2500,
    ),
    nearest = candidates
      .slice()
      .sort(
        (a, b) =>
          Math.min(Math.abs(a.f - f1), Math.abs(a.f - f2)) -
          Math.min(Math.abs(b.f - f1), Math.abs(b.f - f2)),
      )[0],
    values = [f1, f2];
  if (nearest) values.push(nearest.f);
  let min = Math.min(...values),
    max = Math.max(...values),
    span = Math.max(1, max - min),
    margin = Math.max(35, span * 0.9);
  min = Math.max(20, min - margin);
  max = Math.min(2500, max + margin);
  if (max - min < 120) {
    const center = (min + max) / 2;
    min = Math.max(20, center - 60);
    max = Math.min(2500, center + 60);
  }
  spectrumZoomRange = { min, max };
  updateSpectrumZoomUi(
    `Réglage ${speed.toFixed(0)} km/h — zoom ${min.toFixed(0)}–${max.toFixed(0)} Hz${nearest ? ` — pic mesuré ${nearest.f.toFixed(1)} Hz` : ""}`,
  );
  drawCurrent();
}
function annotateSpectrumPeaks(
  ctxLocal,
  a,
  record,
  maxF,
  ymin,
  ymax,
  offset,
  color,
  maxLabels = 3,
) {
  if (!record?.peaks?.length) return;
  const minF = Number.isFinite(a.xMin) ? a.xMin : 20,
    maxVisible = Number.isFinite(a.xMax) ? a.xMax : maxF,
    visible = record.peaks
      .filter((p) => p.f >= minF && p.f <= maxVisible)
      .slice(0, Math.min(3, maxLabels));
  ctxLocal.font = "600 11px Segoe UI";
  ctxLocal.lineWidth = 1;
  visible.forEach((p, index) => {
    const value = peakDisplayedLevel(p) - offset,
      x = a.L + ((p.f - minF) / (maxVisible - minF)) * (a.w - a.L - a.R),
      y = a.T + ((ymax - value) / (ymax - ymin)) * (a.h - a.T - a.B),
      label = `Mesuré ${p.f.toFixed(1)} Hz`,
      textWidth = ctxLocal.measureText(label).width,
      labelY = a.T + 20 + index * 18,
      labelX = Math.max(
        a.L + 4,
        Math.min(x - textWidth / 2, a.w - a.R - textWidth - 4),
      );
    ctxLocal.strokeStyle = "rgba(60,55,50,.55)";
    ctxLocal.beginPath();
    ctxLocal.moveTo(x, y - 4);
    ctxLocal.lineTo(x, labelY + 4);
    ctxLocal.stroke();
    ctxLocal.fillStyle = "#CD0037";
    ctxLocal.beginPath();
    ctxLocal.arc(x, y, 4, 0, Math.PI * 2);
    ctxLocal.fill();
    ctxLocal.fillStyle = "#CD0037";
    ctxLocal.fillText(label, labelX, labelY);
  });
}
function annotateCommonFrequencies(ctxLocal, a, maxF) {
  const clusters = clusterCommonPeaks().slice(0, 8);
  if (!clusters.length) return;
  ctxLocal.font = "11px Segoe UI";
  ctxLocal.lineWidth = 1;
  clusters.forEach((c, index) => {
    if (c.mean < 20 || c.mean > maxF) return;
    const x = a.L + (c.mean / maxF) * (a.w - a.L - a.R);
    const label = `${c.mean.toFixed(1)} Hz`;
    const textWidth = ctxLocal.measureText(label).width;
    const labelY = a.T + 18 + (index % 3) * 15;
    const labelX = Math.max(
      a.L + 3,
      Math.min(x - textWidth / 2, a.w - a.R - textWidth - 3),
    );
    ctxLocal.strokeStyle = "rgba(205,0,55,.65)";
    ctxLocal.setLineDash([5, 4]);
    ctxLocal.beginPath();
    ctxLocal.moveTo(x, a.T);
    ctxLocal.lineTo(x, a.h - a.B);
    ctxLocal.stroke();
    ctxLocal.setLineDash([]);
    ctxLocal.fillStyle = "#CD0037";
    ctxLocal.fillText(label, labelX, labelY);
  });
}
function drawComparisonOn(ctxLocal, w, h) {
  const ready = records.filter((r) => r.spectrum);
  if (!ready.length) return;
  ctxLocal.fillStyle = "#FFFFFF";
  ctxLocal.fillRect(0, 0, w, h);
  const maxF = 2500,
    normalized = $("normalize").checked;
  let ymin = Infinity,
    ymax = -Infinity;
  const ranges = ready.map((r) => {
    const q = spectrumRange(r, maxF, normalized);
    ymin = Math.min(ymin, q.min);
    ymax = Math.max(ymax, q.max);
    return q;
  });
  const overlayRaw = aWeightingEnabled() && document.getElementById("showRawOverlay")?.checked;
  if (overlayRaw)
    ready.forEach((r, idx) => {
      const s = r.spectrum, off = levelCalOffset();
      for (let i = 0; i < s.freq.length && s.freq[i] <= maxF; i++)
        if (s.freq[i] >= Math.max(20, hideBelowHz())) {
          const v = s.db[i] + off - ranges[idx].offset;
          if (Number.isFinite(v)) { ymin = Math.min(ymin, v); ymax = Math.max(ymax, v); }
        }
    });
  ymin = Math.floor((ymin - 5) / 10) * 10;
  ymax = normalized ? Math.max(5, Math.ceil((ymax + 2) / 5) * 5) : Math.ceil((ymax + 5) / 10) * 10;
  const a = axes(
    ctxLocal,
    w,
    h,
    `Comparaison des spectres ${activeModeName()}s 0–2 500 Hz`,
    "Fréquence (Hz)",
    normalized
      ? `Niveau ${activeModeName()} normalisé (${activeLevelUnit()})`
      : `Niveau ${activeLevelUnit()}`,
    maxF,
    ymin,
    ymax,
  );
  if (overlayRaw)
    ready.forEach((record, index) => {
      const s = record.spectrum, range = ranges[index], off = levelCalOffset();
      ctxLocal.save();
      ctxLocal.strokeStyle = "#9AA5AD"; ctxLocal.globalAlpha = 0.8; ctxLocal.lineWidth = 1; ctxLocal.setLineDash([4, 3]);
      ctxLocal.beginPath();
      let st = false;
      for (let i = 0; i < s.freq.length; i++) {
        const f = s.freq[i];
        if (f < Math.max(20, hideBelowHz())) continue;
        if (f > maxF) break;
        const value = s.db[i] + off - range.offset;
        const x = a.L + (f / maxF) * (a.w - a.L - a.R), y = a.T + ((ymax - value) / (ymax - ymin)) * (a.h - a.T - a.B);
        if (!st) { ctxLocal.moveTo(x, y); st = true; } else ctxLocal.lineTo(x, y);
      }
      ctxLocal.stroke();
      ctxLocal.restore();
    });
  ready.forEach((record, index) => {
    const s = record.spectrum,
      values = activeSpectrumDb(record),
      range = ranges[index];
    ctxLocal.strokeStyle = colors[index % colors.length];
    ctxLocal.lineWidth = 1.35;
    ctxLocal.beginPath();
    let started = false;
    for (let i = 0; i < s.freq.length; i++) {
      const f = s.freq[i];
      if (f < Math.max(20, hideBelowHz())) continue;
      if (f > maxF) break;
      const value = values[i] - range.offset;
      const x = a.L + (f / maxF) * (a.w - a.L - a.R);
      const y = a.T + ((ymax - value) / (ymax - ymin)) * (a.h - a.T - a.B);
      if (!started) {
        ctxLocal.moveTo(x, y);
        started = true;
      } else ctxLocal.lineTo(x, y);
    }
    ctxLocal.stroke();
  });
  annotateCommonFrequencies(ctxLocal, a, maxF);
}
function drawIndividualSpectrumOn(ctxLocal, w, h, record) {
  ctxLocal.fillStyle = "#FFFFFF";
  ctxLocal.fillRect(0, 0, w, h);
  if (!record?.spectrum) return;
  const minF = spectrumZoomRange?.min ?? 20,
    maxF = spectrumZoomRange?.max ?? 2500,
    normalized = $("normalize").checked,
    range = spectrumWindowRange(record, minF, maxF, normalized),
    ymin = Math.floor((range.min - 5) / 10) * 10,
    ymax = normalized ? 5 : Math.ceil((range.max + 5) / 10) * 10,
    titlePrefix = spectrumZoomRange ? "Zoom spectre" : "Spectre",
    a = spectrumAxesRange(
      ctxLocal,
      w,
      h,
      `${titlePrefix} ${activeModeName()} — ${shortName(record.name, 65)}`,
      "Fréquence (Hz)",
      normalized
        ? `Niveau normalisé (${activeLevelUnit()})`
        : `Niveau ${activeLevelUnit()}`,
      minF,
      maxF,
      ymin,
      ymax,
    ),
    color = colors[records.indexOf(record) % colors.length],
    values = activeSpectrumDb(record);
  ctxLocal.strokeStyle = color;
  ctxLocal.lineWidth = 1.6;
  ctxLocal.beginPath();
  let started = false;
  for (let i = 0; i < record.spectrum.freq.length; i++) {
    const f = record.spectrum.freq[i];
    if (f < minF) continue;
    if (f > maxF) break;
    const value = values[i] - range.offset,
      x = a.L + ((f - minF) / (maxF - minF)) * (a.w - a.L - a.R),
      y = a.T + ((ymax - value) / (ymax - ymin)) * (a.h - a.T - a.B);
    if (!started) {
      ctxLocal.moveTo(x, y);
      started = true;
    } else ctxLocal.lineTo(x, y);
  }
  ctxLocal.stroke();
  drawTransmissionSpectrumMarkers(ctxLocal, a, maxF, parseFloat(record.speed));
  annotateSpectrumPeaks(
    ctxLocal,
    a,
    record,
    maxF,
    ymin,
    ymax,
    range.offset,
    color,
    3,
  );
}
function drawWaveOn(ctxLocal, w, h, record) {
  ctxLocal.fillStyle = "#FFFFFF";
  ctxLocal.fillRect(0, 0, w, h);
  if (!record) return;
  const a = axes(
    ctxLocal,
    w,
    h,
    `Forme d’onde — ${shortName(record.name, 65)}`,
    "Temps (s)",
    "Amplitude",
    record.duration,
    -1,
    1,
  );
  ctxLocal.strokeStyle = colors[records.indexOf(record) % colors.length];
  ctxLocal.lineWidth = 1;
  ctxLocal.beginPath();
  const points = Math.floor(a.w - a.L - a.R);
  for (let x = 0; x < points; x++) {
    const s0 = Math.floor((x * record.samples.length) / points),
      s1 = Math.floor(((x + 1) * record.samples.length) / points);
    let min = 1,
      max = -1;
    for (let i = s0; i < s1; i++) {
      if (record.samples[i] < min) min = record.samples[i];
      if (record.samples[i] > max) max = record.samples[i];
    }
    const px = a.L + x;
    const yMax = a.T + ((1 - max) * (a.h - a.T - a.B)) / 2;
    const yMin = a.T + ((1 - min) * (a.h - a.T - a.B)) / 2;
    ctxLocal.moveTo(px, yMax);
    ctxLocal.lineTo(px, yMin);
  }
  ctxLocal.stroke();
}
function vividSpectrogramColor(value, min, max) {
  const span = Math.max(1, max - min),
    t = Math.max(0, Math.min(1, (value - min) / span));
  const stops = [
    [0, [0, 2, 8]],
    [0.12, [0, 8, 35]],
    [0.28, [25, 0, 95]],
    [0.44, [120, 0, 170]],
    [0.6, [235, 0, 95]],
    [0.74, [255, 70, 0]],
    [0.88, [255, 225, 0]],
    [1, [255, 255, 245]],
  ];
  for (let i = 1; i < stops.length; i++)
    if (t <= stops[i][0]) {
      const [p0, c0] = stops[i - 1],
        [p1, c1] = stops[i],
        u = (t - p0) / (p1 - p0);
      const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * u));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  return "rgb(255,255,255)";
}
function drawSpectrogramScale(ctxLocal, a, min, max) {
  const width = Math.min(155, a.w - a.L - a.R - 12),
    height = 8,
    x = a.w - a.R - width - 6,
    y = a.T + 6;
  if (width < 70) return;
  for (let i = 0; i < width; i++) {
    ctxLocal.fillStyle = vividSpectrogramColor(
      min + ((max - min) * i) / (width - 1),
      min,
      max,
    );
    ctxLocal.fillRect(x + i, y, 1, height);
  }
  ctxLocal.strokeStyle = "rgba(255,255,255,.8)";
  ctxLocal.strokeRect(x - 0.5, y - 0.5, width + 1, height + 1);
  ctxLocal.font = "9px Segoe UI";
  ctxLocal.fillStyle = "#FFFFFF";
  ctxLocal.fillText("faible", x, y + 19);
  const label = "niveau élevé";
  ctxLocal.fillText(
    label,
    x + width - ctxLocal.measureText(label).width,
    y + 19,
  );
}
/* Diamètre de roue équivalent.
 * Toutes les fréquences de la transmission sont inversement proportionnelles au diamètre
 * de roue (à vitesse égale, une petite roue tourne plus vite). On calcule la fréquence
 * théorique pour une roue de 1 000 mm, puis :
 *   diamètre = 1000 × f_théorique(1000 mm) / f_mesurée.
 * Un diamètre équivalent hors de la plage 850–924 mm (retrait – neuf) signale une erreur de vitesse, un
 * mauvais organe supposé ou une harmonique. */
function estimateWheelDiameter(measuredFrequency, speedKmh, key) {
  if (
    !Number.isFinite(measuredFrequency) ||
    measuredFrequency <= 0 ||
    !Number.isFinite(speedKmh) ||
    speedKmh <= 0
  )
    return null;
  const referenceDiameter = 1000,
    theoretical = transmissionFrequencies(speedKmh, referenceDiameter)?.[key];
  return Number.isFinite(theoretical)
    ? (referenceDiameter * theoretical) / measuredFrequency
    : null;
}
function colorMap(value, min, max) {
  return vividSpectrogramColor(value, min, max);
}
function drawSpectrogramOn(ctxLocal, w, h, record) {
  ctxLocal.fillStyle = "#FFFFFF";
  ctxLocal.fillRect(0, 0, w, h);
  if (!record) return;
  const requestedN = parseInt($("fftSize").value);
  if (!record.spectrogram || record.spectrogram.N !== requestedN)
    computeSpectrogram(record);
  const maxF = 2500,
    duration = record.duration,
    a = axes(
      ctxLocal,
      w,
      h,
      `Spectrogramme ${activeModeName()} — ${shortName(record.name, 65)}`,
      "Temps (s)",
      "Fréquence (Hz)",
      duration,
      0,
      maxF,
    ),
    sp = record.spectrogram,
    frames = sp.frames,
    N = sp.N,
    binMax = Math.min(N / 2 - 1, Math.floor((maxF * N) / record.sampleRate));
  let min = Infinity,
    max = -Infinity;
  const valueAt = (row, k) =>
    row[k] +
    (aWeightingEnabled()
      ? aWeightingCorrection(
          ((k * record.sampleRate) / N) *
            frequencyCalibrationFactorFor(record.sourceSampleRate || record.sampleRate),
        )
      : 0);
  for (const row of frames)
    for (let k = 1; k <= binMax; k++) {
      const value = valueAt(row, k);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  min = Math.max(min, max - 72);
  ctxLocal.fillStyle = "#3C3732";
  ctxLocal.fillRect(a.L, a.T, a.w - a.L - a.R, a.h - a.T - a.B);
  const pixelWidth = (a.w - a.L - a.R) / Math.max(1, frames.length);
  for (let x = 0; x < frames.length; x++) {
    const row = frames[x];
    for (let k = 1; k <= binMax; k++) {
      const frequency =
          ((k * record.sampleRate) / N) *
          frequencyCalibrationFactorFor(record.sourceSampleRate || record.sampleRate),
        y = a.T + (1 - frequency / maxF) * (a.h - a.T - a.B),
        y2 =
          a.T +
          (1 -
            (frequency +
              (record.sampleRate / N) *
                frequencyCalibrationFactorFor(record.sourceSampleRate || record.sampleRate)) /
              maxF) *
            (a.h - a.T - a.B);
      ctxLocal.fillStyle = vividSpectrogramColor(valueAt(row, k), min, max);
      ctxLocal.fillRect(
        a.L + x * pixelWidth,
        y2,
        pixelWidth + 1,
        Math.max(1, y - y2 + 1),
      );
    }
  }
  drawSpectrogramScale(ctxLocal, a, min, max);
  const enteredSpeed = parseFloat(record.speed),
    isPreview = !Number.isFinite(enteredSpeed) || enteredSpeed <= 0,
    speed = isPreview ? getTransmissionConfig().previewSpeed : enteredSpeed;
  drawDualAxleSpectrogramOverlay(ctxLocal, a, maxF, speed, isPreview);
}
function drawComparison() {
  resizeCanvas();
  clearCanvas();
  if (!records.some((r) => r.spectrum)) return;
  drawComparisonOn(ctx, canvas.clientWidth, canvas.clientHeight);
  renderLegend(records.filter((r) => r.spectrum));
}
function drawIndividualSpectrum(record) {
  resizeCanvas();
  clearCanvas();
  if (!record || !record.spectrum) return;
  drawIndividualSpectrumOn(
    ctx,
    canvas.clientWidth,
    canvas.clientHeight,
    record,
  );
  renderLegend([record]);
}
function drawWave(record) {
  resizeCanvas();
  clearCanvas();
  if (!record) return;
  drawWaveOn(ctx, canvas.clientWidth, canvas.clientHeight, record);
  renderLegend([record]);
}
function drawSpectrogram(record) {
  resizeCanvas();
  clearCanvas();
  if (!record) return;
  drawSpectrogramOn(ctx, canvas.clientWidth, canvas.clientHeight, record);
  renderLegend([record]);
}
function renderLegend(list) {
  const legend = $("legend");
  legend.innerHTML = "";
  list.forEach((record) => {
    const originalIndex = records.indexOf(record);
    const span = document.createElement("span");
    const mark = document.createElement("i");
    mark.style.background = colors[Math.max(0, originalIndex) % colors.length];
    const text = document.createElement("span");
    text.textContent = shortName(record.name, 38);
    span.append(mark, text);
    legend.appendChild(span);
  });
}
function drawCurrent() {
  const individual = currentView !== "compare";
  $("recordSelectorWrap").classList.toggle("hidden", !individual);
  $("spectrumZoomBar")?.classList.toggle("hidden", currentView !== "spectrum");
  const record = records[selectedIndex];
  if (currentView === "compare") drawComparison();
  else if (currentView === "spectrum") drawIndividualSpectrum(record);
  else if (currentView === "wave") drawWave(record);
  else drawSpectrogram(record);
}
document.querySelectorAll(".tabs button").forEach((button) =>
  button.addEventListener("click", () => {
    document
      .querySelectorAll(".tabs button")
      .forEach((b) => b.classList.remove("active"));
    button.classList.add("active");
    currentView = button.dataset.view;
    drawCurrent();
  }),
);
$("spectrumZoomTheory")?.addEventListener("click", zoomSpectrumToTheory);
$("spectrumApplySpeed")?.addEventListener(
  "click",
  applyTheorySpeedToSelectedFile,
);
$("transPreviewSpeed")?.addEventListener("input", (event) =>
  onTheorySpeedInput(event.target),
);
$("transSpeedSlider")?.addEventListener("input", (event) =>
  onTheorySpeedInput(event.target),
);
$("spectrumZoomReset")?.addEventListener("click", resetSpectrumZoom);
$("normalize").addEventListener("change", drawCurrent);
$("commonTolerance").addEventListener("change", () => {
  if (records.some((r) => r.spectrum)) {
    renderCommonFrequencies();
    buildSummary();
  }
});
function shortName(text, max) {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[c],
  );
}

function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return "rex-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

// v0.9.6 : noms de fichiers uniques (date + heure), plus d'écrasement entre sessions
function fileStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}h${p(date.getMinutes())}m${p(date.getSeconds())}`;
}
let acqSessionStartDate = null;
function acqSessionBaseName(prefix = "Acquisition_TGV") {
  const parts = [prefix],
    rame = $("acqRame")?.value.trim(),
    motrice = $("acqMotrice")?.value.trim(),
    train = $("acqTrain")?.value.trim();
  if (rame) parts.push("R" + safeFilenamePart(rame));
  if (motrice) parts.push((/^\d/.test(motrice) ? "M" : "") + safeFilenamePart(motrice));
  if (train) parts.push("T" + safeFilenamePart(train));
  if (!rame && !motrice) parts.push("NonIdentifie");
  parts.push(fileStamp(acqSessionStartDate || new Date()));
  return parts.join("_");
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY),
      parsed = raw ? JSON.parse(raw) : [];
    historyCases = Array.isArray(parsed)
      ? parsed.map((item) => normalizeRexCase(item, false)).filter(Boolean)
      : [];
    storageAvailable = true;
    $("storageState").textContent =
      "Sauvegarde locale active dans ce navigateur.";
  } catch (error) {
    console.error(error);
    historyCases = [];
    storageAvailable = false;
    $("storageState").textContent =
      "Sauvegarde locale indisponible. Utilisez l’export JSON.";
  }
  renderHistory();
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(historyCases));
    storageAvailable = true;
    $("storageState").textContent =
      `Sauvegarde locale effectuée le ${new Date().toLocaleString("fr-FR")}.`;
  } catch (error) {
    console.error(error);
    storageAvailable = false;
    $("storageState").textContent =
      "Impossible d’enregistrer localement. Exportez l’historique en JSON.";
  }
  renderHistory();
  renderRexMatches();
}

function currentSignature() {
  const clusters = clusterCommonPeaks();
  let values = clusters.map((c) => c.mean);

  if (!values.length) {
    const all = [];
    records.forEach((r) => r.peaks.slice(0, 6).forEach((p) => all.push(p.f)));
    all.sort((a, b) => a - b);
    const tolerance = parseFloat($("commonTolerance").value) || 8;
    values = [];
    all.forEach((f) => {
      const existing = values.findIndex((v) => Math.abs(v - f) <= tolerance);
      if (existing >= 0) values[existing] = (values[existing] + f) / 2;
      else values.push(f);
    });
  }

  return values
    .filter((f) => Number.isFinite(f) && f >= 20 && f <= 2500)
    .sort((a, b) => a - b)
    .slice(0, 20);
}

function currentAnalysisSnapshot() {
  const clusters = clusterCommonPeaks();
  return {
    id: newId(),
    version: STABILITY_CONFIG.applicationVersion,
    schemaVersion: STABILITY_CONFIG.schemaVersion,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rame: $("rame").value.trim(),
    motrice: $("motrice").value.trim(),
    train: $("train").value.trim(),
    date: $("date").value,
    notes: $("notes").value.trim(),
    summary: $("summary").textContent,
    transmission: transmissionExportConfig(),
    frequencyCalibration: frequencyCalibrationExport(),
    weighting: {
      enabled: aWeightingEnabled(),
      mode: activeModeName(),
      unit: activeLevelUnit(),
      diagnosticBasis: "spectre_brut",
      absoluteMeasurement: false,
      notice: weightingDisclaimer(),
    },
    signature: currentSignature(),
    signatureNormalized: currentNormalizedSignature(),
    signatureBasis: "Hz_par_km_h",
    commonFrequencies: clusters.map((cluster) => ({
      frequency: Number(cluster.mean.toFixed(3)),
      presence: cluster.recordIndexes.size,
      total: records.length,
    })),
    files: records.map((record) => ({
      name: record.name,
      speed: record.speed,
      regime: record.regime,
      duration: Number(record.duration.toFixed(2)),
      peaks: record.peaks.map((peak) => {
        const info = peakClassification(record, peak);
        return {
          frequency: Number(peak.f.toFixed(3)),
          levelRaw: Number(peak.rawV.toFixed(2)),
          levelA: Number(peak.aV.toFixed(2)),
          displayedLevel: Number(peakDisplayedLevel(peak).toFixed(2)),
          displayedUnit: activeLevelUnit(),
          type: info.type,
          familyBase:
            info.familyBase === null
              ? null
              : Number(info.familyBase.toFixed(3)),
          harmonicOrder: info.order,
          confidence: info.confidence,
        };
      }),
    })),
    status: "En investigation",
    confirmedCause: "",
    conclusion: "",
    interventions: [],
  };
}

function saveCurrentAnalysisToRex() {
  if (!records.some((r) => r.spectrum)) {
    setStatus(
      "Lancez d’abord l’analyse avant de l’enregistrer dans le REX.",
      true,
    );
    return;
  }

  const snapshot = currentAnalysisSnapshot();
  historyCases.unshift(snapshot);
  selectedHistoryId = snapshot.id;
  saveHistory();
  renderSelectedCase();
  setStatus("Analyse enregistrée dans l’historique REX.");
}

function caseSearchText(item) {
  const interventions = (item.interventions || [])
    .map((intervention) =>
      [
        intervention.organ,
        intervention.action,
        intervention.outcome,
        intervention.notes,
      ].join(" "),
    )
    .join(" ");
  return [
    item.rame,
    item.motrice,
    item.train,
    item.date,
    item.status,
    item.confirmedCause,
    item.conclusion,
    item.notes,
    (item.signature || []).join(" "),
    (item.signatureNormalized || []).join(" "),
    interventions,
  ]
    .join(" ")
    .toLowerCase();
}

function latestOutcome(item) {
  const interventions = item.interventions || [];
  if (!interventions.length) return "";
  return interventions[interventions.length - 1].outcome || "";
}

function renderHistory() {
  $("historyCount").textContent = historyCases.length;
  const body = $("historyBody");
  body.innerHTML = "";
  const query = $("historySearch")
      ? $("historySearch").value.trim().toLowerCase()
      : "",
    status = $("historyStatusFilter") ? $("historyStatusFilter").value : "",
    outcome = $("historyOutcomeFilter") ? $("historyOutcomeFilter").value : "";
  const filtered = historyCases.filter(
    (item) =>
      (!query || caseSearchText(item).includes(query)) &&
      (!status || item.status === status) &&
      (!outcome ||
        (item.interventions || []).some(
          (intervention) => intervention.outcome === outcome,
        )),
  );
  if (!filtered.length) {
    const row = document.createElement("tr"),
      cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "small";
    cell.textContent = "Aucun dossier correspondant.";
    row.appendChild(cell);
    body.appendChild(row);
  }
  filtered.forEach((item) => {
    const row = document.createElement("tr");
    row.className =
      "history-row" + (item.id === selectedHistoryId ? " selected" : "");
    const values = [
      item.date || new Date(item.createdAt).toLocaleDateString("fr-FR"),
      (item.rame || "—") + " / " + (item.motrice || "—"),
      (item.signature || [])
        .slice(0, 5)
        .map((value) => Number(value).toFixed(1))
        .join(", ") || "—",
      item.status || "En investigation",
    ];
    values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });
    const actionCell = document.createElement("td"),
      button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.style.padding = "5px 8px";
    button.textContent = "Ouvrir";
    button.dataset.openCase = item.id;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      selectHistoryCase(item.id);
    });
    actionCell.appendChild(button);
    row.appendChild(actionCell);
    row.addEventListener("click", () => selectHistoryCase(item.id));
    body.appendChild(row);
  });
  if (
    selectedHistoryId &&
    !historyCases.some((item) => item.id === selectedHistoryId)
  )
    selectedHistoryId = null;
}

function selectHistoryCase(id) {
  selectedHistoryId = id;
  renderHistory();
  renderSelectedCase();
}

function selectedCase() {
  return historyCases.find((c) => c.id === selectedHistoryId) || null;
}

function renderSelectedCase() {
  const item = selectedCase();
  $("caseEmpty").classList.toggle("hidden", !!item);
  $("caseEditor").classList.toggle("hidden", !item);
  if (!item) return;

  $("caseTitle").textContent =
    `Rame ${item.rame || "—"} — ${item.motrice || "—"}`;
  $("caseMeta").textContent =
    `Train ${item.train || "—"} — ${item.date || "date non renseignée"} — ` +
    `${(item.files || []).length} bande(s) sonore(s)`;
  $("caseSignature").textContent =
    (item.signature || []).map((f) => Number(f).toFixed(1) + "Hz").join("·") ||
    "Aucune signature enregistrée";

  $("caseStatus").value = item.status || "En investigation";
  $("caseConfirmedCause").value = item.confirmedCause || "";
  $("caseConclusion").value = item.conclusion || "";

  const disappearance = (item.interventions || []).find(
    (i) => i.outcome === "Bruit disparu",
  );
  const box = $("noiseDisappearance");
  if (disappearance) {
    box.classList.remove("hidden");
    box.textContent =
      `Bruit disparu après : ${disappearance.action} sur ${disappearance.organ || "organe non renseigné"} ` +
      `le ${disappearance.date || "date non renseignée"}.`;
  } else {
    box.classList.add("hidden");
    box.textContent = "";
  }

  renderInterventionTimeline(item);
}

function updateSelectedCase() {
  const item = selectedCase();
  if (!item) return;

  item.status = $("caseStatus").value;
  item.confirmedCause = $("caseConfirmedCause").value.trim();
  item.conclusion = $("caseConclusion").value.trim();
  item.updatedAt = new Date().toISOString();
  saveHistory();
  renderSelectedCase();
  setStatus("Dossier REX mis à jour.");
}

function addIntervention() {
  const item = selectedCase();
  if (!item) {
    setStatus("Sélectionnez d’abord un dossier REX.", true);
    return;
  }

  const organ = $("interventionOrgan").value.trim();
  const action = $("interventionAction").value;
  const outcome = $("interventionOutcome").value;

  if (!organ && action !== "Essai sans modification") {
    setStatus("Renseignez l’organe concerné.", true);
    return;
  }

  const intervention = {
    id: newId(),
    date: $("interventionDate").value || todayIso(),
    organ,
    action,
    outcome,
    notes: $("interventionNotes").value.trim(),
    confirmsCause: $("interventionConfirmsCause").checked,
    createdAt: new Date().toISOString(),
  };

  item.interventions = item.interventions || [];
  item.interventions.push(intervention);
  item.updatedAt = new Date().toISOString();

  if (intervention.confirmsCause) {
    item.confirmedCause = organ || item.confirmedCause;
    item.status = "Cause confirmée";
  } else if (
    outcome === "Bruit disparu" &&
    item.status === "En investigation"
  ) {
    item.status = "En attente d’essai";
  }

  $("interventionDate").value = todayIso();
  $("interventionOrgan").value = "";
  $("interventionNotes").value = "";
  $("interventionOutcome").value = "Non vérifié";
  $("interventionConfirmsCause").checked = false;

  saveHistory();
  renderSelectedCase();
  setStatus("Intervention ajoutée à la chronologie REX.");
}

function renderInterventionTimeline(item) {
  const box = $("interventionTimeline");
  box.innerHTML = "";
  const list = [...(item.interventions || [])].sort((a, b) =>
    (a.date || "").localeCompare(b.date || ""),
  );

  if (!list.length) {
    box.innerHTML = '<div class="small">Aucune intervention enregistrée.</div>';
    return;
  }

  list.forEach((intervention) => {
    const div = document.createElement("div");
    div.className = "timeline-item";
    const confirmed = intervention.confirmsCause ? "—cause confirmée" : "";
    div.innerHTML = `
      <strong>${escapeHtml(intervention.date || "Date non renseignée")} — ${escapeHtml(intervention.action)} : ${escapeHtml(intervention.organ || "sans organe")}</strong>
      <div>${escapeHtml(intervention.outcome || "Non vérifié")}${escapeHtml(confirmed)}</div>
      <div class="small">${escapeHtml(intervention.notes || "Aucune observation")}</div>
      <div style="margin-top:5px">
        <button type="button" class="danger" data-delete-intervention="${intervention.id}" style="padding:4px 7px">Supprimer</button>
      </div>`;
    box.appendChild(div);
  });

  box.querySelectorAll("[data-delete-intervention]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!confirm("Supprimer cette intervention de la chronologie?")) return;
      item.interventions = item.interventions.filter(
        (i) => i.id !== button.dataset.deleteIntervention,
      );
      item.updatedAt = new Date().toISOString();
      saveHistory();
      renderSelectedCase();
    });
  });
}

function deleteSelectedCase() {
  const item = selectedCase();
  if (!item) return;
  if (
    !confirm(
      `Supprimer définitivement le dossier REX de la rame ${item.rame || "—"} ?`,
    )
  )
    return;
  historyCases = historyCases.filter((c) => c.id !== item.id);
  selectedHistoryId = null;
  saveHistory();
  renderSelectedCase();
  setStatus("Dossier REX supprimé.");
}

function matchSignatures(current, historical, tolerance) {
  const left = safeNumberArray(current).sort((a, b) => a - b),
    right = safeNumberArray(historical).sort((a, b) => a - b);
  if (!left.length || !right.length) return { score: 0, matches: [] };
  const rows = left.length + 1,
    cols = right.length + 1,
    dp = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ count: 0, cost: 0, pairs: [] })),
    );
  const better = (a, b) =>
    a.count !== b.count
      ? a.count > b.count
        ? a
        : b
      : a.cost <= b.cost
        ? a
        : b;
  for (let i = 1; i < rows; i++)
    for (let j = 1; j < cols; j++) {
      let best = better(dp[i - 1][j], dp[i][j - 1]);
      const distance = Math.abs(left[i - 1] - right[j - 1]);
      if (distance <= tolerance) {
        const previous = dp[i - 1][j - 1],
          matched = {
            count: previous.count + 1,
            cost: previous.cost + distance,
            pairs: [
              ...previous.pairs,
              { current: left[i - 1], historical: right[j - 1], distance },
            ],
          };
        best = better(best, matched);
      }
      dp[i][j] = best;
    }
  const result = dp[left.length][right.length],
    coverage = result.count / Math.max(left.length, right.length),
    evidence = Math.min(1, result.count / 3),
    balance = (2 * result.count) / (left.length + right.length),
    score = Math.round(100 * coverage * evidence * Math.sqrt(balance));
  return { score, matches: result.pairs };
}

function rexMatchesForCurrent() {
  if (!records.some((record) => record.spectrum)) return [];
  const normalized = currentNormalizedSignature(),
    raw = currentSignature(),
    rawTolerance = Math.max(5, parseFloat($("commonTolerance").value) || 8);
  return historyCases
    .map((item) => {
      const useNormalized =
        normalized.length &&
        Array.isArray(item.signatureNormalized) &&
        item.signatureNormalized.length;
      const comparison = useNormalized
        ? matchSignatures(normalized, item.signatureNormalized, 0.04)
        : matchSignatures(raw, item.signature || [], rawTolerance);
      return {
        item,
        ...comparison,
        basis: useNormalized ? "Hz/(km/h)" : "Hz",
        legacy: !useNormalized,
      };
    })
    .filter((result) => result.matches.length > 0)
    .sort((a, b) => b.score - a.score || b.matches.length - a.matches.length)
    .slice(0, 10);
}

function determiningOutcome(item) {
  const interventions = item.interventions || [];
  const disappeared = interventions.find((i) => i.outcome === "Bruit disparu");
  if (disappeared) {
    return `${disappeared.action} — ${disappeared.organ || "organe non renseigné"}`;
  }
  const confirmed = interventions.find((i) => i.confirmsCause);
  if (confirmed) {
    return `${confirmed.action} — ${confirmed.organ || "organe non renseigné"}`;
  }
  const latest = interventions[interventions.length - 1];
  return latest
    ? `${latest.outcome} après ${latest.action}`
    : "Aucune intervention";
}

function renderRexMatches() {
  const body = $("rexMatchBody");
  if (!body) return;
  body.innerHTML = "";
  if (!records.some((record) => record.spectrum)) {
    $("rexMatchInfo").textContent =
      "Lancez une analyse pour rechercher des signatures similaires dans l’historique.";
    return;
  }
  const matches = rexMatchesForCurrent();
  if (!matches.length) {
    $("rexMatchInfo").textContent =
      "Aucun dossier historique ne présente actuellement une signature suffisamment proche.";
    const row = document.createElement("tr");
    row.innerHTML =
      '<td colspan="5" class="small">Pas de correspondance REX.</td>';
    body.appendChild(row);
    return;
  }
  $("rexMatchInfo").textContent =
    `${matches.length} dossier(s) rapproché(s). La normalisation fréquence/vitesse est utilisée lorsque les deux dossiers la possèdent ; sinon, comparaison historique en Hz.`;
  matches.forEach((match) => {
    const unit = match.basis,
      frequencies = match.matches
        .map(
          (pair) =>
            `${pair.current.toFixed(unit === "Hz" ? 1 : 4)} ↔ ${pair.historical.toFixed(unit === "Hz" ? 1 : 4)} ${unit}`,
        )
        .join(", "),
      row = document.createElement("tr");
    [
      `${match.score} %`,
      `${match.item.date || "—"} — rame ${match.item.rame || "—"} / ${match.item.motrice || "—"}`,
      frequencies + (match.legacy ? " (comparaison ancienne en Hz)" : ""),
      match.item.confirmedCause || "Non déterminé",
      determiningOutcome(match.item),
    ].forEach((value, index) => {
      const cell = document.createElement("td");
      if (index === 0) cell.className = "rex-score";
      cell.textContent = value;
      row.appendChild(cell);
    });
    row.addEventListener("click", () => selectHistoryCase(match.item.id));
    row.style.cursor = "pointer";
    body.appendChild(row);
  });
}

// v0.9.6 : en mode capture (sauvegarde ZIP), les fichiers sont collectés au lieu d'être téléchargés
let acqDownloadCapture = null;
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  if (acqDownloadCapture) {
    acqDownloadCapture.push({ name: filename, blob });
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportHistoryJson() {
  const payload = {
    application: "AnalyseAcoustiqueTGV",
    version: STABILITY_CONFIG.applicationVersion,
    schemaVersion: STABILITY_CONFIG.schemaVersion,
    exportedAt: new Date().toISOString(),
    weightingExportContext: {
      mode: activeModeName(),
      unit: activeLevelUnit(),
      absoluteMeasurement: false,
      notice: weightingDisclaimer(),
    },
    cases: historyCases,
  };
  downloadText(
    `REX_Analyse_Acoustique_TGV_${fileStamp()}.json`,
    JSON.stringify(payload, null, 2),
    "application/json;charset=utf-8",
  );
}

function csvCell(value) {
  return safeCsvCell(value);
}
function exportHistoryCsv() {
  const headers = [
    "ID",
    "Version",
    "Date analyse",
    "Rame",
    "Motrice",
    "Train",
    "Mode pondération",
    "Unité niveau",
    "Diamètre E1 mm",
    "Diamètre E2 mm",
    "Statut",
    "Signature Hz",
    "Signature Hz/km/h",
    "Cause retenue",
    "Conclusion",
    "Date intervention",
    "Organe",
    "Action",
    "Résultat",
    "Cause confirmée",
    "Observations",
  ];
  const rows = [headers];
  historyCases.forEach((item) => {
    const interventions = item.interventions || [],
      base = [
        item.id,
        item.version || "antérieure",
        item.date,
        item.rame,
        item.motrice,
        item.train,
        item.weighting?.mode || "brut (historique)",
        item.weighting?.unit || "dB relatif",
        item.transmission?.diameterEssieu1Mm || "",
        item.transmission?.diameterEssieu2Mm || "",
        item.status,
        (item.signature || []).join(" | "),
        (item.signatureNormalized || []).join(" | "),
        item.confirmedCause,
        item.conclusion,
      ];
    if (!interventions.length) {
      rows.push([...base, "", "", "", "", "", item.notes]);
    } else {
      interventions.forEach((intervention) =>
        rows.push([
          ...base,
          intervention.date,
          intervention.organ,
          intervention.action,
          intervention.outcome,
          intervention.confirmsCause ? "Oui" : "Non",
          intervention.notes,
        ]),
      );
    }
  });
  const csv =
    "\ufeff" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
  downloadText(
    `REX_Analyse_Acoustique_TGV_${fileStamp()}.csv`,
    csv,
    "text/csv;charset=utf-8",
  );
}
async function importHistoryJson(file) {
  return (async () => {
    try {
      const text = await file.text(),
        parsed = JSON.parse(text),
        rawCases = Array.isArray(parsed) ? parsed : parsed.cases;
      if (!Array.isArray(rawCases))
        throw new Error("Format JSON non reconnu : propriété cases attendue.");
      const imported = rawCases.map((item) => normalizeRexCase(item, true));
      const byId = new Map(historyCases.map((item) => [item.id, item]));
      imported.forEach((item) => byId.set(item.id, item));
      historyCases = [...byId.values()].sort((a, b) =>
        String(b.createdAt || b.date || "").localeCompare(
          String(a.createdAt || a.date || ""),
        ),
      );
      saveHistory();
      setStatus(`${imported.length} dossier(s) REX validé(s) et importé(s).`);
    } catch (error) {
      console.error(error);
      setStatus("Import refusé : " + error.message, true);
    }
  })();
}
function appendRexToPdf(container) {
  const matches = rexMatchesForCurrent(),
    section = document.createElement("section");
  section.style.breakBefore = "page";
  section.innerHTML = "<h2>Historique et retours d’expérience (REX)</h2>";
  const intro = document.createElement("div");
  intro.style.fontSize = "12px";
  intro.style.marginBottom = "10px";
  intro.textContent =
    "Correspondances indicatives : fréquence/vitesse lorsque disponible dans les deux dossiers, sinon comparaison historique en Hz. Le score pénalise les signatures trop courtes.";
  section.appendChild(intro);
  if (matches.length) {
    const rows = matches.slice(0, 8).map((match) => {
      const unit = match.basis;
      return [
        `${match.score} %`,
        `${match.item.date || "—"} — rame ${match.item.rame || "—"} / ${match.item.motrice || "—"}`,
        match.matches
          .map(
            (pair) =>
              `${pair.current.toFixed(unit === "Hz" ? 1 : 4)} ↔ ${pair.historical.toFixed(unit === "Hz" ? 1 : 4)} ${unit}`,
          )
          .join(", ") + (match.legacy ? " (ancien format)" : ""),
        match.item.confirmedCause || "Non déterminé",
        determiningOutcome(match.item),
      ];
    });
    section.appendChild(
      makeSimpleTable(
        [
          "Proximité",
          "Dossier",
          "Signature comparée",
          "Cause / organe",
          "Résultat déterminant",
        ],
        rows,
      ),
    );
  } else {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Aucun cas REX similaire n’a été identifié.";
    section.appendChild(paragraph);
  }
  const selected = selectedCase();
  if (selected) {
    const title = document.createElement("h3");
    title.textContent = "Dossier REX sélectionné";
    section.appendChild(title);
    const detail = document.createElement("div");
    detail.style.whiteSpace = "pre-wrap";
    detail.style.fontSize = "12px";
    detail.textContent = `Rame ${selected.rame || "—"} / ${selected.motrice || "—"} — statut : ${selected.status || "—"}\nCause retenue : ${selected.confirmedCause || "non déterminée"}\nConclusion : ${selected.conclusion || "non renseignée"}`;
    section.appendChild(detail);
    const interventions = (selected.interventions || []).map((intervention) => [
      intervention.date || "—",
      intervention.organ || "—",
      intervention.action || "—",
      intervention.outcome || "—",
      intervention.confirmsCause ? "Oui" : "Non",
      intervention.notes || "",
    ]);
    if (interventions.length)
      section.appendChild(
        makeSimpleTable(
          [
            "Date",
            "Organe",
            "Action",
            "Résultat",
            "Cause confirmée",
            "Observations",
          ],
          interventions,
        ),
      );
  }
  container.appendChild(section);
}
function createReportImage(dataUrl, altText, cssClass = "report-chart") {
  const img = new Image();
  img.alt = altText;
  img.className = cssClass;
  img.src = dataUrl;
  return img;
}
async function waitForReportImages(container) {
  const images = [...container.querySelectorAll("img")];
  await Promise.all(
    images.map(async (img) => {
      try {
        if (img.complete && img.naturalWidth > 0) return;
        if (typeof img.decode === "function") {
          await img.decode();
          return;
        }
        await new Promise((resolve, reject) => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", reject, { once: true });
        });
      } catch (error) {
        console.error("Image du rapport non chargée :", error);
      }
    }),
  );
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
}
function makeCanvasImage(drawFn, width = 1100, height = 620) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const cctx = c.getContext("2d");
  drawFn(cctx, width, height);
  return c.toDataURL("image/png");
}
function makeSimpleTable(headers, rows) {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    r.forEach((v) => {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}
function buildReportDom() {
  const container = $("reportContainer");
  container.innerHTML = "";
  const head = document.createElement("div");
  head.innerHTML = `<div style="display:flex;gap:12px;align-items:center;margin-bottom:14px">
    <img src="data:image/png;base64,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" alt="" style="width:70px;height:70px;object-fit:contain">
    <div>
      <div style="font-size:22px;font-weight:700">Analyse acoustique TGV — Rapport complet v1.0</div>
      <div style="font-size:13px;color:#4D4F53">Rapport généré localement</div>
    </div>
  </div>`;
  container.appendChild(head);
  const meta = document.createElement("div");
  meta.innerHTML = `<div style="margin-bottom:12px">
    <strong>Rame :</strong> ${escapeHtml($("rame").value || "non renseignée")} &nbsp;&nbsp;
    <strong>Motrice :</strong> ${escapeHtml($("motrice").value || "non renseignée")} &nbsp;&nbsp;
    <strong>Train :</strong> ${escapeHtml($("train").value || "non renseigné")} &nbsp;&nbsp;
    <strong>Date :</strong> ${escapeHtml($("date").value || "non renseignée")}
  </div>`;
  container.appendChild(meta);
  const transmissionInfo = document.createElement("div");
  const reportTransmission = getTransmissionConfig();
  transmissionInfo.style.cssText =
    "font-size:12px;margin-bottom:12px;padding:8px 10px;border-left:4px solid #009AA6;background:#FFFFFF";
  transmissionInfo.textContent = `Deux essieux : E1 Ø${reportTransmission.diameter1.toFixed(0)} mm (cyan continu) ; E2 Ø${reportTransmission.diameter2.toFixed(0)} mm (orange pointillé). Référence : ${transmissionLabel(reportTransmission.reference)}. Calibration fréquence : ${frequencyCalibration.active ? "active ×" + frequencyCalibration.factor.toFixed(7) + " à " + frequencyCalibration.sampleRate + " Hz" : "inactive"}. Les attributions restent indéterminées si la séparation est inférieure à la résolution FFT.`;
  container.appendChild(transmissionInfo);
  const intro = document.createElement("div");
  intro.innerHTML = `<div style="font-size:12px;margin-bottom:12px">
    Mode actif : <strong>${activeModeName()}</strong> — unité : <strong>${activeLevelUnit()}</strong>.<br>${weightingDisclaimer()}<br><br>Ce document rassemble l’ensemble des informations issues de l’analyse multi-fichiers. Les graphiques sont intégrés sous forme d’images haute résolution afin d’être conservés dans le PDF :
    comparaison globale, fréquences communes, tableaux de pics et analyses individuelles
    par enregistrement.
  </div>`;
  container.appendChild(intro);
  if (records.some((r) => r.spectrum)) {
    const img1 = createReportImage(
      makeCanvasImage(drawComparisonOn),
      "Comparaison globale des spectres",
    );
    const sec1 = document.createElement("section");
    sec1.className = "report-chart";
    sec1.style.breakInside = "avoid";
    sec1.innerHTML = `<h2>Comparaison des spectres ${activeModeName()}s 0–2 500 Hz</h2>`;
    sec1.appendChild(img1);
    container.appendChild(sec1);
  }
  const commonSection = document.createElement("section");
  commonSection.style.breakInside = "avoid";
  commonSection.innerHTML = "<h2>Fréquences communes</h2>";
  const commonRows = [...$("commonBody").querySelectorAll("tr")].map((tr) =>
    [...tr.children].map((td) => td.textContent),
  );
  commonSection.appendChild(
    makeSimpleTable(
      ["Fréquence moyenne", "Présence", "Fichiers concernés"],
      commonRows.length ? commonRows : [["Aucune", "", ""]],
    ),
  );
  container.appendChild(commonSection);
  const peaksSection = document.createElement("section");
  peaksSection.style.breakInside = "avoid";
  peaksSection.innerHTML = "<h2>Principaux pics par fichier</h2>";
  const peakRows = [...$("peaksBody").querySelectorAll("tr")].map((tr) =>
    [...tr.children].map((td) => td.textContent),
  );
  peaksSection.appendChild(
    makeSimpleTable(
      [
        "Fichier",
        "Rang",
        "Fréquence",
        "Mode",
        "Niveau actif",
        "Niveau brut",
        "Niveau pondéré A",
        "Type",
        "Famille",
        "Orientation",
      ],
      peakRows.length ? peakRows : [["Aucun", "", "", "", "", "", ""]],
    ),
  );
  container.appendChild(peaksSection);
  const guidanceSection = document.createElement("section");
  guidanceSection.style.breakInside = "avoid";
  guidanceSection.innerHTML = "<h2>Orientation fréquentielle</h2>";
  const guidanceText = document.createElement("div");
  guidanceText.style.whiteSpace = "pre-wrap";
  guidanceText.style.lineHeight = "1.55";
  guidanceText.textContent = $("frequencyGuidance").textContent;
  guidanceSection.appendChild(guidanceText);
  container.appendChild(guidanceSection);
  const synthSection = document.createElement("section");
  synthSection.style.breakInside = "avoid";
  synthSection.innerHTML = "<h2>Synthèse automatique</h2>";
  const pre = document.createElement("div");
  pre.style.whiteSpace = "pre-wrap";
  pre.style.lineHeight = "1.55";
  pre.textContent = $("summary").textContent;
  synthSection.appendChild(pre);
  container.appendChild(synthSection);
  records.forEach((record) => {
    const section = document.createElement("section");
    section.className = "report-file";
    section.style.breakBefore = "page";
    section.style.breakInside = "avoid";
    section.innerHTML = `<h2>${escapeHtml(record.name)}</h2>
      <div style="font-size:12px;margin-bottom:8px">
        <strong>Vitesse :</strong> ${escapeHtml(record.speed || "non renseignée")} km/h &nbsp;&nbsp;
        <strong>Régime :</strong> ${escapeHtml(record.regime)} &nbsp;&nbsp;
        <strong>Durée :</strong> ${record.duration.toFixed(1)} s
      </div>`;
    if (record.spectrum) {
      const imgSpec = createReportImage(
        makeCanvasImage((c, w, h) => drawIndividualSpectrumOn(c, w, h, record)),
        `Spectre individuel — ${record.name}`,
      );
      section.appendChild(imgSpec);
    }
    const recordAnalysis = classifyRecordPeaks(record);
    const peaksRows = record.peaks.map((p, idx) => {
      const info = recordAnalysis.classifications.get(p);
      return [
        `${idx + 1}`,
        `${p.f.toFixed(1)} Hz`,
        `${peakDisplayedLevel(p).toFixed(1)} ${activeLevelUnit()}`,
        `${p.rawV.toFixed(1)} dB relatif`,
        `${p.aV.toFixed(1)} dB(A) relatif`,
        info.type,
        info.family || "—",
      ];
    });
    section.appendChild(
      makeSimpleTable(
        [
          "Rang",
          "Fréquence",
          "Niveau actif",
          "Niveau brut",
          "Niveau pondéré A",
          "Type",
          "Famille",
        ],
        peaksRows.length ? peaksRows : [["Aucun", "", "", "", ""]],
      ),
    );
    const work = bestWorkingFrequency(record);
    const orientation = document.createElement("div");
    orientation.style.margin = "8px 0 12px";
    orientation.style.fontSize = "12px";
    orientation.textContent =
      work.primary !== null
        ? `Fréquence de travail prioritaire : ${work.primary.toFixed(1)} Hz — confiance ${work.confidence.toLowerCase()}. ${work.reason}.`
        : "Aucune fréquence de travail proposée.";
    section.appendChild(orientation);
    if (!record.spectrogram) computeSpectrogram(record);
    const imgSpg = createReportImage(
      makeCanvasImage(
        (c, w, h) => drawSpectrogramOn(c, w, h, record),
        1100,
        620,
      ),
      `Spectrogramme — ${record.name}`,
    );
    section.appendChild(imgSpg);
    container.appendChild(section);
  });
  window.DiametresTGV?.appendToReport(container); // v0.9.7 : diamètres de roue calculés
  window.CarteTrajetTGV?.appendToReport(container); // v0.9.6 : carte du trajet GPS
  appendRexToPdf(container);
  const footer = document.createElement("div");
  footer.style.marginTop = "18px";
  footer.style.fontSize = "11px";
  footer.style.color = "#4D4F53";
  footer.textContent =
    "Document généré par Analyse Acoustique TGV v1.0 — diagnostic mécanique brut, affichage pondéré A optionnel.";
  container.appendChild(footer);
}
$("fullPdf").addEventListener("click", async () => {
  if (!records.some((r) => r.spectrum) && !window.CampbellTGV?._state?.rows?.length) return;
  const button = $("fullPdf");
  const originalText = button.textContent;
  try {
    button.disabled = true;
    button.textContent = "Préparation des graphiques…";
    setStatus("Préparation du rapport PDF et chargement des graphiques…");
    // v0.9.7 RC : rapport détaillé (rapport-v097.js) ; ancien rapport en secours
    if (window.RapportTGV) {
      await window.RapportTGV.build((t) => (button.textContent = t));
    } else {
      if (window.CarteTrajetTGV) await window.CarteTrajetTGV.prepareReport();
      buildReportDom();
    }
    const container = $("reportContainer");
    await waitForReportImages(container);
    setStatus("Rapport prêt. Ouverture de la fenêtre d’impression…");
    button.textContent = "Ouverture du PDF…";
    window.print();
  } catch (error) {
    console.error(error);
    setStatus(
      "Erreur pendant la préparation du rapport PDF : " + error.message,
      true,
    );
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
/* Chaîne de transmission TGV (nombre de dents des pignons).
 *   Moteur ─ pignon moteur 27 dents ─▶ roue intermédiaire 41 dents ─▶ roue de sortie
 *   51 dents (= RÉDUCTEUR) ─▶ pignon d'entrée du pont 44 dents ─▶ couronne d'essieu
 *   51 dents (= PONT) ─▶ essieu et roues (plage de diamètre admise : 850 mm = cote de retrait limite d'usure, à 924 mm = roue neuve).
 * Modifier ces valeurs si la chaîne d'un autre matériel est différente. */
const TRANS_DEFAULTS = {
  wheelDiameter: 900,
  wheelMin: 850, // cote de retrait limite d'usure (mm)
  wheelMax: 924, // diamètre d'une roue neuve (mm)
  motorPinion: 27,
  reducerIntermediate: 41,
  reducerOutput: 51,
  bridgeInput: 44,
  axleGear: 51,
};
function clampWheelDiameter(value, fallback) {
  const parsed = parseFloat(value),
    selected = Number.isFinite(parsed) ? parsed : fallback;
  // v0.9.7 RC : plage admise 850–924 mm (retrait limite d'usure – neuf) (TRANS_DEFAULTS.wheelMin / wheelMax) ;
  // une valeur saisie hors plage est refusée et ramenée à la limite la plus proche.
  return Math.max(TRANS_DEFAULTS.wheelMin, Math.min(TRANS_DEFAULTS.wheelMax, selected));
}
function theoryKeysForConfig(cfg) {
  return [cfg.reference];
}
function dualAxleDash(axle, key, cfg) {
  if (key === cfg.reference) return axle.id === "E1" ? [] : [9, 4];
  return axle.id === "E1" ? [2, 3] : [2, 5];
}
function transmissionExportConfig() {
  const cfg = getTransmissionConfig();
  return {
    diameterEssieu1Mm: cfg.diameter1,
    diameterEssieu2Mm: cfg.diameter2,
    vitesseApercuKmh: cfg.previewSpeed,
    reference: cfg.reference,
    showTheory: cfg.showTheory,
    showAllRotations: cfg.showAllRotations,
    showLimits: cfg.showLimits,
    showMesh: cfg.showMesh,
    motorPinion: TRANS_DEFAULTS.motorPinion,
    reducerIntermediate: TRANS_DEFAULTS.reducerIntermediate,
    reducerOutput: TRANS_DEFAULTS.reducerOutput,
    bridgeInput: TRANS_DEFAULTS.bridgeInput,
    axleGear: TRANS_DEFAULTS.axleGear,
  };
}
function normalizeTransmissionConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = new Set([
    "axle",
    "bridgeInput",
    "reducerIntermediate",
    "motor",
    "meshBridge",
    "meshReducer",
  ]);
  return {
    diameterEssieu1Mm: clampWheelDiameter(
      value.diameterEssieu1Mm ?? value.diameter1 ?? value.diameter,
      900,
    ),
    diameterEssieu2Mm: clampWheelDiameter(
      value.diameterEssieu2Mm ?? value.diameter2,
      920,
    ),
    reference: allowed.has(value.reference) ? value.reference : "motor",
    showTheory: value.showTheory !== false,
    showAllRotations: value.showAllRotations !== false,
    showLimits: value.showLimits !== false,
    showMesh: Boolean(value.showMesh),
    motorPinion: TRANS_DEFAULTS.motorPinion,
    reducerIntermediate: TRANS_DEFAULTS.reducerIntermediate,
    reducerOutput: TRANS_DEFAULTS.reducerOutput,
    bridgeInput: TRANS_DEFAULTS.bridgeInput,
    axleGear: TRANS_DEFAULTS.axleGear,
  };
}
function axleAssignment(measured, speed, key, cfg = getTransmissionConfig()) {
  if (!Number.isFinite(measured) || !Number.isFinite(speed)) return null;
  const candidates = cfg.axles
    .map((axle) => {
      const value = transmissionFrequencies(speed, axle.diameter)?.[key];
      return {
        ...axle,
        frequency: value,
        delta: Number.isFinite(value) ? Math.abs(measured - value) : Infinity,
      };
    })
    .filter((item) => Number.isFinite(item.frequency))
    .sort((a, b) => a.delta - b.delta);
  if (!candidates.length) return null;
  const separation =
      candidates.length > 1
        ? Math.abs(candidates[0].frequency - candidates[1].frequency)
        : Infinity,
    resolution = diagnosticBinWidth(),
    ambiguous = separation < resolution;
  return {
    best: candidates[0],
    other: candidates[1] || null,
    separation,
    resolution,
    ambiguous,
    label: ambiguous ? "E1/E2 indéterminé" : candidates[0].id,
  };
}
function drawDualAxleSpectrogramOverlay(
  ctxLocal,
  a,
  maxF,
  speedKmh,
  isPreview = false,
) {
  const cfg = getTransmissionConfig();
  if (!cfg.showTheory || !Number.isFinite(speedKmh)) return;
  const keys = theoryKeysForConfig(cfg);
  ctxLocal.save();
  ctxLocal.font = "9px Segoe UI";
  let labelRow = 0;
  for (const axle of cfg.axles) {
    const frequencies = transmissionFrequencies(speedKmh, axle.diameter);
    if (!frequencies) continue;
    for (const key of keys) {
      const hz = frequencies[key];
      if (!Number.isFinite(hz) || hz < 20 || hz > maxF) continue;
      const y = a.T + (1 - hz / maxF) * (a.h - a.T - a.B);
      ctxLocal.strokeStyle = axle.color;
      ctxLocal.globalAlpha = isPreview
        ? key === cfg.reference
          ? 0.72
          : 0.34
        : key === cfg.reference
          ? 0.96
          : 0.68;
      ctxLocal.lineWidth = key === cfg.reference ? 2 : 1.15;
      ctxLocal.setLineDash(dualAxleDash(axle, key, cfg));
      ctxLocal.beginPath();
      ctxLocal.moveTo(a.L, y);
      ctxLocal.lineTo(a.w - a.R, y);
      ctxLocal.stroke();
      if (key === cfg.reference) {
        ctxLocal.setLineDash([]);
        ctxLocal.globalAlpha = 1;
        ctxLocal.fillStyle = axle.color;
        const suffix = isPreview ? " — aperçu" : "",
          text = `${axle.id} Ø${axle.diameter.toFixed(0)} ${transmissionLabel(key)} ${hz.toFixed(hz < 100 ? 2 : 0)} Hz${suffix}`;
        ctxLocal.fillText(
          text,
          a.L + 5,
          Math.max(a.T + 11, Math.min(a.h - a.B - 3, y - 4 - labelRow++ * 10)),
        );
      }
    }
  }
  ctxLocal.restore();
}
function getTransmissionConfig() {
  const diameter1 = clampWheelDiameter($("transWheelDiameter1")?.value, 900),
    diameter2 = clampWheelDiameter($("transWheelDiameter2")?.value, 920),
    previewRaw = parseFloat($("transPreviewSpeed")?.value),
    previewSpeed =
      Number.isFinite(previewRaw) && previewRaw > 0
        ? Math.min(326.4, previewRaw)
        : 300;
  return {
    diameter: diameter1,
    diameter1,
    diameter2,
    previewSpeed,
    axles: [
      {
        id: "E1",
        label: "Essieu 1",
        diameter: diameter1,
        color: "#009AA6",
        dash: [],
      },
      {
        id: "E2",
        label: "Essieu 2",
        diameter: diameter2,
        color: "#E05206",
        dash: [8, 4],
      },
    ],
    showTheory: $("transShowTheory")?.checked !== false,
    showAllRotations: false,
    showLimits: false,
    showMesh: false,
    reference: $("transReference")?.value || "motor",
  };
}
/* Fréquences théoriques de la transmission à une vitesse donnée.
 * 1. Rotation de l'essieu : la roue avance de π × D à chaque tour, donc
 *      f_essieu = (v / 3,6) / (π × D)          [v en km/h, D en m, résultat en tours/s = Hz]
 *    Exemple : 300 km/h, D = 0,90 m → 83,3 / 2,827 = 29,5 Hz.
 * 2. On remonte la chaîne avec les rapports de dents :
 *      f_entrée pont = f_essieu × 51/44
 *      f_moteur      = f_entrée pont × 51/27
 *      f_roue interm.= f_moteur × 27/41
 * 3. Fréquence d'ENGRÈNEMENT = nombre de dents × fréquence de rotation du pignon
 *    (chaque dent qui entre en contact donne un petit choc) :
 *      engrènement réducteur = f_moteur × 27  (≈ 5,81 Hz par km/h pour D = 900 mm)
 *      engrènement pont      = f_essieu × 51  (≈ 5,01 Hz par km/h pour D = 900 mm)
 *    Exemple : 300 km/h, D = 900 mm → engrènement réducteur ≈ 1 742 Hz, en plein dans la
 *    bande gênante 1 500–1 700 Hz. */
function transmissionFrequencies(speedKmh, diameterMm = null) {
  const cfg = getTransmissionConfig();
  const dmm = diameterMm ?? cfg.diameter;
  if (
    !Number.isFinite(speedKmh) ||
    speedKmh < 0 ||
    !Number.isFinite(dmm) ||
    dmm <= 0
  )
    return null;
  const d = dmm / 1000;
  const fAxle = speedKmh / 3.6 / (Math.PI * d);
  const fBridgeInput =
    fAxle * (TRANS_DEFAULTS.axleGear / TRANS_DEFAULTS.bridgeInput);
  const fMotor =
    fBridgeInput * (TRANS_DEFAULTS.reducerOutput / TRANS_DEFAULTS.motorPinion);
  const fIntermediate =
    fMotor * (TRANS_DEFAULTS.motorPinion / TRANS_DEFAULTS.reducerIntermediate);
  const meshBridge = fAxle * TRANS_DEFAULTS.axleGear;
  const meshReducer = fMotor * TRANS_DEFAULTS.motorPinion;
  return {
    axle: fAxle,
    bridgeInput: fBridgeInput,
    motor: fMotor,
    reducerIntermediate: fIntermediate,
    meshBridge,
    meshReducer,
  };
}
function transmissionLabel(key) {
  return (
    {
      axle: "Essieu",
      bridgeInput: "Sortie réducteur / entrée pont",
      motor: "Moteur — pignon 27 dents",
      reducerIntermediate: "Roue intermédiaire 41 dents",
      meshBridge: "Engrènement pont 44/51",
      meshReducer: "Engrènement réducteur 27/41/51",
    }[key] || key
  );
}
function transmissionReferenceKeys(includeMesh = false) {
  const keys = ["axle", "bridgeInput", "motor", "reducerIntermediate"];
  if (includeMesh) keys.push("meshBridge", "meshReducer");
  return keys;
}
function updateTransmissionSummary() {
  const cfg = getTransmissionConfig(),
    out = $("transSummary");
  if (!out) return;
  const warnings = [];
  for (const [id, axle] of [
    ["transWheelDiameter1", "E1"],
    ["transWheelDiameter2", "E2"],
  ]) {
    const element = $(id);
    if (!element) continue;
    const raw = parseFloat(element.value),
      dMin = TRANS_DEFAULTS.wheelMin,
      dMax = TRANS_DEFAULTS.wheelMax,
      invalid = Number.isFinite(raw) && (raw < dMin || raw > dMax);
    element.setCustomValidity(
      invalid ? `Diamètre de roue admis : ${dMin} à ${dMax} mm` : "",
    );
    if (invalid)
      warnings.push(
        `${axle} ${raw.toFixed(0)} mm refusé — calcul limité à ${raw < dMin ? dMin : dMax} mm`,
      );
  }
  const speedInput = $("transPreviewSpeed"),
    rawSpeed = parseFloat(speedInput?.value),
    speedInvalid =
      Number.isFinite(rawSpeed) && (rawSpeed < 1 || rawSpeed > 326.4);
  speedInput?.setCustomValidity(
    speedInvalid ? "Vitesse autorisée : 1 à 326,4 km/h" : "",
  );
  const f1 = transmissionFrequencies(cfg.previewSpeed, cfg.diameter1)?.[
      cfg.reference
    ],
    f2 = transmissionFrequencies(cfg.previewSpeed, cfg.diameter2)?.[
      cfg.reference
    ],
    tolerance =
      cfg.previewSpeed > 320
        ? '<span class="speed-tolerance">Zone de tolérance +2 %</span>'
        : "";
  out.innerHTML = `<div class="simple-theory"><strong>${transmissionLabel(cfg.reference)} — réglage ${cfg.previewSpeed.toFixed(1)} km/h</strong><span class="theory-e1">E1 Ø${cfg.diameter1.toFixed(0)} : ${f1.toFixed(f1 < 100 ? 1 : 0)} Hz</span><span class="theory-e2">E2 Ø${cfg.diameter2.toFixed(0)} : ${f2.toFixed(f2 < 100 ? 1 : 0)} Hz</span><span>Écart : ${Math.abs(f1 - f2).toFixed(Math.abs(f1 - f2) < 100 ? 1 : 0)} Hz</span>${tolerance}${warnings.length ? `<span class="diameter-warning">${warnings.join(" · ")}</span>` : ""}</div>`;
  if (spectrumZoomRange && currentView === "spectrum") zoomSpectrumToTheory();
  else drawCurrent();
  drawFreqSpeed();
  drawAnalysisTheoryChart();
  if (acqLastPeaks?.length) drawLiveSpectrum(acqLastPeaks);
}
function drawTransmissionLegend(ctx, w, h, items) {
  if (!items.length) return;
  ctx.font = "9px Segoe UI";
  let x = 62,
    y = h - 8;
  items.forEach((item) => {
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(item.dash || []);
    ctx.beginPath();
    ctx.moveTo(x, y - 3);
    ctx.lineTo(x + 17, y - 3);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#4D4F53";
    ctx.fillText(item.label, x + 21, y);
    x += 21 + ctx.measureText(item.label).width + 16;
    if (x > w - 180) {
      x = 62;
      y -= 12;
    }
  });
}
function drawTransmissionSpectrumMarkers(ctx, a, maxF, speedKmh) {
  const cfg = getTransmissionConfig();
  if (!cfg.showTheory) return;
  // v0.9.6 : vitesse réelle (GPS en acquisition, vitesse du fichier en analyse) ; réglage manuel en dernier recours
  const realSpeed = Number.isFinite(speedKmh) && speedKmh > 0,
    speed = realSpeed ? speedKmh : cfg.previewSpeed,
    minF = Number.isFinite(a.xMin) ? a.xMin : 20,
    maxVisible = Number.isFinite(a.xMax) ? a.xMax : maxF,
    items = [];
  ctx.save();
  for (const axle of cfg.axles) {
    const hz = transmissionFrequencies(speed, axle.diameter)?.[cfg.reference];
    if (!Number.isFinite(hz) || hz < minF || hz > maxVisible) continue;
    const x = a.L + ((hz - minF) / (maxVisible - minF)) * (a.w - a.L - a.R);
    ctx.strokeStyle = axle.color;
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 2.4;
    ctx.setLineDash(axle.id === "E1" ? [] : [8, 5]);
    ctx.beginPath();
    ctx.moveTo(x, a.T);
    ctx.lineTo(x, a.h - a.B);
    ctx.stroke();
    items.push({ axle, hz });
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = "700 11px Segoe UI";
  let x = a.L + 8,
    y = a.h - a.B - 10;
  for (const item of items) {
    const text = `${item.axle.id} théorique : ${item.hz.toFixed(1)} Hz`,
      width = ctx.measureText(text).width + 20;
    ctx.fillStyle = "rgba(255,255,255,.94)";
    ctx.fillRect(x - 4, y - 14, width, 18);
    ctx.fillStyle = item.axle.color;
    ctx.fillRect(x, y - 9, 9, 4);
    ctx.fillStyle = "#3C3732";
    ctx.fillText(text, x + 13, y - 4);
    x += width + 9;
  }
  const note = realSpeed
    ? `vitesse réelle : ${speed.toFixed(0)} km/h`
    : `réglage manuel : ${speed.toFixed(0)} km/h (vitesse réelle inconnue)`;
  ctx.fillStyle = "#4D4F53";
  ctx.fillText(note, a.w - a.R - ctx.measureText(note).width - 4, y - 4);
  ctx.restore();
}
function theoreticalErrorStats(data, key, diameter) {
  const values = data
    .map((s) => {
      const f = transmissionFrequencies(s.speed, diameter);
      if (!f || !Number.isFinite(f[key]) || !Number.isFinite(s.fundamental))
        return null;
      const theo = f[key];
      return {
        abs: Math.abs(s.fundamental - theo),
        pct: theo ? (Math.abs(s.fundamental - theo) / theo) * 100 : Infinity,
      };
    })
    .filter(Boolean);
  if (!values.length) return null;
  return {
    meanAbs: values.reduce((a, b) => a + b.abs, 0) / values.length,
    meanPct: values.reduce((a, b) => a + b.pct, 0) / values.length,
    n: values.length,
  };
}
function analysisMeasuredFrequencyData() {
  return records
    .map((record, index) => {
      if (!record?.spectrum) return null;
      const speed = parseFloat(record.speed);
      if (!Number.isFinite(speed) || speed < 0) return null;
      const work = bestWorkingFrequency(record);
      if (!Number.isFinite(work.primary)) return null;
      return {
        record,
        index,
        speed,
        fundamental: work.primary,
        confidence: work.confidence,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.speed - b.speed);
}
function resizeAnalysisTheoryCanvas() {
  const c = $("analysisTheoryChart");
  if (!c) return null;
  const ratio = window.devicePixelRatio || 1;
  const rect = c.getBoundingClientRect();
  const cssW = Math.max(700, Math.floor(rect.width || 1000));
  const cssH = 390;
  c.width = Math.floor(cssW * ratio);
  c.height = Math.floor(cssH * ratio);
  c.style.height = cssH + "px";
  const x = c.getContext("2d");
  x.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { c, ctx: x, w: cssW, h: cssH };
}
function drawAnalysisTheoryChart() {
  const body = $("analysisTheoryTableBody"),
    summary = $("analysisTheorySummary");
  if (!body) return;
  body.innerHTML = "";
  const cfg = getTransmissionConfig(),
    key = cfg.reference,
    data = analysisMeasuredFrequencyData();
  const addRow = (values) => {
    const row = document.createElement("tr");
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    }
    body.appendChild(row);
  };
  if (!data.length) {
    const f1 = transmissionFrequencies(cfg.previewSpeed, cfg.diameter1)?.[key],
      f2 = transmissionFrequencies(cfg.previewSpeed, cfg.diameter2)?.[key];
    addRow([
      "Aperçu",
      `${cfg.previewSpeed.toFixed(0)} km/h`,
      "—",
      `${f1.toFixed(1)} Hz`,
      `${f2.toFixed(1)} Hz`,
      "Chargez un son et lancez l’analyse",
    ]);
    if (summary)
      summary.textContent =
        "Le tableau compare la fréquence mesurée aux deux valeurs théoriques. Rien de plus.";
    return;
  }
  for (const item of data) {
    const f1 = transmissionFrequencies(item.speed, cfg.diameter1)?.[key],
      f2 = transmissionFrequencies(item.speed, cfg.diameter2)?.[key],
      d1 = Math.abs(item.fundamental - f1),
      d2 = Math.abs(item.fundamental - f2),
      bestDelta = Math.min(d1, d2),
      bestTheory = d1 <= d2 ? f1 : f2,
      bestId = d1 <= d2 ? "E1" : "E2",
      relative = bestTheory ? bestDelta / bestTheory : Infinity;
    let result;
    if (relative > 0.25) result = "Non compatible avec cette référence";
    else {
      const estimated = estimateWheelDiameter(
        item.fundamental,
        item.speed,
        key,
      );
      result = `Proche ${bestId}${Number.isFinite(estimated) ? ` — Ø estimé ${estimated.toFixed(0)} mm` : ""}`;
    }
    addRow([
      shortName(item.record.name, 24),
      `${item.speed.toFixed(0)} km/h`,
      `${item.fundamental.toFixed(1)} Hz`,
      `${f1.toFixed(1)} Hz`,
      `${f2.toFixed(1)} Hz`,
      result,
    ]);
  }
  if (summary)
    summary.textContent =
      "Le diamètre estimé n’est affiché que si la mesure est proche de la référence choisie (écart maximal 25 %).";
}

let acqStream = null;
let acqAudioContext = null;
let acqSourceNode = null;
let acqAnalyser = null;
let acqAnimationId = null;
let acqMediaRecorder = null;
let acqRecordedChunks = [];
let acqRecordedBlob = null;
let acqRecordedMime = "";
let acqWatchId = null;
let acqRunning = false;
let acqStartTime = 0;
let acqLastSampleAt = 0;
let acqLastSpectrogramAt = 0;
let acqCurrentSpeed = null;
let acqSpeedOrigin = "—";
let acqGpsAccuracy = null;
let acqLastPosition = null;
let acqMapPosition = null;
let acqGpsAcceptedCount = 0;
let acqGpsRejectedCount = 0;
let acqLastGoodFixAt = 0;
let acqRecentSpeeds = [];
let acqPendingSpeeds = [];
let acqSamples = [];
let acqMarkers = [];
let acqLastPeaks = [];
let acqLastWork = null;
let acqLastSummaryRenderAt = 0;
let acqWaveData = null;
let acqFreqData = null;
// v0.9.7 RC : trois onglets — Acquisition (mesure), Fichiers (données), Diagnostic (interprétation)
let appMode = "analysis";
function setAppMode(mode) {
  if (!["analysis", "acquisition", "diagnostic"].includes(mode)) mode = "analysis";
  appMode = mode;
  [["analysisMode", "modeAnalysis", "analysis"], ["acquisitionMode", "modeAcquisition", "acquisition"], ["diagnosticMode", "modeDiagnostic", "diagnostic"]].forEach(([panel, button, m]) => {
    $(panel)?.classList.toggle("hidden", m !== mode);
    $(button)?.classList.toggle("active", m === mode);
    $(button)?.setAttribute("aria-selected", String(m === mode));
  });
  if (mode === "analysis") {
    resizeCanvas();
    drawCurrent();
  } else if (mode === "acquisition") {
    resizeAcqCanvases();
    setTimeout(initLiveGpsMap, 0);
  } else {
    // les graphiques de l'onglet Diagnostic se redessinent à la bonne largeur
    setTimeout(() => window.dispatchEvent(new Event("resize")), 30);
    window.DiagnosticTGV?.refresh();
  }
  document.dispatchEvent(new CustomEvent("tgv-mode", { detail: mode }));
}
$("modeAnalysis").addEventListener("click", () => setAppMode("analysis"));
$("modeDiagnostic")?.addEventListener("click", () => setAppMode("diagnostic"));
let acqPermissionAttempted = false;
let acqMicPermissionState = "unknown";
let acqGpsPermissionState = "unknown";
$("modeAcquisition").addEventListener("click", async () => {
  setAppMode("acquisition");
  await refreshPermissionStates();
});
function setAcqStatus(text, error = false) {
  const el = $("acqStatus");
  el.textContent = text;
  el.classList.toggle("status-error", error);
}
function permissionClass(state) {
  if (state === "granted") return "acq-perm-state acq-perm-ok";
  if (state === "denied" || state === "unavailable")
    return "acq-perm-state acq-perm-error";
  return "acq-perm-state acq-perm-warn";
}
function permissionText(state, featureAvailable = true) {
  if (!featureAvailable) return "API indisponible";
  if (state === "granted") return "Autorisé";
  if (state === "denied") return "Refusé / bloqué";
  if (state === "unavailable") return "Aucun micro détecté";
  if (state === "prompt") return "Autorisation à demander";
  return "État non déterminé";
}
function setPermissionUi() {
  const micAvailable = !!(
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia
  );
  const gpsAvailable = !!navigator.geolocation;
  const micEl = $("acqMicPermission"),
    gpsEl = $("acqGpsPermission");
  if (micEl) {
    micEl.className = permissionClass(
      micAvailable ? acqMicPermissionState : "denied",
    );
    micEl.textContent = permissionText(acqMicPermissionState, micAvailable);
  }
  if (gpsEl) {
    gpsEl.className = permissionClass(
      gpsAvailable ? acqGpsPermissionState : "denied",
    );
    gpsEl.textContent = permissionText(acqGpsPermissionState, gpsAvailable);
  }
}
async function queryPermissionState(name) {
  try {
    if (!(navigator.permissions && navigator.permissions.query))
      return "unknown";
    const status = await navigator.permissions.query({ name });
    return status.state || "unknown";
  } catch (e) {
    return "unknown";
  }
}
async function refreshPermissionStates() {
  const micAvailable = !!(
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia
  );
  const gpsAvailable = !!navigator.geolocation;
  if (micAvailable) {
    const q = await queryPermissionState("microphone");
    if (
      q === "granted" ||
      q === "denied" ||
      (q !== "unknown" &&
        acqMicPermissionState !== "granted" &&
        acqMicPermissionState !== "unavailable")
    )
      acqMicPermissionState = q;
  } else acqMicPermissionState = "denied";
  if (gpsAvailable) {
    const q = await queryPermissionState("geolocation");
    if (
      q === "granted" ||
      q === "denied" ||
      (q !== "unknown" && acqGpsPermissionState !== "granted")
    )
      acqGpsPermissionState = q;
  } else acqGpsPermissionState = "denied";
  setPermissionUi();
  updateCompatibility();
}
function explainPermissionError(err, kind) {
  const name = err?.name || "Erreur";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return `${kind} refusé ou bloqué par le navigateur / le système. Vérifiez les autorisations du site ou de l’application.`;
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return `${kind} : aucun microphone n’est visible dans Chrome. Vérifiez qu’un micro est branché ou activé, puis Paramètres Windows → Confidentialité et sécurité → Microphone → Autoriser les applications de bureau.`;
  }
  if (name === "SecurityError") {
    return `${kind} bloqué pour des raisons de sécurité. Ouvrez la PWA depuis une adresse HTTPS ou localhost, pas directement avec file://.`;
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return `${kind} détecté mais impossible à ouvrir (déjà utilisé, restriction système ou pilote).`;
  }
  return `${kind} : ${err?.message || name}.`;
}
async function openAcqMicrophoneStream() {
  const raw = $("acqRawAudio")?.checked !== false;
  const preferred = {
    audio: {
      echoCancellation: raw ? false : undefined,
      noiseSuppression: raw ? false : undefined,
      autoGainControl: raw ? false : undefined,
      channelCount: 1,
    },
    video: false,
  };
  try {
    return await navigator.mediaDevices.getUserMedia(preferred);
  } catch (error) {
    if (
      ![
        "NotFoundError",
        "DevicesNotFoundError",
        "OverconstrainedError",
        "ConstraintNotSatisfiedError",
      ].includes(error?.name)
    )
      throw error;
    return await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
  }
}
async function requestMicroPermission() {
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    acqMicPermissionState = "denied";
    setPermissionUi();
    return {
      ok: false,
      message:
        "Microphone : API indisponible. Utilisez la PWA depuis une adresse HTTPS ou localhost.",
    };
  }
  let stream = null,
    firstError = null;
  try {
    stream = await openAcqMicrophoneStream();
  } catch (error) {
    firstError = error;
  }
  if (stream) {
    const track = stream.getAudioTracks()[0],
      label = track?.label?.trim();
    stream.getTracks().forEach((item) => item.stop());
    acqMicPermissionState = "granted";
    setPermissionUi();
    return {
      ok: true,
      message: label
        ? `Microphone autorisé : ${label}.`
        : "Microphone autorisé.",
    };
  }
  console.error("Accès microphone", firstError);
  const noDevice = [
    "NotFoundError",
    "DevicesNotFoundError",
    "OverconstrainedError",
    "ConstraintNotSatisfiedError",
  ].includes(firstError?.name);
  acqMicPermissionState = noDevice
    ? "unavailable"
    : firstError?.name === "NotAllowedError" ||
        firstError?.name === "PermissionDeniedError"
      ? "denied"
      : "prompt";
  setPermissionUi();
  return {
    ok: false,
    message: explainPermissionError(firstError, "Microphone"),
  };
}
async function requestGpsPermission() {
  if (!navigator.geolocation) {
    acqGpsPermissionState = "denied";
    setPermissionUi();
    return {
      ok: false,
      message: "GPS / localisation : API indisponible dans ce contexte.",
    };
  }
  return await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        acqGpsPermissionState = "granted";
        onAcqPosition(pos);
        setPermissionUi();
        resolve({ ok: true, message: "GPS / localisation autorisé." });
      },
      (err) => {
        console.error(err);
        acqGpsPermissionState = err?.code === 1 ? "denied" : "prompt";
        setPermissionUi();
        resolve({
          ok: false,
          message: explainPermissionError(
            {
              name: err?.code === 1 ? "NotAllowedError" : "GeolocationError",
              message: err?.message,
            },
            "GPS / localisation",
          ),
        });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
    );
  });
}
async function requestAcqPermissions(auto = false) {
  const btn = $("acqPermissions");
  if (btn) btn.disabled = true;
  setAcqStatus(
    auto
      ? "Ouverture de l’acquisition : demande des autorisations Microphone puis GPS…"
      : "Demande des autorisations Microphone puis GPS…",
  );
  const messages = [];
  const mic = await requestMicroPermission();
  messages.push(mic.message);
  let gps = {
    ok: true,
    message: "GPS non demandé : source vitesse manuelle sélectionnée.",
  };
  if ($("acqSpeedSource").value === "gps") {
    gps = await requestGpsPermission();
    messages.push(gps.message);
  } else {
    messages.push(gps.message);
  }
  await refreshPermissionStates();
  const ok = mic.ok && gps.ok;
  setAcqStatus(messages.join(" "), !ok);
  const help = $("acqPermissionHelp");
  if (help) {
    const protocol = location.protocol || "inconnu";
    if (
      !window.isSecureContext ||
      !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    ) {
      help.textContent = `Contexte actuel : ${protocol} — sécurisé : ${window.isSecureContext ? "oui" : "non"} — PWA : ${isStandalonePwa() ? "oui" : "non"}. Sur iPhone/iPad, ouvrez la version HTTPS dans Safari, ajoutez-la à l’écran d’accueil puis autorisez Microphone et Localisation.`;
    } else if (!ok) {
      help.textContent =
        "Une autorisation est refusée ou indisponible. Vérifiez les permissions Microphone et Localisation dans les réglages du navigateur / système, puis cliquez de nouveau sur « Autoriser micro + GPS ».";
    } else {
      help.textContent =
        "Microphone et localisation sont autorisés. Vous pouvez maintenant cliquer sur « Démarrer » pour lancer l’acquisition synchronisée.";
    }
  }
  if (btn) btn.disabled = false;
  return ok;
}
function updateCompatibility() {
  const secure = window.isSecureContext;
  const mic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const gps = !!navigator.geolocation;
  const rec = typeof MediaRecorder !== "undefined";
  const protocol = location.protocol || "inconnu";
  let txt = `Protocole : ${protocol}. Contexte sécurisé : ${secure ? "oui" : "non"}. PWA : ${isStandalonePwa() ? "installée" : "navigateur"}. Micro : ${mic ? "API disponible" : "indisponible"}. GPS : ${gps ? "API disponible" : "indisponible"}. Enregistrement : ${rec ? "disponible" : "indisponible"}.`;
  if (!mic)
    txt +=
      " L’API microphone n’est pas exposée par le navigateur dans ce contexte.";
  if (!secure)
    txt +=
      " Les fonctions sensibles sont plus fiables depuis une page HTTPS/PWA.";
  $("acqCompatibility").textContent = txt;
  $("acqAudioCapability").textContent = mic
    ? "Microphone : API disponible. Utilisez « Autoriser micro + GPS » ou « Démarrer »."
    : "Microphone : API indisponible dans ce contexte.";
  setPermissionUi();
}
updateCompatibility();
setTimeout(() => refreshPermissionStates(), 0);
function syncIdentityToAnalysis() {
  if ($("acqRame").value.trim()) $("rame").value = $("acqRame").value.trim();
  if ($("acqMotrice").value.trim())
    $("motrice").value = $("acqMotrice").value.trim();
  if ($("acqTrain").value.trim()) $("train").value = $("acqTrain").value.trim();
  if (!$("date").value) $("date").value = todayIso();
}
function resizeAcqCanvas(canvasEl, height) {
  if (!canvasEl) return;
  const ratio = window.devicePixelRatio || 1;
  const rect = canvasEl.getBoundingClientRect();
  const cssW = Math.max(320, Math.floor(rect.width || 800));
  // v0.9.6 : hauteur réelle affichée (dispositions tablette / téléphone), sinon valeur par défaut
  const cssH = rect.height > 60 ? Math.round(rect.height) : height;
  canvasEl.width = Math.floor(cssW * ratio);
  canvasEl.height = Math.floor(cssH * ratio);
  canvasEl.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
}
function resizeAcqCanvases() {
  resizeAcqCanvas($("acqWave"), 210);
  resizeAcqCanvas($("acqSpectrum"), 210);
  resizeAcqCanvas($("acqSpectrogram"), 280);
  resizeAcqCanvas($("acqSpeedChart"), 210);
  resizeAcqCanvas($("acqFreqSpeedChart"), 210);
  drawEmptyAcqCanvases();
}
function clearAcqCanvas(c) {
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, c.clientWidth, c.clientHeight);
}
function drawEmptyAcqCanvases() {
  [
    "acqWave",
    "acqSpectrum",
    "acqSpectrogram",
    "acqSpeedChart",
    "acqFreqSpeedChart",
  ].forEach((id) => clearAcqCanvas($(id)));
  drawSpeedHistory();
  drawFreqSpeed();
}
function simpleAxes(
  ctx,
  w,
  h,
  title,
  xlabel,
  ylabel,
  xmax,
  ymin,
  ymax,
  xFormatter = null,
) {
  const L = 58,
    R = 18,
    T = 32,
    B = 42;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#4D4F53";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(L, T);
  ctx.lineTo(L, h - B);
  ctx.lineTo(w - R, h - B);
  ctx.stroke();
  ctx.fillStyle = "#3C3732";
  ctx.font = "12px Segoe UI";
  ctx.fillText(title, L, T - 12);
  ctx.fillStyle = "#4D4F53";
  ctx.font = "10px Segoe UI";
  for (let i = 0; i <= 5; i++) {
    const x = L + ((w - L - R) * i) / 5,
      val = (xmax * i) / 5;
    ctx.strokeStyle = "#E1E1E1";
    ctx.beginPath();
    ctx.moveTo(x, T);
    ctx.lineTo(x, h - B);
    ctx.stroke();
    ctx.fillStyle = "#747678";
    ctx.fillText(
      xFormatter ? xFormatter(val) : val.toFixed(0),
      x - 10,
      h - B + 16,
    );
  }
  for (let i = 0; i <= 4; i++) {
    const y = T + ((h - T - B) * i) / 4,
      val = ymax - ((ymax - ymin) * i) / 4;
    ctx.strokeStyle = "#E1E1E1";
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(w - R, y);
    ctx.stroke();
    ctx.fillStyle = "#747678";
    ctx.fillText(val.toFixed(0), 5, y + 3);
  }
  ctx.fillStyle = "#4D4F53";
  ctx.fillText(xlabel, w / 2 - 30, h - 8);
  ctx.save();
  ctx.translate(14, h / 2 + 25);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(ylabel, 0, 0);
  ctx.restore();
  return { L, R, T, B, w, h };
}
function drawLiveWave() {
  if (!acqAnalyser) return;
  const c = $("acqWave"),
    ctx = c.getContext("2d"),
    w = c.clientWidth,
    h = c.clientHeight;
  acqAnalyser.getFloatTimeDomainData(acqWaveData);
  const a = simpleAxes(
    ctx,
    w,
    h,
    "Signal microphone",
    "Temps (fenêtre)",
    "Amplitude",
    1,
    -1,
    1,
    () => "",
  );
  ctx.strokeStyle = "#CD0037";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < acqWaveData.length; i++) {
    const x = a.L + ((w - a.L - a.R) * i) / (acqWaveData.length - 1);
    const y = a.T + ((1 - acqWaveData[i]) * (h - a.T - a.B)) / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
function detectLivePeaks() {
  if (!acqAnalyser || !acqAudioContext) return [];
  acqAnalyser.getFloatFrequencyData(acqFreqData);
  const binHz =
      (acqAudioContext.sampleRate / 2 / acqFreqData.length) *
      frequencyCalibrationFactorFor(acqAudioContext.sampleRate),
    candidates = [];
  for (let i = 2; i < acqFreqData.length - 2; i++) {
    const frequency = i * binHz,
      raw = acqFreqData[i];
    if (frequency < 20 || frequency > 2500 || !Number.isFinite(raw)) continue;
    if (
      raw > acqFreqData[i - 1] &&
      raw > acqFreqData[i + 1] &&
      raw > acqFreqData[i - 2] &&
      raw > acqFreqData[i + 2]
    ) {
      const left = Math.max(0, i - 12),
        right = Math.min(acqFreqData.length - 1, i + 12);
      let baseline = -Infinity;
      for (let j = left; j <= right; j++)
        if (Math.abs(j - i) > 2) baseline = Math.max(baseline, acqFreqData[j]);
      if (raw - baseline > 1.2) {
        const frequencyAxis = {};
        frequencyAxis[i - 1] = (i - 1) * binHz;
        frequencyAxis[i] = frequency;
        frequencyAxis[i + 1] = (i + 1) * binHz;
        const refined = interpolatePeak(frequencyAxis, acqFreqData, i),
          rawV = refined.level;
        candidates.push({
          f: refined.frequency,
          v: rawV,
          rawV,
          aV: rawV + aWeightingCorrection(refined.frequency),
          prominence: raw - baseline,
        });
      }
    }
  }
  candidates.sort((a, b) => b.rawV - a.rawV);
  const chosen = [];
  for (const peak of candidates) {
    if (
      chosen.every((other) => Math.abs(other.f - peak.f) > Math.max(8, binHz))
    ) {
      chosen.push(peak);
      if (chosen.length >= 10) break;
    }
  }
  return chosen;
}
function drawLiveSpectrum(peaks) {
  if (!acqAnalyser || !acqAudioContext) return;
  const c = $("acqSpectrum"),
    ctx = c.getContext("2d"),
    w = c.clientWidth,
    h = c.clientHeight;
  acqAnalyser.getFloatFrequencyData(acqFreqData);
  const min = aWeightingEnabled() ? -150 : -120,
    max = -20;
  const a = simpleAxes(
    ctx,
    w,
    h,
    `FFT temps réel — spectre ${activeModeName()} 0–2500 Hz`,
    "Fréquence (Hz)",
    activeLevelUnit(),
    2500,
    min,
    max,
  );
  const binHz =
    (acqAudioContext.sampleRate / 2 / acqFreqData.length) *
    frequencyCalibrationFactorFor(acqAudioContext.sampleRate);
  ctx.strokeStyle = "#CD0037";
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < acqFreqData.length; i++) {
    const f = i * binHz;
    if (f > 2500) break;
    if (f < 20) continue;
    const raw = acqFreqData[i],
      active = aWeightingEnabled() ? raw + aWeightingCorrection(f) : raw,
      v = Math.max(min, Math.min(max, active));
    const x = a.L + (w - a.L - a.R) * (f / 2500),
      y = a.T + ((max - v) / (max - min)) * (h - a.T - a.B);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  drawTransmissionSpectrumMarkers(
    ctx,
    a,
    2500,
    Number.isFinite(acqCurrentSpeed) ? acqCurrentSpeed : null,
  );
  const analysis = classifyRecordPeaks({ peaks });
  peaks.slice(0, 8).forEach((p, index) => {
    const info = analysis.classifications.get(p);
    let prefix = index === 0 ? "PIC*" : "PIC";
    if (info?.role === "fundamental") prefix = "F";
    else if (info?.role === "harmonic") prefix = `H${info.order}`;
    const x = a.L + (w - a.L - a.R) * (p.f / 2500),
      v = Math.max(min, Math.min(max, peakDisplayedLevel(p))),
      y = a.T + ((max - v) / (max - min)) * (h - a.T - a.B);
    ctx.fillStyle = "#3C3732";
    ctx.font = "10px Segoe UI";
    ctx.fillText(
      `${prefix} ${p.f.toFixed(0)} Hz`,
      Math.max(a.L, x - 20),
      Math.max(a.T + 12, y - 8),
    );
  });
}
function spectrogramColor(value) {
  return vividSpectrogramColor(value, -110, -30);
}
function updateLiveSpectrogram(now) {
  if (!acqAnalyser || !acqAudioContext || now - acqLastSpectrogramAt < 110)
    return;
  acqLastSpectrogramAt = now;
  const c = $("acqSpectrogram"),
    ctx = c.getContext("2d"),
    w = c.clientWidth,
    h = c.clientHeight;
  acqAnalyser.getFloatFrequencyData(acqFreqData);
  const plotLeft = 45,
    plotRight = 10,
    plotTop = 26,
    plotBottom = 26,
    plotW = w - plotLeft - plotRight,
    plotH = h - plotTop - plotBottom;
  ctx.drawImage(
    c,
    plotLeft + 1,
    plotTop,
    plotW - 1,
    plotH,
    plotLeft,
    plotTop,
    plotW - 1,
    plotH,
  );
  const binHz =
    (acqAudioContext.sampleRate / 2 / acqFreqData.length) *
    frequencyCalibrationFactorFor(acqAudioContext.sampleRate);
  for (let y = 0; y < plotH; y++) {
    const f = 2500 * (1 - y / plotH),
      idx = Math.max(
        0,
        Math.min(acqFreqData.length - 1, Math.round(f / binHz)),
      ),
      value =
        acqFreqData[idx] + (aWeightingEnabled() ? aWeightingCorrection(f) : 0);
    ctx.fillStyle = vividSpectrogramColor(value, -110, -30);
    ctx.fillRect(plotLeft + plotW - 1, plotTop + y, 1, 1);
  }
  const cfg = getTransmissionConfig();
  if (cfg.showTheory && Number.isFinite(acqCurrentSpeed)) {
    const keys = theoryKeysForConfig(cfg);
    for (const axle of cfg.axles) {
      const frequencies = transmissionFrequencies(
        acqCurrentSpeed,
        axle.diameter,
      );
      for (const key of keys) {
        const hz = frequencies?.[key];
        if (!Number.isFinite(hz) || hz < 20 || hz > 2500) continue;
        if (axle.id === "E2" && Math.floor(now / 220) % 2) continue;
        const y = plotTop + (1 - hz / 2500) * plotH;
        ctx.fillStyle = axle.color;
        ctx.fillRect(
          plotLeft + plotW - 2,
          y - 1,
          2,
          key === cfg.reference ? 3 : 2,
        );
      }
    }
  }
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, plotLeft, plotTop + plotH + plotBottom);
  ctx.fillRect(plotLeft, 0, plotW + plotRight, plotTop);
  ctx.strokeStyle = "#4D4F53";
  ctx.beginPath();
  ctx.moveTo(plotLeft, plotTop);
  ctx.lineTo(plotLeft, plotTop + plotH);
  ctx.lineTo(plotLeft + plotW, plotTop + plotH);
  ctx.stroke();
  ctx.fillStyle = "#3C3732";
  ctx.font = "11px Segoe UI";
  ctx.fillText(
    `Spectrogramme ${activeModeName()} — noir = faible, jaune/blanc = élevé`,
    plotLeft,
    13,
  );
  ctx.font = "9px Segoe UI";
  for (let i = 0; i <= 5; i++) {
    const yy = plotTop + (plotH * i) / 5,
      f = 2500 * (1 - i / 5);
    ctx.fillStyle = "#747678";
    ctx.fillText(f.toFixed(0), 3, yy + 3);
  }
  ctx.fillStyle = "#747678";
  ctx.fillText("Hz", 5, h - 7);
  ctx.fillText("Temps →", w - 62, h - 7);
}
function updateLiveSummary(peaks) {
  acqLastPeaks = peaks;
  const now = performance.now();
  if (acqRunning && now - acqLastSummaryRenderAt < 750) return;
  acqLastSummaryRenderAt = now;
  if (!peaks.length) {
    acqLastWork = null;
    $("acqLiveSummary").textContent =
      "Aucun pic brut suffisamment proéminent détecté.";
    return;
  }
  const pseudo = { peaks },
    analysis = classifyRecordPeaks(pseudo),
    work = bestWorkingFrequency(pseudo);
  acqLastWork = work;
  const dominant = peaks[0];
  $("acqPeakKpi").textContent = `${dominant.f.toFixed(0)} Hz`;
  $("acqFundKpi").textContent =
    work.primary !== null ? `${work.primary.toFixed(0)} Hz` : "—";
  const families = analysis.families
    .slice(0, 3)
    .map(
      (family) =>
        `F ${family.base.f.toFixed(1)} Hz (${family.confidence.toLowerCase()}) → ${family.members.map((member) => `H${member.order} ${member.peak.f.toFixed(1)}`).join(", ")}`,
    );
  let text = `Diagnostic brut — PIC dominant : ${dominant.f.toFixed(2)} Hz ; brut ${dominant.rawV.toFixed(1)} dB relatif ; A ${dominant.aV.toFixed(1)} dB(A) relatif. Affichage : ${activeModeName()}.\n`;
  if (work.primary !== null)
    text += `Fréquence de travail brute : ${work.primary.toFixed(2)} Hz — confiance ${work.confidence.toLowerCase()}.\n`;
  if (families.length) text += `Familles : ${families.join(" | ")}.\n`;
  text +=
    weightingDisclaimer() +
    "\nLes niveaux fichier et direct ne sont pas directement comparables : fenêtres, moyennage et lissage diffèrent.";
  $("acqLiveSummary").textContent = text;
}

const HIGH_SPEED_STATIONS = [
  { name: "Paris Nord", lat: 48.8809, lon: 2.3553 },
  { name: "Paris Lyon", lat: 48.8443, lon: 2.3739 },
  { name: "Lille Europe", lat: 50.6394, lon: 3.0758 },
  { name: "Strasbourg", lat: 48.5852, lon: 7.7346 },
  { name: "Lyon Part-Dieu", lat: 45.7606, lon: 4.8594 },
  { name: "Marseille", lat: 43.3028, lon: 5.3804 },
  { name: "Bordeaux", lat: 44.8259, lon: -0.5567 },
  { name: "Rennes", lat: 48.1032, lon: -1.6721 },
  { name: "Nantes", lat: 47.2173, lon: -1.5419 },
  { name: "Montpellier", lat: 43.6046, lon: 3.8807 },
  { name: "Bruxelles Midi", lat: 50.8357, lon: 4.3365 },
  { name: "Liège", lat: 50.6246, lon: 5.5667 },
  { name: "Anvers", lat: 51.2172, lon: 4.4211 },
  { name: "Rotterdam", lat: 51.9249, lon: 4.469 },
  { name: "Amsterdam", lat: 52.3791, lon: 4.9003 },
  { name: "Londres St Pancras", lat: 51.5317, lon: -0.1263 },
  { name: "Francfort", lat: 50.1071, lon: 8.6638 },
  { name: "Mannheim", lat: 49.4792, lon: 8.4699 },
  { name: "Karlsruhe", lat: 49.0135, lon: 8.4044 },
  { name: "Stuttgart", lat: 48.7834, lon: 9.1816 },
  { name: "Munich", lat: 48.1402, lon: 11.5586 },
  { name: "Cologne", lat: 50.943, lon: 6.9587 },
  { name: "Düsseldorf", lat: 51.2199, lon: 6.7943 },
  { name: "Freiburg", lat: 47.9978, lon: 7.8418 },
];
let liveGpsMap = null,
  liveGpsMapReady = false,
  liveGpsMapFirstFix = true;
function routeGpsPoints() {
  return acqSamples.filter(
    (sample) =>
      Number.isFinite(sample.latitude) && Number.isFinite(sample.longitude),
  );
}
function routeDistanceMeters(points = routeGpsPoints()) {
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += haversineMeters(
      points[i - 1].latitude,
      points[i - 1].longitude,
      points[i].latitude,
      points[i].longitude,
    );
  return total;
}
function nearestHighSpeedStation(lat, lon) {
  let best = null;
  for (const station of HIGH_SPEED_STATIONS) {
    const distance = haversineMeters(lat, lon, station.lat, station.lon);
    if (!best || distance < best.distance) best = { station, distance };
  }
  return best;
}
function gpsStationGeoJson() {
  return {
    type: "FeatureCollection",
    features: HIGH_SPEED_STATIONS.map((station) => ({
      type: "Feature",
      properties: { name: station.name },
      geometry: { type: "Point", coordinates: [station.lon, station.lat] },
    })),
  };
}
function gpsRouteGeoJson() {
  const points = routeGpsPoints();
  return {
    type: "FeatureCollection",
    features: points.length
      ? [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: points.map((point) => [
                point.longitude,
                point.latitude,
              ]),
            },
          },
        ]
      : [],
  };
}
function gpsCurrentGeoJson() {
  const current = acqMapPosition?.coords,
    accuracy = Number.isFinite(current?.accuracy) ? current.accuracy : null;
  return {
    type: "FeatureCollection",
    features:
      current &&
      Number.isFinite(current.latitude) &&
      Number.isFinite(current.longitude)
        ? [
            {
              type: "Feature",
              properties: {
                approximate:
                  accuracy === null ||
                  accuracy > STABILITY_CONFIG.gpsSpeedMaxAccuracyMeters,
                accuracy,
              },
              geometry: {
                type: "Point",
                coordinates: [current.longitude, current.latitude],
              },
            },
          ]
        : [],
  };
}
function setGpsMapState(text, kind = "") {
  const el = $("acqMapState");
  if (!el) return;
  el.textContent = text;
  el.className = ("acq-map-state " + kind).trim();
}
function showGpsFallback(
  message = "Carte détaillée indisponible. Le GPS et les exports restent actifs.",
) {
  $("acqMapLive")?.classList.add("hidden");
  $("acqMapFallback")?.classList.remove("hidden");
  $("acqMapFallback").textContent = message;
  setGpsMapState("Mode sans fond cartographique", "offline");
}
function updateGpsMapInfo() {
  const info = $("acqPositionInfo"),
    button = $("acqExportGeoJson"),
    clear = $("acqClearTrack"),
    center = $("acqMapCenter"),
    points = routeGpsPoints(),
    current = acqMapPosition?.coords;
  if (button) button.disabled = !points.length;
  if (clear) clear.disabled = !points.length;
  if (center)
    center.disabled = !(
      current &&
      Number.isFinite(current.latitude) &&
      Number.isFinite(current.longitude)
    );
  if (!info) return;
  if (
    !current ||
    !Number.isFinite(current.latitude) ||
    !Number.isFinite(current.longitude)
  ) {
    info.textContent = points.length
      ? points.length +
        " point(s) GPS enregistrés · trajet " +
        (routeDistanceMeters(points) / 1000).toFixed(2) +
        " km."
      : "En attente d’une position GPS.";
    return;
  }
  const accuracy = Number.isFinite(current.accuracy) ? current.accuracy : null,
    approximate =
      accuracy === null || accuracy > STABILITY_CONFIG.gpsSpeedMaxAccuracyMeters,
    nearest = nearestHighSpeedStation(current.latitude, current.longitude);
  info.textContent =
    (approximate
      ? "Position approximative (point orange, non utilisé pour la vitesse) : "
      : "Position GPS : ") +
    current.latitude.toFixed(5) +
    ", " +
    current.longitude.toFixed(5) +
    " · précision " +
    (accuracy !== null ? "±" + accuracy.toFixed(0) + " m" : "inconnue") +
    " · trajet validé " +
    (routeDistanceMeters(points) / 1000).toFixed(2) +
    " km · gare la plus proche : " +
    nearest.station.name +
    " (" +
    (nearest.distance / 1000).toFixed(1) +
    " km).";
}
function updateLiveGpsMap() {
  updateGpsMapInfo();
  if (!liveGpsMapReady || !liveGpsMap) return;
  liveGpsMap.getSource("gps-route")?.setData(gpsRouteGeoJson());
  liveGpsMap.getSource("gps-current")?.setData(gpsCurrentGeoJson());
  const coords = acqMapPosition?.coords;
  if (
    coords &&
    Number.isFinite(coords.latitude) &&
    Number.isFinite(coords.longitude) &&
    $("acqMapFollow")?.checked
  ) {
    liveGpsMap.easeTo({
      center: [coords.longitude, coords.latitude],
      zoom: liveGpsMapFirstFix ? 11 : Math.max(liveGpsMap.getZoom(), 9),
      duration: prefersReducedMotion() ? 0 : 650,
    });
    liveGpsMapFirstFix = false;
  }
}
function initLiveGpsMap() {
  if (liveGpsMap) {
    setTimeout(() => liveGpsMap?.resize(), 0);
    return;
  }
  if (!window.maplibregl) {
    showGpsFallback(
      "Bibliothèque cartographique indisponible. Le GPS et les exports restent actifs.",
    );
    return;
  }
  try {
    liveGpsMap = new maplibregl.Map({
      container: "acqMapLive",
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [4.5, 50.2],
      zoom: 4.2,
      minZoom: 3,
      maxZoom: 18,
      attributionControl: true,
    });
    liveGpsMap.addControl(
      new maplibregl.NavigationControl({ showCompass: true }),
      "top-right",
    );
    liveGpsMap.on("load", () => {
      liveGpsMapReady = true;
      liveGpsMap.addSource("tgv-stations", {
        type: "geojson",
        data: gpsStationGeoJson(),
      });
      liveGpsMap.addLayer({
        id: "tgv-station-points",
        type: "circle",
        source: "tgv-stations",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 3.5, 9, 6],
          "circle-color": "#FFB612",
          "circle-stroke-color": "#3C3732",
          "circle-stroke-width": 1.5,
        },
      });
      liveGpsMap.addLayer({
        id: "tgv-station-labels",
        type: "symbol",
        source: "tgv-stations",
        minzoom: 5,
        layout: {
          "text-field": ["get", "name"],
          "text-size": 12,
          "text-offset": [0, 1.15],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#3C3732",
          "text-halo-color": "#FFFFFF",
          "text-halo-width": 2,
        },
      });
      liveGpsMap.addSource("gps-route", {
        type: "geojson",
        data: gpsRouteGeoJson(),
      });
      liveGpsMap.addLayer({
        id: "gps-route-line",
        type: "line",
        source: "gps-route",
        paint: {
          "line-color": "#D52B1E",
          "line-width": 5,
          "line-opacity": 0.9,
        },
      });
      liveGpsMap.addSource("gps-current", {
        type: "geojson",
        data: gpsCurrentGeoJson(),
      });
      liveGpsMap.addLayer({
        id: "gps-current-point",
        type: "circle",
        source: "gps-current",
        paint: {
          "circle-radius": 8,
          "circle-color": [
            "case",
            ["get", "approximate"],
            "#FFB612",
            "#0088CE",
          ],
          "circle-stroke-color": "#FFFFFF",
          "circle-stroke-width": 3,
        },
      });
      liveGpsMap.on("click", "tgv-station-points", (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const label = document.createElement("strong");
        label.textContent = String(feature.properties?.name || "Gare");
        new maplibregl.Popup({ offset: 10 })
          .setLngLat(feature.geometry.coordinates)
          .setDOMContent(label)
          .addTo(liveGpsMap);
      });
      liveGpsMap.on("mouseenter", "tgv-station-points", () => {
        liveGpsMap.getCanvas().style.cursor = "pointer";
      });
      liveGpsMap.on("mouseleave", "tgv-station-points", () => {
        liveGpsMap.getCanvas().style.cursor = "";
      });
      $("acqMapFallback")?.classList.add("hidden");
      $("acqMapLive")?.classList.remove("hidden");
      setGpsMapState("Carte détaillée en direct", "online");
      updateLiveGpsMap();
    });
    liveGpsMap.on("error", (event) => {
      console.warn("Carte GPS :", event?.error || event);
      if (!liveGpsMapReady) showGpsFallback();
    });
    setTimeout(() => {
      if (!liveGpsMapReady)
        showGpsFallback(
          "Connexion cartographique indisponible. Le GPS et les exports restent actifs.",
        );
    }, 12000);
  } catch (error) {
    console.error("Initialisation carte GPS :", error);
    showGpsFallback();
  }
}
function showGpsOverview() {
  if (!liveGpsMapReady || !liveGpsMap) return;
  liveGpsMap.fitBounds(
    [
      [-6.5, 42],
      [16.5, 58.5],
    ],
    { padding: 35, duration: prefersReducedMotion() ? 0 : 700 },
  );
}
function centerOnGpsPosition() {
  const coords = acqMapPosition?.coords;
  if (
    !coords ||
    !Number.isFinite(coords.latitude) ||
    !Number.isFinite(coords.longitude)
  ) {
    setGpsMapState("Aucune position disponible", "offline");
    return;
  }
  if (!liveGpsMapReady || !liveGpsMap) {
    setGpsMapState(
      "Position reçue, mais fond de carte indisponible",
      "offline",
    );
    return;
  }
  liveGpsMap.easeTo({
    center: [coords.longitude, coords.latitude],
    zoom: 13,
    duration: prefersReducedMotion() ? 0 : 500,
  });
}
function exportGpsGeoJson() {
  const points = routeGpsPoints();
  if (!points.length) return;
  const coordinates = points.map((point) => [
      point.longitude,
      point.latitude,
      ...(Number.isFinite(point.altitude) ? [point.altitude] : []),
    ]),
    geometry =
      coordinates.length === 1
        ? { type: "Point", coordinates: coordinates[0] }
        : { type: "LineString", coordinates };
  const geojson = {
    type: "FeatureCollection",
    name: "Trajet acquisition TGV",
    features: [
      {
        type: "Feature",
        properties: {
          motrice: $("acqMotrice").value.trim(),
          train: $("acqTrain").value.trim(),
          startedAt: points[0].timestamp,
          endedAt: points.at(-1).timestamp,
          distanceKm: Number((routeDistanceMeters(points) / 1000).toFixed(3)),
          pointCount: points.length,
        },
        geometry,
      },
    ],
  };
  downloadText(
    acqSessionBaseName() + "_GPS.geojson",
    JSON.stringify(geojson, null, 2),
    "application/geo+json;charset=utf-8",
  );
}
function clearGpsTrack() {
  for (const sample of acqSamples) {
    sample.latitude = null;
    sample.longitude = null;
    sample.altitude = null;
    sample.heading = null;
  }
  updateLiveGpsMap();
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000,
    rad = Math.PI / 180;
  const p1 = lat1 * rad,
    p2 = lat2 * rad,
    dP = (lat2 - lat1) * rad,
    dL = (lon2 - lon1) * rad;
  const a =
    Math.sin(dP / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dL / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
/* Traitement d'une position GPS : calcul d'une vitesse fiable.
 * Filtres successifs :
 *   1. précision > 80 m : position ignorée ; > 25 m : position affichée mais pas de vitesse ;
 *   2. vitesse fournie par la puce GPS (effet Doppler, la plus précise) si disponible ;
 *      sinon vitesse = distance entre deux positions (formule de haversine) / temps.
 *      Si la distance est inférieure à l'incertitude des deux positions, le train est
 *      considéré à l'arrêt (évite les fausses vitesses dues au « bruit » GPS) ;
 *   3. rejet des valeurs impossibles : > 326,4 km/h ou accélération > 3,5 m/s² ;
 *   4. RESYNCHRONISATION : si 3 mesures rejetées sont cohérentes entre elles (écart
 *      ≤ 10 %), c'est que le GPS est revenu alors que le train roule déjà : on les accepte ;
 *   5. lissage : médiane des 3 dernières vitesses (supprime une valeur isolée fausse). */
function onAcqPosition(pos) {
  // v0.9.6 : filtrage renforcé — une position imprécise ne produit plus de vitesse
  // (à l'arrêt en intérieur, les sauts de ±50–80 m donnaient de fausses vitesses).
  acqGpsPermissionState = "granted";
  setPermissionUi();
  const c = pos.coords,
    accuracy = Number.isFinite(c.accuracy) ? c.accuracy : null,
    speedLimit = STABILITY_CONFIG.gpsSpeedMaxAccuracyMeters;
  acqMapPosition = pos;
  if (accuracy === null || accuracy > STABILITY_CONFIG.gpsMaxAccuracyMeters) {
    acqGpsRejectedCount++;
    acqGpsAccuracy = accuracy;
    $("acqGpsInfo").textContent =
      `GPS : position affichée en orange, mais non utilisée pour la vitesse (précision ${accuracy === null ? "inconnue" : "±" + accuracy.toFixed(0) + " m"}; limite ±${STABILITY_CONFIG.gpsMaxAccuracyMeters} m).`;
    updateLiveGpsMap();
    return;
  }
  if (accuracy > speedLimit) {
    // position assez bonne pour la carte, trop imprécise pour une vitesse
    acqGpsRejectedCount++;
    acqGpsAccuracy = accuracy;
    $("acqGpsInfo").textContent =
      `GPS : précision ±${accuracy.toFixed(0)} m — position affichée, vitesse non calculée (il faut ±${speedLimit} m ou mieux : placez la tablette contre une vitre).`;
    updateLiveGpsMap();
    return;
  }
  let speed = null,
    origin = "GPS",
    dt = null;
  if (acqLastPosition) dt = (pos.timestamp - acqLastPosition.timestamp) / 1000;
  if (Number.isFinite(c.speed) && c.speed >= 0) {
    speed = c.speed * 3.6;
    if (speed < 2) speed = 0;
    origin = "GPS direct filtré";
  } else if (acqLastPosition && dt >= STABILITY_CONFIG.gpsMinIntervalSeconds) {
    const d = haversineMeters(
      acqLastPosition.coords.latitude,
      acqLastPosition.coords.longitude,
      c.latitude,
      c.longitude,
    );
    const noise = (accuracy + (acqLastPosition.coords.accuracy || accuracy)) / 2;
    // déplacement inférieur à l'incertitude : considéré comme arrêt
    speed = d <= noise ? 0 : (d / dt) * 3.6;
    origin = "GPS calculé filtré";
  }
  const accelerationOk =
    !Number.isFinite(speed) ||
    !Number.isFinite(acqCurrentSpeed) ||
    !Number.isFinite(dt) ||
    dt <= 0 ||
    Math.abs(speed - acqCurrentSpeed) / 3.6 / dt <=
      STABILITY_CONFIG.gpsMaxAccelerationMps2;
  let resync = false;
  if (
    Number.isFinite(speed) &&
    (speed < 0 || speed > STABILITY_CONFIG.gpsMaxSpeedKmh || !accelerationOk)
  ) {
    // v0.9.6 : 3 mesures cohérentes entre elles malgré le saut => resynchronisation
    // (ex. GPS retrouvé alors que le train roule déjà à 300 km/h).
    if (speed >= 0 && speed <= STABILITY_CONFIG.gpsMaxSpeedKmh) acqPendingSpeeds.push(speed);
    if (acqPendingSpeeds.length > 3) acqPendingSpeeds.shift();
    const ps = [...acqPendingSpeeds].sort((x, y) => x - y),
      mid = ps[Math.floor(ps.length / 2)];
    if (ps.length >= 3 && ps[ps.length - 1] - ps[0] <= Math.max(5, 0.1 * mid)) {
      resync = true;
      speed = mid;
      acqRecentSpeeds = [];
    } else {
      acqGpsRejectedCount++;
      $("acqGpsInfo").textContent =
        `GPS : position affichée, mais vitesse ignorée (${speed.toFixed(0)} km/h ou variation incohérente).`;
      updateLiveGpsMap();
      return;
    }
  }
  acqPendingSpeeds = [];
  if (resync) origin += " (resynchronisé)";
  acqLastPosition = pos;
  acqMapPosition = pos;
  acqGpsAccuracy = accuracy;
  acqGpsAcceptedCount++;
  acqLastGoodFixAt = performance.now();
  if (Number.isFinite(speed)) {
    acqRecentSpeeds.push(speed);
    if (acqRecentSpeeds.length > 3) acqRecentSpeeds.shift();
    const sorted = [...acqRecentSpeeds].sort((x, y) => x - y);
    acqCurrentSpeed = sorted[Math.floor(sorted.length / 2)];
    acqSpeedOrigin = origin;
  }
  $("acqGpsInfo").textContent =
    `GPS : ${acqSpeedOrigin} — précision ±${accuracy.toFixed(0)} m — ${acqGpsAcceptedCount} point(s) accepté(s), ${acqGpsRejectedCount} rejeté(s)`;
  updateSpeedDisplays();
  updateLiveGpsMap();
}
function onAcqPositionError(err) {
  if (err?.code === 1) acqGpsPermissionState = "denied";
  setPermissionUi();
  $("acqGpsInfo").textContent =
    `GPS indisponible : ${err.message}. Passez en saisie manuelle si nécessaire.`;
  if ($("acqSpeedSource").value === "gps")
    setAcqStatus(
      "Audio actif, mais vitesse GPS indisponible. Vous pouvez sélectionner la saisie manuelle.",
      true,
    );
}
function startGpsIfNeeded() {
  if ($("acqSpeedSource").value !== "gps") return;
  if (!navigator.geolocation) {
    onAcqPositionError({ message: "API géolocalisation absente" });
    return;
  }
  acqWatchId = navigator.geolocation.watchPosition(
    onAcqPosition,
    onAcqPositionError,
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
  );
}
function stopGps() {
  if (acqWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(acqWatchId);
    acqWatchId = null;
  }
}
function updateSpeedDisplays() {
  // v0.9.6 : vitesse GPS effacée si aucune position précise depuis 5 s
  if (
    $("acqSpeedSource").value !== "manual" &&
    Number.isFinite(acqCurrentSpeed) &&
    performance.now() - acqLastGoodFixAt > 5000
  ) {
    acqCurrentSpeed = null;
    acqRecentSpeeds = [];
    acqSpeedOrigin = "GPS imprécis";
  }
  if ($("acqSpeedSource").value === "manual") {
    const v = parseFloat($("acqManualSpeed").value);
    acqCurrentSpeed = Number.isFinite(v) ? v : null;
    acqSpeedOrigin = "Manuelle";
    acqGpsAccuracy = null;
  }
  const txt = Number.isFinite(acqCurrentSpeed)
    ? acqCurrentSpeed.toFixed(0)
    : "—";
  $("acqSpeedBig").textContent = txt;
  $("acqSpeedKpi").textContent = txt === "—" ? "—" : txt + " km/h";
}
$("acqSpeedSource").addEventListener("change", () => {
  const manual = $("acqSpeedSource").value === "manual";
  $("acqManualSpeedBox").classList.toggle("hidden", !manual);
  if (acqRunning) {
    stopGps();
    if (!manual) startGpsIfNeeded();
  }
  updateSpeedDisplays();
});
$("acqManualSpeed").addEventListener("input", updateSpeedDisplays);
function chooseRecorderMime() {
  if (typeof MediaRecorder === "undefined") return "";
  const types = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/webm",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
}
function extensionForMime(mime) {
  if (mime.includes("wav")) return "wav";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("webm")) return "webm";
  return "audio";
}
function downloadBlob(filename, blob) {
  if (acqDownloadCapture) {
    acqDownloadCapture.push({ name: filename, blob });
    return;
  }
  const u = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = u;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 1200);
}
/* Démarrage de l'acquisition temps réel.
 * - Le micro est ouvert SANS traitement (pas d'annulation d'écho, pas de réduction de
 *   bruit, pas de contrôle automatique du gain) : ces traitements, faits pour la voix,
 *   modifieraient les niveaux et effaceraient justement les sons permanents recherchés.
 * - Un « AnalyserNode » du navigateur calcule la FFT en continu (taille réglable,
 *   lissage temporel 0,55 entre deux images pour un affichage stable).
 * - En parallèle, le son brut est enregistré en WAV (wav-recorder-v096.js).
 * - Toutes les 0,5 s, campbell-v096.js prélève un spectre pour le diagramme de Campbell ;
 *   chaque seconde, captureAcqSample écrit une ligne du CSV (vitesse, GPS, pics, régime). */
async function startAcquisition() {
  if (acqRunning) return;
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    setAcqStatus(
      "Microphone indisponible dans ce contexte. Consultez « Autorisations d’acquisition ». Sur mobile, utilisez de préférence une version HTTPS/PWA.",
      true,
    );
    await refreshPermissionStates();
    return;
  }
  try {
    syncIdentityToAnalysis();
    acqStream = await openAcqMicrophoneStream();
    acqMicPermissionState = "granted";
    setPermissionUi();
    acqAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    await acqAudioContext.resume();
    acqSourceNode = acqAudioContext.createMediaStreamSource(acqStream);
    acqAnalyser = acqAudioContext.createAnalyser();
    acqAnalyser.fftSize = parseInt($("acqFftSize").value) || 8192;
    acqAnalyser.smoothingTimeConstant = 0.55;
    acqSourceNode.connect(acqAnalyser);
    acqWaveData = new Float32Array(acqAnalyser.fftSize);
    acqFreqData = new Float32Array(acqAnalyser.frequencyBinCount);
    acqRecordedChunks = [];
    acqRecordedBlob = null;
    acqRecordedMime = "";
    // v0.9.6 : enregistrement WAV (lisible partout) ; MediaRecorder en repli
    const wavRecorder = window.createAcqRecorder
      ? await window.createAcqRecorder(acqStream, acqAudioContext, acqSourceNode)
      : null;
    if (wavRecorder || typeof MediaRecorder !== "undefined") {
      const mime = wavRecorder ? "audio/wav" : chooseRecorderMime();
      acqMediaRecorder = wavRecorder
        ? wavRecorder
        : mime
          ? new MediaRecorder(acqStream, { mimeType: mime })
          : new MediaRecorder(acqStream);
      acqRecordedMime =
        acqMediaRecorder.mimeType || mime || "application/octet-stream";
      acqMediaRecorder.addEventListener("dataavailable", (e) => {
        if (e.data && e.data.size) acqRecordedChunks.push(e.data);
      });
      acqMediaRecorder.addEventListener("stop", () => {
        acqRecordedBlob = new Blob(acqRecordedChunks, {
          type: acqRecordedMime || "audio/webm",
        });
        $("acqDownloadAudio").disabled = acqRecordedBlob.size === 0;
        $("acqSendAnalysis").disabled = acqRecordedBlob.size === 0;
      });
      acqMediaRecorder.start(1000);
    }
    acqSamples = [];
    acqMarkers = [];
    acqLastPeaks = [];
    acqLastWork = null;
    acqLastSummaryRenderAt = 0;
    acqLastPosition = null;
    acqMapPosition = null;
    acqCurrentSpeed = null;
    acqGpsAccuracy = null;
    acqGpsAcceptedCount = 0;
    acqGpsRejectedCount = 0;
    acqLastGoodFixAt = 0;
    acqRecentSpeeds = [];
    acqPendingSpeeds = [];
    $("acqDataBody").innerHTML = "";
    renderAcqMarkers();
    acqStartTime = performance.now();
    acqSessionStartDate = new Date();
    acqLastSampleAt = 0;
    acqLastSpectrogramAt = 0;
    acqRunning = true;
    $("acqState").textContent = "LIVE";
    $("acqState").className = "acq-live";
    $("acqStart").disabled = true;
    $("acqStop").disabled = false;
    $("acqMark").disabled = false;
    $("acqStart").classList.add("acq-button-recording");
    $("acqExportJson").disabled = true;
    $("acqExportCsv").disabled = true;
    $("acqDownloadAudio").disabled = true;
    $("acqSendAnalysis").disabled = true;
    resizeAcqCanvases();
    startGpsIfNeeded();
    updateSpeedDisplays();
    setAcqStatus(
      `Acquisition en cours — audio : ${acqRecordedMime.includes("wav") ? window.acqRecorderInfo || "WAV" : (acqRecordedMime || "format inconnu") + (window.acqRecorderInfo ? " — " + window.acqRecorderInfo : "")}. La vitesse est synchronisée à chaque seconde lorsqu’elle est disponible.`,
    );
    acqLoop(performance.now());
  } catch (err) {
    console.error(err);
    if (err?.name === "NotAllowedError") acqMicPermissionState = "denied";
    setPermissionUi();
    setAcqStatus(
      "Impossible de démarrer l’acquisition : " +
        explainPermissionError(err, "Microphone"),
      true,
    );
    stopAcquisition(true);
  }
}
let acqLastDrawAt = 0;
function acqLoop(now) {
  if (!acqRunning) return;
  // v0.9.8 : l'affichage est rafraîchi à 15 images/s au lieu de 60 (l'oeil ne voit pas la différence,
  // la tablette travaille 4 fois moins) ; la mesure (captureAcqSample) garde sa cadence d'1 s.
  if (now - acqLastDrawAt >= 66) {
    acqLastDrawAt = now;
    drawLiveWave();
    const peaks = detectLivePeaks();
    drawLiveSpectrum(peaks);
    updateLiveSummary(peaks);
    updateLiveSpectrogram(now);
  }
  if (now - acqLastSampleAt >= 1000) {
    acqLastSampleAt = now;
    captureAcqSample(now);
  }
  acqAnimationId = requestAnimationFrame(acqLoop);
}
function captureAcqSample(now) {
  updateSpeedDisplays();
  const elapsed = (now - acqStartTime) / 1000,
    dominantPeak = acqLastPeaks[0] || null,
    work = acqLastWork;
  const coordinates = acqLastPosition?.coords;
  const row = {
    elapsed: Number(elapsed.toFixed(3)),
    timestamp: new Date().toISOString(),
    latitude: Number.isFinite(coordinates?.latitude)
      ? Number(coordinates.latitude.toFixed(7))
      : null,
    longitude: Number.isFinite(coordinates?.longitude)
      ? Number(coordinates.longitude.toFixed(7))
      : null,
    altitude: Number.isFinite(coordinates?.altitude)
      ? Number(coordinates.altitude.toFixed(1))
      : null,
    heading: Number.isFinite(coordinates?.heading)
      ? Number(coordinates.heading.toFixed(1))
      : null,
    speed: Number.isFinite(acqCurrentSpeed)
      ? Number(acqCurrentSpeed.toFixed(2))
      : null,
    speedSource: acqSpeedOrigin,
    gpsAccuracy:
      acqGpsAccuracy === null ? null : Number(acqGpsAccuracy.toFixed(1)),
    dominant: dominantPeak ? Number(dominantPeak.f.toFixed(2)) : null,
    dominantLevel: dominantPeak
      ? Number(peakDisplayedLevel(dominantPeak).toFixed(2))
      : null,
    dominantLevelRaw: dominantPeak
      ? Number(dominantPeak.rawV.toFixed(2))
      : null,
    dominantLevelA: dominantPeak ? Number(dominantPeak.aV.toFixed(2)) : null,
    weightingMode: activeModeName(),
    levelUnit: activeLevelUnit(),
    fundamental:
      work?.primary === null || work?.primary === undefined
        ? null
        : Number(work.primary.toFixed(2)),
    confidence: work?.confidence || null,
    regime: $("acqRegime").value,
  };
  if (window.CampbellTGV) Object.assign(row, window.CampbellTGV.indicatorsAt(elapsed));
  acqSamples.push(row);
  renderAcqDataRow(row);
  drawSpeedHistory();
  drawFreqSpeed();
  updateLiveGpsMap();
  updateCorrelation();
}
function renderAcqDataRow(row) {
  const body = $("acqDataBody"),
    tr = document.createElement("tr");
  tr.innerHTML = `<td>${row.elapsed.toFixed(1)} s</td><td>${row.speed === null ? "—" : row.speed.toFixed(0) + " km/h"}</td><td>${escapeHtml(row.speedSource || "—")}</td><td>${row.dominant === null ? "—" : row.dominant.toFixed(1) + " Hz"}</td><td>${row.fundamental === null ? "—" : row.fundamental.toFixed(1) + " Hz"}</td><td>${row.confidence || "—"}</td><td>${row.gpsAccuracy === null ? "—" : "±" + row.gpsAccuracy.toFixed(0) + " m"}</td>`;
  body.appendChild(tr);
  while (body.children.length > 180) body.firstChild.remove();
  const wrap = body.closest(".acq-table-wrap");
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}
function drawSpeedHistory() {
  const c = $("acqSpeedChart"),
    ctx = c.getContext("2d"),
    w = c.clientWidth,
    h = c.clientHeight;
  const data = acqSamples.filter((s) => s.speed !== null);
  const maxT = Math.max(60, data.at(-1)?.elapsed || 60);
  const maxV = Math.max(50, ...data.map((s) => s.speed || 0)) * 1.1;
  const a = simpleAxes(
    ctx,
    w,
    h,
    "Vitesse dans le temps",
    "Temps (s)",
    "km/h",
    maxT,
    0,
    maxV || 400,
  );
  if (data.length < 2) return;
  ctx.strokeStyle = "#CD0037";
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((s, i) => {
    const x = a.L + (w - a.L - a.R) * (s.elapsed / maxT),
      y = a.T + ((maxV - s.speed) / maxV) * (h - a.T - a.B);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
function drawFreqSpeed() {
  const c = $("acqFreqSpeedChart"),
    ctx = c.getContext("2d"),
    w = c.clientWidth,
    h = c.clientHeight,
    data = acqSamples.filter(
      (sample) => sample.speed !== null && sample.fundamental !== null,
    ),
    cfg = getTransmissionConfig(),
    maxV = Math.max(100, ...data.map((sample) => sample.speed || 0)) * 1.1,
    keys = theoryKeysForConfig(cfg);
  let theoryMax = 0;
  if (cfg.showTheory)
    for (const axle of cfg.axles) {
      const frequencies = transmissionFrequencies(maxV, axle.diameter);
      for (const key of keys)
        theoryMax = Math.max(theoryMax, frequencies?.[key] || 0);
    }
  const maxF =
      Math.max(
        120,
        ...data.map((sample) => sample.fundamental || 0),
        theoryMax,
      ) * 1.12,
    a = simpleAxes(
      ctx,
      w,
      h,
      "Fondamentale / vitesse — deux essieux",
      "Vitesse (km/h)",
      "Hz",
      maxV,
      0,
      maxF,
    ),
    legend = [];
  if (cfg.showTheory) {
    for (const axle of cfg.axles) {
      for (const key of keys) {
        ctx.strokeStyle = axle.color;
        ctx.globalAlpha = key === cfg.reference ? 1 : 0.5;
        ctx.lineWidth = key === cfg.reference ? 2.5 : 1;
        ctx.setLineDash(dualAxleDash(axle, key, cfg));
        ctx.beginPath();
        for (let i = 0; i <= 100; i++) {
          const speed = (maxV * i) / 100,
            frequency =
              transmissionFrequencies(speed, axle.diameter)?.[key] || 0,
            x = a.L + (w - a.L - a.R) * (speed / maxV),
            y = a.T + ((maxF - frequency) / maxF) * (h - a.T - a.B);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      legend.push({
        color: axle.color,
        label: `${axle.id} Ø${axle.diameter.toFixed(0)} — référence ${transmissionLabel(cfg.reference)}`,
        dash: axle.dash,
      });
    }
  }
  if (data.length) {
    ctx.fillStyle = "#CD0037";
    for (const sample of data) {
      const x = a.L + (w - a.L - a.R) * (sample.speed / maxV),
        y = a.T + ((maxF - sample.fundamental) / maxF) * (h - a.T - a.B);
      ctx.beginPath();
      ctx.arc(x, y, 2.7, 0, Math.PI * 2);
      ctx.fill();
    }
    legend.unshift({
      color: "#CD0037",
      label: "Fréquence de travail brute mesurée",
      dash: [],
    });
  }
  drawTransmissionLegend(ctx, w, h, legend);
}
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n,
    my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx,
      b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}
function updateCorrelation() {
  const data = acqSamples.filter(
      (sample) => sample.speed !== null && sample.fundamental !== null,
    ),
    cfg = getTransmissionConfig();
  if (data.length < 8) {
    $("acqCorrelation").textContent =
      `Pas assez de données : ${data.length}/8 points exploitables. Les trajectoires E1 Ø${cfg.diameter1.toFixed(0)} et E2 Ø${cfg.diameter2.toFixed(0)} restent affichées.`;
    return;
  }
  const speeds = data.map((sample) => sample.speed),
    frequencies = data.map((sample) => sample.fundamental),
    span = Math.max(...speeds) - Math.min(...speeds),
    r = pearson(speeds, frequencies);
  let text = "";
  if (r === null || span < 15)
    text =
      "Variation de vitesse insuffisante pour interpréter la corrélation fréquence / vitesse.";
  else {
    const absolute = Math.abs(r),
      level =
        absolute >= 0.85 ? "forte" : absolute >= 0.65 ? "moyenne" : "faible",
      direction = r >= 0 ? "positive" : "négative";
    text = `Corrélation fréquence de travail brute / vitesse : ${level} (${direction}, r = ${r.toFixed(2)}, ${data.length} points).`;
  }
  if (cfg.showTheory) {
    const assignments = data
        .map((sample) =>
          axleAssignment(sample.fundamental, sample.speed, cfg.reference, cfg),
        )
        .filter(Boolean),
      unresolved = assignments.filter((item) => item.ambiguous).length,
      e1 = assignments.filter(
        (item) => !item.ambiguous && item.best.id === "E1",
      ).length,
      e2 = assignments.filter(
        (item) => !item.ambiguous && item.best.id === "E2",
      ).length;
    text += ` Référence ${transmissionLabel(cfg.reference)} : E1 Ø${cfg.diameter1.toFixed(0)} (${e1} point(s)), E2 Ø${cfg.diameter2.toFixed(0)} (${e2} point(s)), indéterminé selon résolution FFT (${unresolved}).`;
  }
  text +=
    " Cette attribution est indicative et doit être confirmée par les harmoniques et les engrènements.";
  $("acqCorrelation").textContent = text;
}
function stopAcquisition(silent = false) {
  if (!acqRunning && !acqStream) return;
  acqRunning = false;
  if (acqAnimationId) {
    cancelAnimationFrame(acqAnimationId);
    acqAnimationId = null;
  }
  stopGps();
  if (acqMediaRecorder && acqMediaRecorder.state !== "inactive") {
    try {
      acqMediaRecorder.stop();
    } catch (e) {}
  }
  if (acqStream) {
    acqStream.getTracks().forEach((t) => t.stop());
    acqStream = null;
  }
  if (acqAudioContext) {
    try {
      acqAudioContext.close();
    } catch (e) {}
    acqAudioContext = null;
  }
  acqAnalyser = null;
  acqSourceNode = null;
  $("acqState").textContent = "ARRÊT";
  $("acqState").className = "";
  $("acqStart").disabled = false;
  $("acqStop").disabled = true;
  $("acqMark").disabled = true;
  $("acqStart").classList.remove("acq-button-recording");
  $("acqExportJson").disabled = acqSamples.length === 0;
  $("acqExportCsv").disabled = acqSamples.length === 0;
  if (!silent)
    setAcqStatus(
      `Acquisition arrêtée. ${acqSamples.length} point(s) synchronisé(s) enregistré(s).`,
    );
  drawSpeedHistory();
  drawFreqSpeed();
  updateLiveGpsMap();
  updateCorrelation();
}
function renderAcqMarkers() {
  const box = $("acqMarkerList");
  if (!acqMarkers.length) {
    box.innerHTML = '<div class="small">Aucun marqueur.</div>';
    return;
  }
  box.innerHTML = "";
  acqMarkers.forEach((m) => {
    const d = document.createElement("div");
    d.className = "acq-marker";
    d.innerHTML = `<strong>${m.elapsed.toFixed(1)} s</strong> — ${escapeHtml(m.label)} <span class="acq-pill">${m.speed === null ? "vitesse —" : m.speed.toFixed(0) + " km/h"}</span>`;
    box.appendChild(d);
  });
}
function addAcqMarker() {
  if (!acqRunning) return;
  const label = prompt("Description de l’événement :", "Bruit notable");
  if (label === null) return;
  const elapsed = (performance.now() - acqStartTime) / 1000;
  acqMarkers.push({
    elapsed,
    timestamp: new Date().toISOString(),
    label: label.trim() || "Marque",
    speed: Number.isFinite(acqCurrentSpeed) ? acqCurrentSpeed : null,
    dominant: acqLastPeaks[0]?.f ?? null,
    fundamental: acqLastWork?.primary ?? null,
    latitude: acqLastPosition?.coords?.latitude ?? null,
    longitude: acqLastPosition?.coords?.longitude ?? null,
  });
  renderAcqMarkers();
}
function acquisitionPayload() {
  const speeds = acqSamples
      .filter((sample) => sample.speed !== null)
      .map((sample) => sample.speed),
    frequencies = acqSamples
      .filter((sample) => sample.fundamental !== null)
      .map((sample) => sample.fundamental);
  return {
    application: "AnalyseAcoustiqueTGV",
    version: STABILITY_CONFIG.applicationVersion,
    schemaVersion: STABILITY_CONFIG.schemaVersion,
    type: "acquisition_live",
    exportedAt: new Date().toISOString(),
    identity: {
      rame: $("acqRame").value.trim(),
      motrice: $("acqMotrice").value.trim(),
      train: $("acqTrain").value.trim(),
      regime: $("acqRegime").value,
      notes: $("acqNotes").value.trim(),
    },
    transmission: transmissionExportConfig(),
    frequencyCalibration: frequencyCalibrationExport(),
    weighting: {
      enabled: aWeightingEnabled(),
      mode: activeModeName(),
      unit: activeLevelUnit(),
      diagnosticBasis: "spectre_brut",
      absoluteMeasurement: false,
      notice: weightingDisclaimer(),
    },
    audio: {
      mimeType: acqRecordedMime || null,
      fftSize: parseInt($("acqFftSize").value) || 8192,
      rawRequested: $("acqRawAudio").checked,
    },
    summary: {
      duration: acqSamples.at(-1)?.elapsed || 0,
      gpsAcceptedCount: acqGpsAcceptedCount,
      gpsRejectedCount: acqGpsRejectedCount,
      minSpeed: speeds.length ? Math.min(...speeds) : null,
      maxSpeed: speeds.length ? Math.max(...speeds) : null,
      minFundamental: frequencies.length ? Math.min(...frequencies) : null,
      maxFundamental: frequencies.length ? Math.max(...frequencies) : null,
      gpsPointCount: routeGpsPoints().length,
      routeDistanceKm: Number((routeDistanceMeters() / 1000).toFixed(3)),
    },
    samples: acqSamples,
    markers: acqMarkers,
    campbell: window.CampbellTGV ? window.CampbellTGV.exportData() : null,
    diametresTempsReel: window.DiametresTGV?.liveExport?.() ?? null, // v0.9.7 RC
  };
}
function exportAcqJson() {
  downloadText(
    `${acqSessionBaseName()}.json`,
    JSON.stringify(acquisitionPayload(), null, 2),
    "application/json;charset=utf-8",
  );
}
function exportAcqCsv() {
  const rows = [
    [
      "temps_s",
      "horodatage",
      "vitesse_kmh",
      "source_vitesse",
      "latitude",
      "longitude",
      "altitude_m",
      "cap_deg",
      "pic_dominant_hz",
      "niveau_actif",
      "unite_niveau",
      "niveau_brut_db_relatif",
      "niveau_A_dbA_relatif",
      "mode_ponderation",
      "fondamentale_hz",
      "confiance",
      "precision_gps_m",
      "regime",
      "niveau_bande_1500_1700_db",
      "pic_bande_hz",
      "pic_bande_db",
      "rapport_tonal_db",
      "ordre_reducteur_E1_db",
      "ordre_reducteur_E2_db",
      "ordre_pont_E1_db",
      "ordre_pont_E2_db",
      "bandes_lat_27_db",
      "bandes_lat_41_db",
      "bandes_lat_51_db",
    ],
  ];
  acqSamples.forEach((s) =>
    rows.push([
      s.elapsed,
      s.timestamp,
      s.speed ?? "",
      s.speedSource,
      s.latitude ?? "",
      s.longitude ?? "",
      s.altitude ?? "",
      s.heading ?? "",
      s.dominant ?? "",
      s.dominantLevel ?? "",
      s.levelUnit ?? "",
      s.dominantLevelRaw ?? "",
      s.dominantLevelA ?? "",
      s.weightingMode ?? "",
      s.fundamental ?? "",
      s.confidence ?? "",
      s.gpsAccuracy ?? "",
      s.regime ?? "",
      s.bandDb ?? "",
      s.bandPeakHz ?? "",
      s.bandPeakDb ?? "",
      s.tnrDb ?? "",
      s.meshReducerE1Db ?? "",
      s.meshReducerE2Db ?? "",
      s.meshBridgeE1Db ?? "",
      s.meshBridgeE2Db ?? "",
      s.sb27Db ?? "",
      s.sb41Db ?? "",
      s.sb51Db ?? "",
    ]),
  );
  const q = safeCsvCell;
  downloadText(
    `${acqSessionBaseName()}.csv`,
    "\uFEFF" + rows.map((r) => r.map(q).join(";")).join("\r\n"),
    "text/csv;charset=utf-8",
  );
}
function onTheorySpeedInput(source) {
  const number = $("transPreviewSpeed"),
    slider = $("transSpeedSlider");
  let value = parseFloat(source?.value);
  if (!Number.isFinite(value)) value = 300;
  value = Math.max(1, Math.min(326.4, value));
  const formatted = (Math.round(value * 10) / 10).toString();
  if (number) number.value = formatted;
  if (slider) slider.value = formatted;
  updateTransmissionSummary();
}
function applyTheorySpeedToSelectedFile() {
  const record = records[selectedIndex];
  if (!record) {
    setStatus("Aucun fichier sélectionné.", true);
    return;
  }
  const speed = getTransmissionConfig().previewSpeed,
    formatted = (Math.round(speed * 10) / 10).toFixed(1);
  record.speed = formatted;
  renderFileList();
  drawCurrent();
  renderRexMatches();
  setStatus(`Vitesse ${formatted} km/h enregistrée pour ${record.name}.`);
}
function downloadAcqAudio() {
  if (!acqRecordedBlob) return;
  const ext = extensionForMime(acqRecordedMime);
  downloadBlob(
    `${acqSessionBaseName()}.${ext}`,
    acqRecordedBlob,
  );
}
async function sendAcqToAnalysis() {
  if (!acqRecordedBlob) {
    setAcqStatus("Aucun enregistrement audio disponible à transférer.", true);
    return;
  }
  syncIdentityToAnalysis();
  const ext = extensionForMime(acqRecordedMime);
  const file = new File(
    [acqRecordedBlob],
    `${acqSessionBaseName()}.${ext}`,
    { type: acqRecordedMime || acqRecordedBlob.type },
  );
  const before = records.length;
  await addFiles([file]);
  const added = records.at(-1);
  if (records.length > before && added) {
    const withSpeed = acqSamples.filter((s) => s.speed !== null),
      traction = withSpeed.filter((s) => s.regime === "Traction"),
      speeds = (traction.length >= 5 ? traction : withSpeed)
        .map((s) => s.speed)
        .sort((a, b) => a - b);
    if (speeds.length) {
      // v0.9.6 : médiane (et non moyenne) des vitesses, en traction si disponible.
      added.speed = speeds[Math.floor(speeds.length / 2)].toFixed(0);
      added.speedRange = [speeds[0], speeds.at(-1)];
    }
    added.regime = $("acqRegime").value;
    renderFileList();
  }
  setAppMode("analysis");
  const range = added?.speedRange;
  const variable = range && range[1] - range[0] > Math.max(5, 0.05 * range[1]);
  setStatus(
    variable
      ? `Acquisition transférée. Attention : vitesse variable (${range[0].toFixed(0)}–${range[1].toFixed(0)} km/h), vitesse médiane retenue. Pour une analyse fiable à vitesse variable, utilisez le diagramme de Campbell (onglet Acquisition).`
      : "Acquisition transférée. Vérifiez la vitesse retenue et lancez l’analyse complète.",
    Boolean(variable),
  );
}
let deferredPwaInstallPrompt = null;
function isStandalonePwa() {
  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches ||
    window.navigator.standalone === true
  );
}
function isIosDevice() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}
function setPwaState(text, kind = "warn") {
  const el = $("pwaState");
  if (!el) return;
  el.textContent = text;
  el.className = "pwa-state " + kind;
}
function updatePwaUi(extra = "") {
  const info = $("pwaInfo");
  const install = $("pwaInstallButton");
  const standalone = isStandalonePwa();
  const secure = window.isSecureContext;
  const protocol = location.protocol;
  if (standalone) {
    setPwaState("Installée", "ok");
    if (info)
      info.textContent =
        "Application lancée en mode autonome. Microphone et GPS restent soumis aux autorisations du système.";
    if (install) install.hidden = true;
    return;
  }
  if (protocol === "file:") {
    setPwaState("HTML local", "error");
    if (info)
      info.textContent =
        "Cette copie locale reste utilisable pour l’analyse, mais iOS nécessite la version publiée en HTTPS pour le micro, le GPS et l’installation PWA.";
    if (install) install.hidden = true;
    return;
  }
  if (!secure) {
    setPwaState("HTTPS requis", "error");
    if (info)
      info.textContent =
        "La page n’est pas dans un contexte sécurisé. Publiez ce dossier en HTTPS.";
    if (install) install.hidden = true;
    return;
  }
  if (isIosDevice()) {
    setPwaState("Prête à installer", "warn");
    if (info)
      info.textContent =
        "iPhone/iPad : ouvrez cette adresse dans Safari puis Partager → Ajouter à l’écran d’accueil." +
        (extra ? " " + extra : "");
    if (install) install.hidden = true;
  } else if (deferredPwaInstallPrompt) {
    setPwaState("Prête à installer", "warn");
    if (info)
      info.textContent =
        "L’application peut être installée sur cet appareil." +
        (extra ? " " + extra : "");
    if (install) install.hidden = false;
  } else {
    setPwaState("HTTPS actif", "ok");
    if (info)
      info.textContent =
        "Connexion sécurisée active. L’installation peut être proposée par le navigateur lorsque ses critères sont remplis." +
        (extra ? " " + extra : "");
    if (install) install.hidden = true;
  }
}
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredPwaInstallPrompt = event;
  updatePwaUi();
});
window.addEventListener("appinstalled", () => {
  deferredPwaInstallPrompt = null;
  updatePwaUi("Installation terminée.");
});
$("pwaInstallButton").addEventListener("click", async () => {
  if (!deferredPwaInstallPrompt) return;
  try {
    deferredPwaInstallPrompt.prompt();
    await deferredPwaInstallPrompt.userChoice;
  } catch (error) {
    console.error("Installation PWA :", error);
  } finally {
    deferredPwaInstallPrompt = null;
    updatePwaUi();
  }
});
async function registerPwaServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    updatePwaUi("Service Worker non pris en charge.");
    return;
  }
  if (location.protocol === "file:") {
    updatePwaUi();
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("./sw.js", {
      scope: "./",
    });
    await navigator.serviceWorker.ready;
    console.log("PWA service worker actif :", registration.scope);
    updatePwaUi("Mode hors ligne activé après le premier chargement complet.");
  } catch (error) {
    console.error("Service Worker :", error);
    updatePwaUi("Service Worker non actif : " + (error?.message || error));
  }
}
registerPwaServiceWorker();
updatePwaUi();
window
  .matchMedia?.("(display-mode: standalone)")
  ?.addEventListener?.("change", () => updatePwaUi());
$("acqPermissions").addEventListener("click", () =>
  requestAcqPermissions(false),
);
$("acqRefreshPermissions").addEventListener("click", refreshPermissionStates);
$("acqStart").addEventListener("click", startAcquisition);
$("acqStop").addEventListener("click", () => stopAcquisition(false));
$("acqMark").addEventListener("click", addAcqMarker);
$("acqExportJson").addEventListener("click", exportAcqJson);
$("acqExportCsv").addEventListener("click", exportAcqCsv);
$("acqExportGeoJson").addEventListener("click", exportGpsGeoJson);
$("acqClearTrack").addEventListener("click", clearGpsTrack);
$("acqMapOverview").addEventListener("click", showGpsOverview);
$("acqMapCenter").addEventListener("click", centerOnGpsPosition);
$("acqMapFollow").addEventListener("change", updateLiveGpsMap);
$("acqDownloadAudio").addEventListener("click", downloadAcqAudio);
$("acqSendAnalysis").addEventListener("click", sendAcqToAnalysis);
$("acqFftSize").addEventListener("change", () => {
  if (acqAnalyser) {
    acqAnalyser.fftSize = parseInt($("acqFftSize").value) || 8192;
    acqWaveData = new Float32Array(acqAnalyser.fftSize);
    acqFreqData = new Float32Array(acqAnalyser.frequencyBinCount);
  }
});
[
  "transWheelDiameter1",
  "transWheelDiameter2",
  "transPreviewSpeed",
  "transReference",
  "transShowTheory",
  "transShowAllRotations",
  "transShowLimits",
  "transShowMesh",
].forEach((id) => {
  $(id)?.addEventListener("change", () => {
    updateTransmissionSummary();
    updateCorrelation();
  });
});
initFrequencyCalibration();
updateTransmissionSummary();
// v0.9.6 : avertissement avant de quitter / actualiser, arrêt seulement si la page se ferme vraiment
window.addEventListener("beforeunload", (event) => {
  if (acqRunning || records.length) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  if (acqRunning) stopAcquisition(true);
});
$("saveRex").addEventListener("click", saveCurrentAnalysisToRex);
$("saveRexSecondary").addEventListener("click", saveCurrentAnalysisToRex);
$("updateCase").addEventListener("click", updateSelectedCase);
$("deleteCase").addEventListener("click", deleteSelectedCase);
$("addIntervention").addEventListener("click", addIntervention);
$("exportHistoryJson").addEventListener("click", exportHistoryJson);
$("exportHistoryCsv").addEventListener("click", exportHistoryCsv);
$("importHistoryButton").addEventListener("click", () =>
  $("importHistoryFile").click(),
);
$("importHistoryFile").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) importHistoryJson(file);
  event.target.value = "";
});
$("historySearch").addEventListener("input", renderHistory);
$("historyStatusFilter").addEventListener("change", renderHistory);
$("historyOutcomeFilter").addEventListener("change", renderHistory);
$("interventionDate").value = todayIso();
$("reset").addEventListener("click", () => {
  records.forEach(releaseRecordResources);
  records = [];
  selectedIndex = 0;
  nextId = 1;
  $("fileInput").value = "";
  renderFileList();
  updateRecordSelector();
  $("peaksBody").innerHTML = "";
  $("commonBody").innerHTML = "";
  $("commonInfo").textContent =
    "L’analyse multi-fichiers n’a pas encore été lancée.";
  $("summary").textContent = "Aucune analyse disponible.";
  $("frequencyGuidance").textContent =
    "Lancez une analyse pour identifier les familles fréquentielles.";
  $("analyze").disabled = true;
  $("fullPdf").disabled = true;
  $("saveRex").disabled = true;
  $("saveRexSecondary").disabled = true;
  $("metricCommon").textContent = "0";
  updateMetrics("En attente");
  setStatus("Déposez jusqu’à 10 fichiers audio de la même motrice.");
  resizeCanvas();
  clearCanvas();
  $("legend").innerHTML = "";
  $("reportContainer").innerHTML = "";
  drawAnalysisTheoryChart();
});
window.addEventListener("resize", () => {
  resizeCanvas();
  drawCurrent();
  resizeAcqCanvases();
  liveGpsMap?.resize();
  drawAnalysisTheoryChart();
});
resizeCanvas();
clearCanvas();
resizeAcqCanvases();
drawAnalysisTheoryChart();
updateMetrics("En attente");
initAWeightingUi();
loadHistory();
renderSelectedCase();
updateCompatibility();
