const CACHE = "my-account-v18-pwa";
const ASSETS = ["./", "./index.html", "./styles.css?v=18", "./app.js?v=18", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./ocr/tesseract.min.js", "./ocr/worker.min.js", "./ocr/lang/tha.traineddata", "./ocr/core/tesseract-core.wasm.js", "./ocr/core/tesseract-core.wasm", "./ocr/core/tesseract-core-lstm.wasm.js", "./ocr/core/tesseract-core-lstm.wasm", "./ocr/core/tesseract-core-simd.wasm.js", "./ocr/core/tesseract-core-simd.wasm", "./ocr/core/tesseract-core-simd-lstm.wasm.js", "./ocr/core/tesseract-core-simd-lstm.wasm", "./ocr/core/tesseract-core-relaxedsimd.wasm.js", "./ocr/core/tesseract-core-relaxedsimd.wasm", "./ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js", "./ocr/core/tesseract-core-relaxedsimd-lstm.wasm"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(Promise.all([
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  self.clients.claim()
])));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then(async (response) => {
      const cache = await caches.open(CACHE);
      cache.put("./index.html", response.clone());
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html") || caches.match("./"))));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
