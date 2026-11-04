/* Correctif iPhone/iPad : privilégie l'enregistrement audio MP4/M4A. */
(() => {
  const appleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!appleMobile || typeof MediaRecorder === "undefined") return;

  chooseRecorderMime = function chooseAppleRecorderMime() {
    const formats = [
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm"
    ];
    return formats.find(format => MediaRecorder.isTypeSupported?.(format)) || "";
  };
})();
