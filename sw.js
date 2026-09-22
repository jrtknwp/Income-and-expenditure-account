const CACHE = "my-account-v7-ocr-thai";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest", "./ocr/tesseract.min.js", "./ocr/worker.min.js", "./ocr/core/tesseract-core.wasm.js", "./ocr/core/tesseract-core.wasm", "./ocr/core/tesseract-core-simd.wasm.js", "./ocr/core/tesseract-core-simd.wasm", "./ocr/core/tesseract-core-lstm.wasm.js", "./ocr/core/tesseract-core-lstm.wasm", "./ocr/core/tesseract-core-simd-lstm.wasm.js", "./ocr/core/tesseract-core-simd-lstm.wasm", "./ocr/core/tesseract-core-relaxedsimd.wasm.js", "./ocr/core/tesseract-core-relaxedsimd.wasm", "./ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js", "./ocr/core/tesseract-core-relaxedsimd-lstm.wasm", "./ocr/lang/tha.traineddata"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(Promise.all([
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  self.clients.claim()
])));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
