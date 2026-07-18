// Shared across all Space Bar OMS pages.
//
// 1. Registers the service worker — best-effort; browsers refuse this on an
//    insecure origin (plain HTTP on a LAN IP, as most of these screens run
//    on), so it silently no-ops there and the page works exactly as before.
// 2. Plays a silent, invisible looping "video" to stop the display from
//    sleeping. Chromium inhibits DPMS/screensaver blanking while a <video>
//    is actively playing, and iOS Safari won't auto-lock while one is
//    playing in the foreground tab — this works with or without HTTPS.

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function keepScreenAwake() {
  if (!HTMLCanvasElement.prototype.captureStream) return;

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const stream = canvas.captureStream(1);

  const video = document.createElement("video");
  video.muted = true;
  video.setAttribute("muted", "");
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.style.position = "fixed";
  video.style.top = "0";
  video.style.left = "0";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.opacity = "0.01";
  video.style.pointerEvents = "none";
  video.srcObject = stream;
  document.body.appendChild(video);

  const play = () => video.play().catch(() => {});
  play();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) play();
  });
}

keepScreenAwake();
