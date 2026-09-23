const dbName = "my-account";
const defaultCategories = [
  ["food", "🍜", "อาหาร"], ["goods", "🛒", "ของใช้"], ["travel", "🚗", "เดินทาง"], ["home", "🏠", "บ้าน"],
  ["bills", "💳", "บิล"], ["shopping", "🛍️", "ช้อปปิ้ง"], ["fun", "🎮", "บันเทิง"], ["other", "📦", "อื่น ๆ"]
].map(([id, icon, name]) => ({ id, icon, name }));
let categories = [...defaultCategories];
let db; let screen = "home"; let editingId = null; let draft = newDraft(); let receiptBlob = null; let ocrState = { status:"idle", message:"", rawText:"", debug:null }; let historyFilters = { query:"", type:"all", category:"all", date:"" }; let summaryDate = new Date(); let summaryMode = "daily"; let summaryDay = localDate(); let categoryReturnScreen = "form"; let categoryEditor = { id:"", icon:"✨", name:"" };
const app = document.querySelector("#app"); const receiptInput = document.querySelector("#receipt-input");
let ocrWorkerPromise = null;
let tesseractLoadPromise = null;
let ocrQueue = Promise.resolve();
let activeOcrRunId = 0;

async function ensureTesseract() {
  if (window.Tesseract) return window.Tesseract;
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("./ocr/tesseract.min.js", import.meta.url).href;
    script.async = true;
    script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("ไม่พบ Tesseract.js"));
    script.onerror = () => reject(new Error("โหลด OCR runtime ในเครื่องไม่สำเร็จ"));
    document.head.appendChild(script);
  });
  try { return await tesseractLoadPromise; } catch (error) { tesseractLoadPromise = null; throw error; }
}

async function getOcrWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  ocrWorkerPromise = (async () => {
    const Tesseract = await ensureTesseract();
    const base = new URL("./ocr/", import.meta.url);
    return Tesseract.createWorker("tha", 1, {
      workerPath: new URL("worker.min.js", base).href,
      corePath: new URL("core/", base).href,
      langPath: new URL("lang/", base).href,
      gzip: false,
      logger: (event) => {
        if (event.status === "recognizing text" && typeof event.progress === "number") {
          ocrState.message = `กำลังอ่านข้อความสลิปในอุปกรณ์… ${Math.round(event.progress * 100)}%`;
          if (screen === "import") renderForm(true);
        }
      }
    });
  })();
  try { return await ocrWorkerPromise; } catch (error) { ocrWorkerPromise = null; throw error; }
}

const thaiMonths = new Map([
  ["มค",1],["มกราคม",1],["กพ",2],["กุมภาพันธ์",2],["มีค",3],["มีนาคม",3],["เมย",4],["เมษายน",4],
  ["พค",5],["พฤษภาคม",5],["มิย",6],["มิถุนายน",6],["กค",7],["กรกฎาคม",7],["สค",8],["สิงหาคม",8],
  ["กย",9],["กันยายน",9],["ตค",10],["ตุลาคม",10],["พย",11],["พฤศจิกายน",11],["ธค",12],["ธันวาคม",12]
]);
const englishMonths = new Map([["jan",1],["january",1],["feb",2],["february",2],["mar",3],["march",3],["apr",4],["april",4],["may",5],["jun",6],["june",6],["jul",7],["july",7],["aug",8],["august",8],["sep",9],["sept",9],["september",9],["oct",10],["october",10],["nov",11],["november",11],["dec",12],["december",12]]);
const thaiDigitMap = { "๐":"0", "๑":"1", "๒":"2", "๓":"3", "๔":"4", "๕":"5", "๖":"6", "๗":"7", "๘":"8", "๙":"9" };

function normalizeNumericToken(value) {
  return String(value).replace(/[๐-๙]/g, (digit) => thaiDigitMap[digit]).replace(/[Oo]/g, "0").replace(/[Il|]/g, "1");
}
function moneyToken(value) {
  const normalized = normalizeNumericToken(value).replace(/[\s,]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return "";
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 && amount < 100000000 ? amount.toFixed(2) : "";
}
function isoDate(dayValue, monthValue, yearValue, thaiContext = false) {
  const day = Number(normalizeNumericToken(dayValue)); const month = Number(normalizeNumericToken(monthValue)); let year = Number(normalizeNumericToken(yearValue));
  if (!day || !month || !year || month > 12) return "";
  if (year < 100) year = thaiContext || year >= 50 ? 2500 + year : 2000 + year;
  if (year > 2400) year -= 543;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return "";
  return `${year.toString().padStart(4,"0")}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}
function detectBank(text) {
  if (/\bttb\b|ทีทีบี|ทหารไทยธนชาต/i.test(text)) return "TTB";
  if (/(?:จ่ายบิลสำเร็จ|รหัสร้านค้า)/i.test(text) && /(?:บันทึกช่วยจำ|รหัสอ้างอิง)/i.test(text)) return "TTB (รูปแบบสลิป)";
  if (/\bk\+|kasikorn|กสิกร/i.test(text)) return "KBank";
  if (/krungsri|กรุงศรี/i.test(text)) return "Krungsri";
  if (/scb|ไทยพาณิชย์/i.test(text)) return "SCB";
  if (/krungthai|กรุงไทย/i.test(text)) return "Krungthai";
  return "ไม่ระบุ";
}
function thaiMonthNumber(token) {
  const direct = token.replace(/[.\s]/g, "");
  if (thaiMonths.has(direct)) return thaiMonths.get(direct);
  // Thai OCR can insert a vowel/tonemark inside abbreviations, e.g. "ก.ุย." for "ก.ย.".
  const withoutMarks = direct.replace(/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g, "");
  return thaiMonths.get(withoutMarks);
}
function firstLabelValue(lines, labelPattern, valuePattern) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]; const inline = line.match(new RegExp(`${labelPattern.source}[^\\S\\r\\n:：-]{0,4}[:：-]?\\s*(${valuePattern.source})`, "i"));
    if (inline) return inline[1].trim();
    if (labelPattern.test(line) && lines[index + 1] && valuePattern.test(lines[index + 1])) return lines[index + 1].trim();
  }
  return "";
}
function parseOcrText(text) {
  const rawText = String(text || "");
  const lines = rawText.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const compact = lines.join(" "); const numericCompact = normalizeNumericToken(compact);
  const bank = detectBank(compact);
  const amountLabel = /(?:ยอด(?:เงิน|โอน|ชำระ)?|จำนวน(?:เงิน)?|เงินที่(?:โอน|ชำระ)|total|amount|payment(?: amount)?)/i;
  let amount = "";
  for (const line of lines) {
    if (!amountLabel.test(line) || /(?:ค่าธรรมเนียม|fee)/i.test(line)) continue;
    const match = line.match(/([0-9๐-๙OoIl|][0-9๐-๙OoIl|,\s]*\.\s*[0-9๐-๙OoIl|]{1,2}|[0-9๐-๙OoIl|][0-9๐-๙OoIl|,\s]{0,12})/);
    amount = match ? moneyToken(match[1]) : ""; if (amount) break;
  }
  if (!amount) {
    for (const line of lines) {
      if (/(?:ค่าธรรมเนียม|fee|วันที่|date|เวลา|time|รหัสอ้างอิง|reference|ref)/i.test(line)) continue;
      const match = line.match(/(?:฿|THB\s*)?\s*([0-9๐-๙OoIl|][0-9๐-๙OoIl|,]*\.\s*[0-9๐-๙OoIl|]{2})\b/i);
      amount = match ? moneyToken(match[1]) : ""; if (amount) break;
    }
  }
  let date = ""; const thaiDateContext = /[ก-๙]|(?:วันที่|date)/i.test(compact);
  for (const line of lines) {
    const thaiMatch = line.match(/(\d{1,2})\s*([ก-๙.]+)\s*(\d{2,4})/);
    if (thaiMatch) { const month = thaiMonthNumber(thaiMatch[2]); date = month ? isoDate(thaiMatch[1], month, thaiMatch[3], true) : ""; if (date) break; }
    const englishMatch = line.match(/(\d{1,2})\s+([A-Za-z.]+)\s*,?\s*(\d{2,4})/);
    if (englishMatch) { const month = englishMonths.get(englishMatch[2].replace(/\./g, "").toLowerCase()); date = month ? isoDate(englishMatch[1], month, englishMatch[3]) : ""; if (date) break; }
    const numericMatch = normalizeNumericToken(line).match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
    if (numericMatch) { date = isoDate(numericMatch[1], numericMatch[2], numericMatch[3], thaiDateContext); if (date) break; }
  }
  let time = "";
  for (const line of lines) { const match = normalizeNumericToken(line).match(/\b([01]?\d|2[0-3])\s*[:.]\s*([0-5]\d)(?::\s*([0-5]\d))?\b/); if (match) { time = `${match[1].padStart(2,"0")}:${match[2]}`; break; } }
  const referenceLabel = /(?:รหัสอ้างอิง|เลข(?:ที่)?อ้างอิง|หมายเลขอ้างอิง|reference|\bref\b)/i;
  const transactionLabel = /(?:รหัสธุรกรรม|transaction(?:\s*(?:id|no))?)/i;
  let reference = firstLabelValue(lines, referenceLabel, /[A-Za-z0-9-]{8,}/);
  if (!reference) { const match = compact.match(/(?:รหัสอ้างอิง|เลข(?:ที่)?อ้างอิง|หมายเลขอ้างอิง|reference|\bref\b)[^A-Za-z0-9]{0,18}([A-Za-z0-9-]{8,})/i); reference = match?.[1] || ""; }
  if (!reference) reference = firstLabelValue(lines, transactionLabel, /[A-Za-z0-9-]{8,}/);
  const ignored = /^(?:ttb|ธนาคาร|bank|จำนวน(?:เงิน)?|ยอด(?:เงิน|โอน|ชำระ)?|รวม|total|amount|payment|วันที่|เวลา|date|time|reference|ref|เลข(?:ที่)?อ้างอิง|รหัส(?:อ้างอิง|ธุรกรรม)|รายการ|transaction|promptpay|พร้อมเพย์|ค่าธรรมเนียม|fee|รายละเอียด|บันทึกช่วยจำ|สำเร็จ|จ่ายบิลสำเร็จ|โอนเงินสำเร็จ)$/i;
  const merchantLabel = /(?:ชื่อ(?:ร้านค้า|ผู้รับ)?|(?<!รหัส)ร้านค้า|ผู้รับ(?:เงิน)?|recipient|merchant|\bto\b|ไปยัง)/i;
  let merchant = firstLabelValue(lines, merchantLabel, /[A-Za-zก-๙][A-Za-zก-๙ .&'()-]{1,80}/);
  const suitableMerchant = (line) => line.length >= 2 && line.length <= 80 && (line.match(/[A-Za-z\u0E01-\u0E2E]/g) || []).length >= 3 && !ignored.test(line) && !/^\d[\d\s.,:/()Xx-]*$/.test(line) && !/^(?:฿|THB)\b/i.test(line) && !/(?:^\s*(?:ยอด(?:เงิน|โอน|ชำระ)?|จำนวน(?:เงิน)?|total|amount|payment)|ค่าธรรมเนียม|fee|วันที่|เวลา|reference|รหัสอ้างอิง|เลขอ้างอิง|^xxx)/i.test(line);
  if (!merchant) merchant = lines.find((line) => suitableMerchant(line) && /[A-Za-z]{3}/.test(line)) || "";
  if (!merchant) merchant = lines.find(suitableMerchant) || "";
  return { fields:{ amount, date, time, reference, merchant }, debug:{ bank, amount:amount || "ไม่พบ", date:date || "ไม่พบ", time:time || "ไม่พบ", reference:reference || "ไม่พบ" } };
}

function ocrLines(text) { return String(text || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean); }
function extractSlipDate(text) {
  for (const rawLine of ocrLines(text)) {
    const line = normalizeNumericToken(rawLine);
    const thaiPattern = /(\d{1,2})\s*([ก-๙.\s]+?)\s*(\d{2,4})(?=$|[\s,])/g; let thaiMatch;
    while ((thaiMatch = thaiPattern.exec(line))) { const month = thaiMonthNumber(thaiMatch[2]); const date = month ? isoDate(thaiMatch[1], month, thaiMatch[3], true) : ""; if (date) return date; thaiPattern.lastIndex = thaiMatch.index + 1; }
    const englishPattern = /(\d{1,2})\s+([A-Za-z.]+)\s*,?\s*(\d{2,4})(?=$|[\s,])/g; let englishMatch;
    while ((englishMatch = englishPattern.exec(line))) { const month = englishMonths.get(englishMatch[2].replace(/\./g, "").toLowerCase()); const date = month ? isoDate(englishMatch[1], month, englishMatch[3]) : ""; if (date) return date; englishPattern.lastIndex = englishMatch.index + 1; }
    for (const numericMatch of line.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g)) { const date = isoDate(numericMatch[1], numericMatch[2], numericMatch[3], /[ก-๙]|วันที่/i.test(rawLine)); if (date) return date; }
  }
  return "";
}
function amountCandidates(text, source) {
  const candidates = [];
  for (const rawLine of ocrLines(text)) {
    const line = normalizeNumericToken(rawLine);
    const withoutTime = line.replace(/\b(?:[01]?\d|2[0-3])\s*[:.]\s*[0-5]\d(?::\s*[0-5]\d)?\b/g, " ");
    const pattern = /(?<!\d)(\d{1,4}(?:,\d{3})*\.\d{2})(?!\d)/g;
    for (const match of withoutTime.matchAll(pattern)) {
      const amount = moneyToken(match[1]); if (!amount) continue;
      const before = withoutTime.slice(Math.max(0, match.index - 32), match.index).toLowerCase();
      const around = withoutTime.slice(Math.max(0, match.index - 32), match.index + match[0].length + 20).toLowerCase();
      if (/(?:ค่าธรรมเนียม|fee|reference|ref|รหัส(?:อ้างอิง|ธุรกรรม|ร้านค้า)|เลขบัญชี|account|transaction)/i.test(around)) continue;
      const labelled = /(?:ยอด(?:เงิน|โอน|ชำระ)?|จำนวน(?:เงิน)?|เงินที่(?:โอน|ชำระ)|total|amount|payment|บาท|thb)/i.test(before);
      if (source === "FULL OCR" && !labelled) continue;
      candidates.push({ amount, source, score:(source === "FULL OCR" ? 20 : 100) + (labelled ? 40 : 0), text:rawLine });
    }
  }
  return candidates;
}
function chooseAmount(fullText, amountPasses, dateCropText = "") {
  const candidates = [
    ...amountPasses.flatMap((pass) => amountCandidates(pass.text, pass.name)),
    ...amountCandidates(dateCropText, "DATE CROP OCR"),
    ...amountCandidates(fullText, "FULL OCR")
  ];
  candidates.sort((a, b) => b.score - a.score || Number(a.amount) - Number(b.amount));
  return { amount:candidates[0]?.amount || "", candidates };
}
async function receiptBitmap(file) {
  if ("createImageBitmap" in window) return createImageBitmap(file);
  const url = URL.createObjectURL(file);
  try { return await new Promise((resolve, reject) => { const image = new Image(); image.onload=()=>resolve(image); image.onerror=()=>reject(new Error("เปิดรูปสลิปไม่สำเร็จ")); image.src=url; }); }
  finally { URL.revokeObjectURL(url); }
}
function preparedCrop(bitmap, box) {
  const sourceWidth = bitmap.width || bitmap.naturalWidth; const sourceHeight = bitmap.height || bitmap.naturalHeight;
  const sx = Math.round(sourceWidth * box.x); const sy = Math.round(sourceHeight * box.y);
  const sw = Math.round(sourceWidth * box.w); const sh = Math.round(sourceHeight * box.h);
  const scale = Math.min(2.5, 2200 / Math.max(sw, 1));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(sw * scale)); canvas.height = Math.max(1, Math.round(sh * scale));
  const context = canvas.getContext("2d", { willReadFrequently:true });
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index=0; index<pixels.data.length; index+=4) {
    const gray = (pixels.data[index] * 0.299) + (pixels.data[index+1] * 0.587) + (pixels.data[index+2] * 0.114);
    const boosted = Math.max(0, Math.min(255, (gray - 128) * 1.45 + 128));
    pixels.data[index] = pixels.data[index+1] = pixels.data[index+2] = boosted;
  }
  context.putImageData(pixels, 0, 0); return canvas;
}
async function ocrPasses(file, worker) {
  const bitmap = await receiptBitmap(file);
  try {
    const crops = [
      { name:"AMOUNT CROP OCR (upper-middle)", box:{ x:0.08, y:0.15, w:0.84, h:0.38 } },
      { name:"AMOUNT CROP OCR (lower-middle)", box:{ x:0.06, y:0.45, w:0.88, h:0.45 } },
      { name:"DATE CROP OCR", box:{ x:0.04, y:0.02, w:0.92, h:0.34 } }
    ];
    const full = await worker.recognize(file);
    const results = { full:full.data?.text || "", amount:[], date:"" };
    for (const crop of crops) {
      const result = await worker.recognize(preparedCrop(bitmap, crop.box)); const text = result.data?.text || "";
      if (crop.name.startsWith("AMOUNT")) results.amount.push({ name:crop.name, text }); else results.date = text;
    }
    return results;
  } finally { if (typeof bitmap.close === "function") bitmap.close(); }
}
async function performOcr(file, runId) {
  try {
    const worker = await getOcrWorker(); const passes = await ocrPasses(file, worker);
    if (runId !== activeOcrRunId) return;
    const parsed = parseOcrText(passes.full); const chosenAmount = chooseAmount(passes.full, passes.amount, passes.date);
    const finalDate = extractSlipDate(passes.date) || extractSlipDate(passes.full);
    Object.assign(draft, Object.fromEntries(Object.entries(parsed.fields).filter(([key, value]) => value && !["amount", "date"].includes(key))));
    draft.amount = chosenAmount.amount; draft.date = finalDate;
    const debug = { bank:detectBank(`${passes.full} ${passes.date}`), full:passes.full, amountCrops:passes.amount, dateCrop:passes.date, finalAmount:chosenAmount.amount || "ไม่พบ", finalDate:finalDate || "ไม่พบ", amountCandidates:chosenAmount.candidates };
    ocrState = { status:"done", message:`อ่านสลิปเสร็จแล้ว${draft.amount ? ` · พบยอด ${money(draft.amount)}` : " · ไม่พบยอดเงิน"}${draft.date ? "" : " · ไม่พบวันที่จากสลิป"}`, rawText:passes.full, debug };
  } catch (error) {
    if (runId !== activeOcrRunId) return; console.error(error); ocrState = { status:"error", message:`OCR ไม่สำเร็จ (${error?.message || "ไม่ทราบสาเหตุ"})` };
  }
  if (runId === activeOcrRunId) renderForm(true);
}
async function runOcr(file) {
  const runId = ++activeOcrRunId; ocrState = { status:"processing", message:"กำลังเตรียม OCR ภาษาไทยในอุปกรณ์…" }; screen = "import"; renderForm(true);
  const job = ocrQueue.catch(() => {}).then(() => performOcr(file, runId)); ocrQueue = job.catch(() => {}); return job;
}
const money = (n) => new Intl.NumberFormat("th-TH", { style:"currency", currency:"THB", maximumFractionDigits:2 }).format(Number(n || 0));
const dateText = (iso) => new Intl.DateTimeFormat("th-TH", { day:"numeric", month:"short", year:"numeric" }).format(new Date(`${iso}T00:00:00`));
const timeText = (iso) => iso ? new Intl.DateTimeFormat("th-TH", { hour:"2-digit", minute:"2-digit" }).format(new Date(iso)) : "";
function localDate(date = new Date()) { const offset = date.getTimezoneOffset(); return new Date(date.getTime() - offset * 60000).toISOString().slice(0,10); }
function newDraft() { return { type:"expense", amount:"", category:"food", merchant:"", date:localDate(), time:"", note:"", reference:"", receiptId:null, source:"manual" }; }
function categoryOf(id) { return categories.find((c) => c.id === id) || defaultCategories.find((c) => c.id === id) || { id:"other", icon:"📦", name:"อื่น ๆ" }; }
function categoryForTransaction(t) { return categories.find((c) => c.id === t.category) || (t.categoryName ? { id:t.category, icon:t.categoryIcon || "🏷️", name:t.categoryName } : categoryOf(t.category)); }
function openDb() { return new Promise((resolve, reject) => { const request = indexedDB.open(dbName, 2); request.onupgradeneeded = () => { const d = request.result; if (!d.objectStoreNames.contains("transactions")) d.createObjectStore("transactions", { keyPath:"id" }); if (!d.objectStoreNames.contains("receipts")) d.createObjectStore("receipts", { keyPath:"id" }); if (!d.objectStoreNames.contains("settings")) d.createObjectStore("settings", { keyPath:"key" }); if (!d.objectStoreNames.contains("categories")) d.createObjectStore("categories", { keyPath:"id" }); }; request.onsuccess = () => { db = request.result; resolve(); }; request.onerror = () => reject(request.error); }); }
function store(name, mode = "readonly") { return db.transaction(name, mode).objectStore(name); }
function all(name) { return new Promise((resolve, reject) => { const r = store(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
function get(name,id) { return new Promise((resolve,reject) => { const r = store(name).get(id); r.onsuccess = () => resolve(r.result); r.onerror=()=>reject(r.error); }); }
function put(name,item) { return new Promise((resolve,reject) => { const r=store(name,"readwrite").put(item); r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error); }); }
function remove(name,id) { return new Promise((resolve,reject) => { const r=store(name,"readwrite").delete(id); r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error); }); }
async function transactions() { return (await all("transactions")).sort((a,b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`)); }
async function initialBalance() { return Number((await get("settings","initialBalance"))?.value || 0); }
async function loadCategories() { const initialized = await get("settings", "categoriesInitialized"); if (!initialized) { for (const category of defaultCategories) await put("categories", category); await put("settings", { key:"categoriesInitialized", value:true }); } categories = await all("categories"); }
function toast(message) { const t=document.createElement("div"); t.className="toast"; t.textContent=message; document.body.append(t); setTimeout(()=>t.remove(),2300); }
function layout(content, active = "") { return `${content}<nav class="bottom-nav"><button class="nav-button ${active==='home'?'active':''}" data-nav="home"><span>⌂</span>หน้าหลัก</button><button class="nav-button ${active==='history'?'active':''}" data-nav="history"><span>☷</span>รายการ</button><button class="nav-button ${active==='summary'?'active':''}" data-nav="summary"><span>◔</span>สรุป</button></nav>`; }
function itemHtml(t, actions = false) { const c=categoryForTransaction(t); return `<article class="transaction"><div class="category-icon">${c.icon}</div><div class="transaction-body"><div class="transaction-title">${escapeHtml(t.merchant || c.name)}</div><div class="transaction-meta">${c.name} · ${dateText(t.date)} ${t.time || ""}</div></div><div class="amount ${t.type}">${t.type==='income'?'+':'-'}${money(t.amount)}</div>${actions?`<div class="row-actions">${t.receiptId?`<button class="small-button" data-view-receipt="${t.receiptId}">สลิป</button>`:''}<button class="small-button" data-edit="${t.id}">แก้ไข</button><button class="small-button danger" data-delete="${t.id}">ลบ</button></div>`:''}</article>`; }
function escapeHtml(value) { const div=document.createElement("div"); div.textContent=value; return div.innerHTML; }
async function renderHome() { const list=await transactions(), start=await initialBalance(), today=localDate(); const inc=list.filter(t=>t.type==='income'), exp=list.filter(t=>t.type==='expense'); const sum=a=>a.reduce((x,t)=>x+Number(t.amount),0); const balance=start+sum(inc)-sum(exp), todayIn=sum(inc.filter(t=>t.date===today)), todayOut=sum(exp.filter(t=>t.date===today)); app.innerHTML=layout(`<header class="topbar"><div><p class="eyebrow">ยินดีต้อนรับกลับมา</p><h1>My Account</h1></div><button class="icon-button" data-settings aria-label="ตั้งค่า">⚙</button></header><section class="balance-card"><span class="balance-label">ยอดคงเหลือทั้งหมด</span><div class="balance">${money(balance)}</div><div class="mini-grid"><div><span>รายรับวันนี้</span><b>${money(todayIn)}</b></div><div><span>รายจ่ายวันนี้</span><b>${money(todayOut)}</b></div><div><span>สุทธิวันนี้</span><b>${money(todayIn-todayOut)}</b></div></div></section><section class="quick-actions"><button class="primary" data-add>＋ เพิ่มรายการ</button><button class="secondary" data-import>▣ นำเข้าสลิป</button></section><section class="section"><div class="section-head"><h2>รายการล่าสุด</h2><button class="link-button" data-nav="history">ดูทั้งหมด</button></div>${list.slice(0,5).map(t=>itemHtml(t)).join("") || '<div class="empty">ยังไม่มีรายการ<br>เริ่มบันทึกรายรับหรือรายจ่ายได้เลย</div>'}</section>`,"home"); }
function categoryButtons() { return `<div class="category-grid">${categories.map(c=>`<button type="button" class="category-option ${draft.category===c.id?'selected':''}" data-category="${c.id}">${c.icon} ${c.name}</button>`).join("")}</div><button type="button" class="manage-categories" data-manage-categories>＋ เพิ่ม / จัดการหมวดหมู่</button>`; }
function keepDraftFields() { const form=document.querySelector("#transaction-form"); if (!form) return; const data=new FormData(form); draft={...draft, amount:data.get("amount") || "", merchant:data.get("merchant") || "", date:data.get("date") || (draft.source === "receipt" ? "" : localDate()), time:data.get("time") || "", note:data.get("note") || "", reference:data.get("reference") || ""}; }
function ocrStatusHtml() { if (ocrState.status === "processing") return '<div class="ocr-status processing">กำลังอ่านข้อความสลิปในอุปกรณ์…</div>'; if (ocrState.status === "done") { const d=ocrState.debug; const cropText=d?.amountCrops?.map((pass)=>`${pass.name}\n${pass.text || "ไม่มีข้อความที่อ่านได้"}`).join("\n\n") || "ไม่มีข้อความที่อ่านได้"; const candidates=d?.amountCandidates?.map((candidate)=>`${candidate.amount} (${candidate.source})`).join(", ") || "ไม่มี"; const debug=d ? `<details class="ocr-debug"><summary>Debug OCR (local-only)</summary><dl><dt>BANK</dt><dd>${escapeHtml(d.bank)}</dd><dt>FINAL AMOUNT</dt><dd>${escapeHtml(d.finalAmount)} · candidates: ${escapeHtml(candidates)}</dd><dt>FINAL DATE</dt><dd>${escapeHtml(d.finalDate)}</dd></dl><h3>FULL OCR</h3><pre>${escapeHtml(d.full.slice(0,12000) || "ไม่มีข้อความที่อ่านได้")}</pre><h3>AMOUNT CROP OCR</h3><pre>${escapeHtml(cropText.slice(0,12000))}</pre><h3>DATE CROP OCR</h3><pre>${escapeHtml(d.dateCrop.slice(0,12000) || "ไม่มีข้อความที่อ่านได้")}</pre></details>` : ""; return `<div class="ocr-status success">${escapeHtml(ocrState.message)}${debug}</div>`; } if (ocrState.status === "error") return `<div class="ocr-status warning">${escapeHtml(ocrState.message)} กรุณากรอกหรือแก้ไขข้อมูลด้านล่าง</div>`; return ''; }
async function renderForm(importing=false) { const confirmLabel=importing?'ยืนยันและบันทึก':'บันทึกรายการ'; app.innerHTML=`<header class="page-head"><button class="back" data-nav="home">←</button><div><p class="eyebrow">${importing?'ตรวจสอบก่อนบันทึก':'บันทึกให้เร็ว'}</p><h1>${importing?'ตรวจสอบรายการ':'เพิ่มรายการ'}</h1></div></header><form id="transaction-form" class="form-card"><div class="type-toggle"><button type="button" data-type="expense" class="${draft.type==='expense'?'selected':''}">รายจ่าย</button><button type="button" data-type="income" class="${draft.type==='income'?'selected':''}">รายรับ</button></div>${importing?`${ocrStatusHtml()}<p class="hint">OCR เป็นเพียงข้อมูลเสนอแนะ โปรดตรวจสอบ แก้ไข และเลือกหมวดหมู่ด้วยตัวเองก่อนบันทึก</p>`:''}<label class="field">จำนวนเงิน<input class="amount-input" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0.00" value="${draft.amount}" required autofocus /></label><label class="field">เลือกหมวดหมู่${categoryButtons()}</label><label class="field">ชื่อร้าน / ผู้รับเงิน<input name="merchant" placeholder="เช่น 7-Eleven" value="${escapeHtml(draft.merchant)}" /></label><div class="filter-grid"><label class="field">วันที่<input name="date" type="date" value="${draft.date}" required /></label><label class="field">เวลา<input name="time" type="time" value="${draft.time}" /></label></div>${importing?`<label class="field">เลขอ้างอิง (ถ้ามี)<input name="reference" placeholder="เลขอ้างอิงจากสลิป" value="${escapeHtml(draft.reference || '')}" /></label>`:''}<label class="field">หมายเหตุ (ไม่บังคับ)<textarea name="note" rows="2" placeholder="เพิ่มรายละเอียดได้">${escapeHtml(draft.note)}</textarea></label>${receiptBlob?`<img class="receipt-preview" src="${URL.createObjectURL(receiptBlob)}" alt="รูปสลิปที่เลือก" /><button class="secondary" type="button" data-change-receipt>เปลี่ยนรูปสลิป</button>`:`<button class="secondary" type="button" data-import>📷 เลือกรูปสลิป</button>`}<button class="primary save" type="submit">${confirmLabel}</button>${editingId?'<button class="secondary save" type="button" data-cancel-edit>ยกเลิก</button>':''}</form>`; }
async function renderCategoryManager() { app.innerHTML=`<header class="page-head"><button class="back" data-close-categories>←</button><div><p class="eyebrow">แตะเลือก ใช้งานได้ทันที</p><h1>จัดการหมวดหมู่</h1></div></header><section class="form-card"><form id="category-form"><div class="category-editor"><label class="field">ไอคอน<input name="icon" maxlength="4" inputmode="text" value="${escapeHtml(categoryEditor.icon)}" aria-label="ไอคอนหมวดหมู่" /></label><label class="field">ชื่อหมวดหมู่<input name="name" maxlength="32" placeholder="เช่น สัตว์เลี้ยง" value="${escapeHtml(categoryEditor.name)}" required autofocus /></label></div><button class="primary" type="submit">${categoryEditor.id?'บันทึกการแก้ไข':'＋ เพิ่มหมวดหมู่'}</button>${categoryEditor.id?'<button class="secondary save" type="button" data-cancel-category-edit>ยกเลิกการแก้ไข</button>':''}</form></section><section class="section"><h2>หมวดหมู่ของฉัน</h2><div class="category-list">${categories.map(c=>`<article class="category-row"><span class="category-icon">${c.icon}</span><strong>${escapeHtml(c.name)}</strong><button class="small-button" data-edit-category="${c.id}">แก้ไข</button><button class="small-button danger" data-delete-category="${c.id}">ลบ</button></article>`).join('') || '<div class="empty">ยังไม่มีหมวดหมู่<br>เพิ่มหมวดหมู่แรกได้ด้านบน</div>'}</div></section>`; }
async function renderHistory() { const list=await transactions(); const f=historyFilters; const filtered=list.filter(t=> (!f.query || `${t.merchant} ${categoryOf(t.category).name}`.toLowerCase().includes(f.query.toLowerCase())) && (f.type==='all'||t.type===f.type) && (f.category==='all'||t.category===f.category) && (!f.date||t.date===f.date)); app.innerHTML=layout(`<header class="topbar"><div><p class="eyebrow">ค้นหาและจัดการ</p><h1>รายการทั้งหมด</h1></div><button class="primary" data-add>＋</button></header><section class="filter-grid"><input data-filter="query" value="${escapeHtml(f.query)}" placeholder="ค้นหาร้านหรือหมวดหมู่" /><select data-filter="type"><option value="all">ทุกประเภท</option><option value="income" ${f.type==='income'?'selected':''}>รายรับ</option><option value="expense" ${f.type==='expense'?'selected':''}>รายจ่าย</option></select><select data-filter="category"><option value="all">ทุกหมวดหมู่</option>${categories.map(c=>`<option value="${c.id}" ${f.category===c.id?'selected':''}>${c.icon} ${c.name}</option>`).join("")}</select><input data-filter="date" type="date" value="${f.date}" /></section>${filtered.map(t=>itemHtml(t,true)).join("") || '<div class="empty">ไม่พบรายการตามตัวกรอง</div>'}`,"history"); }
async function renderSummary() {
  const list = await transactions();
  const isDaily = summaryMode === "daily";
  const monthKey = `${summaryDate.getFullYear()}-${String(summaryDate.getMonth()+1).padStart(2,"0")}`;
  const period = list.filter(t => isDaily ? t.date === summaryDay : t.date.startsWith(monthKey));
  const income = period.filter(t => t.type === "income").reduce((n,t) => n + Number(t.amount), 0);
  const expense = period.filter(t => t.type === "expense").reduce((n,t) => n + Number(t.amount), 0);
  const expenseBy = categories.map(c => ({ c, value:period.filter(t => t.type === "expense" && t.category === c.id).reduce((n,t) => n + Number(t.amount), 0) })).filter(x => x.value);
  const max = Math.max(...expenseBy.map(x => x.value), 1);
  const monthLabel = new Intl.DateTimeFormat("th-TH", { month:"long", year:"numeric" }).format(summaryDate);
  const dayLabel = summaryDay === localDate() ? `วันนี้ · ${dateText(summaryDay)}` : dateText(summaryDay);
  const periodName = isDaily ? "วันนี้" : "เดือนนี้";
  const emptyText = isDaily ? "ยังไม่มีรายจ่ายในวันนี้" : "ยังไม่มีรายจ่ายในเดือนนี้";
  app.innerHTML = layout(`<header class="topbar"><div><p class="eyebrow">ภาพรวมการเงิน</p><h1>สรุป</h1></div></header><div class="summary-toggle" role="tablist" aria-label="รูปแบบสรุป"><button role="tab" aria-selected="${isDaily}" class="${isDaily?'selected':''}" data-summary-mode="daily">รายวัน</button><button role="tab" aria-selected="${!isDaily}" class="${!isDaily?'selected':''}" data-summary-mode="monthly">รายเดือน</button></div>${isDaily ? `<section class="date-picker"><label class="field">เลือกวันที่<input type="date" data-summary-date value="${summaryDay}" /></label><strong>${dayLabel}</strong></section>` : `<section class="month-nav"><button class="back" data-month="-1" aria-label="เดือนก่อนหน้า">←</button><strong>${monthLabel}</strong><button class="back" data-month="1" aria-label="เดือนถัดไป">→</button></section>`}<section class="summary-grid"><div class="card summary-box"><span>รายรับรวม</span><b class="income">${money(income)}</b></div><div class="card summary-box"><span>รายจ่ายรวม</span><b class="expense">${money(expense)}</b></div><div class="card summary-box"><span>ยอดสุทธิ</span><b>${money(income-expense)}</b></div><div class="card summary-box"><span>รายการ${periodName}</span><b>${period.length} รายการ</b></div></section><section class="section"><div class="section-head"><h2>รายจ่ายตามหมวดหมู่</h2><span class="expense-total">รวม ${money(expense)}</span></div><div class="card category-summary">${expenseBy.map(x => `<div class="bar-row"><span>${x.c.icon} ${x.c.name}</span><div class="bar"><i style="width:${x.value/max*100}%"></i></div><b>${money(x.value)}</b></div>`).join("") || `<div class="empty">${emptyText}</div>`}</div></section>`, "summary");
}
async function renderSettings() { const balance=await initialBalance(); app.innerHTML=`<header class="page-head"><button class="back" data-nav="home">←</button><div><p class="eyebrow">ข้อมูลในเครื่องนี้เท่านั้น</p><h1>ตั้งค่า</h1></div></header><section class="form-card"><h2>ยอดเงินเริ่มต้น</h2><p class="hint">ยอดคงเหลือจะคำนวณจากยอดเริ่มต้น + รายรับ − รายจ่าย</p><div class="settings-row"><label class="field">จำนวนเงิน<input id="initial-balance" type="number" min="0" inputmode="decimal" value="${balance}" /></label><button class="primary" data-save-settings>บันทึก</button></div></section><section class="section form-card"><h2>ความเป็นส่วนตัว</h2><p class="hint">รายการและรูปสลิปเก็บใน IndexedDB ของเบราว์เซอร์บนอุปกรณ์นี้เท่านั้น ไม่มีการส่งข้อมูลไปยังเซิร์ฟเวอร์</p></section>`; }
async function render() { if(screen==='home') return renderHome(); if(screen==='form'||screen==='import') return renderForm(screen==='import'); if(screen==='categories') return renderCategoryManager(); if(screen==='history') return renderHistory(); if(screen==='summary') return renderSummary(); return renderSettings(); }
async function saveTransaction(form) { const data=Object.fromEntries(new FormData(form)); if (!draft.category) { toast("กรุณาเลือกหมวดหมู่ก่อนบันทึก"); return; } if (!data.date) { toast("กรุณาระบุวันที่ทำรายการก่อนบันทึก"); return; } const existing=editingId?await get("transactions",editingId):null; const selectedCategory=categoryOf(draft.category); let receiptId=existing?.receiptId||null; if(receiptBlob) { receiptId=crypto.randomUUID(); await put("receipts",{id:receiptId, blob:receiptBlob}); } const t={id:editingId||crypto.randomUUID(), type:draft.type, amount:Number(data.amount), category:draft.category, categoryName:selectedCategory.name, categoryIcon:selectedCategory.icon, merchant:data.merchant.trim(), date:data.date, time:data.time, note:data.note.trim(), reference:(data.reference || draft.reference || "").trim(), receiptId, createdAt:existing?.createdAt||new Date().toISOString()}; await put("transactions",t); editingId=null; draft=newDraft(); receiptBlob=null; ocrState={status:"idle",message:"",rawText:"",debug:null}; screen="home"; toast("บันทึกรายการแล้ว"); render(); }
async function saveCategory(form) { const data=Object.fromEntries(new FormData(form)); const name=data.name.trim(); const icon=(data.icon.trim() || "🏷️").slice(0,4); if (!name) return; if (categories.some(c=>c.name.toLocaleLowerCase()===name.toLocaleLowerCase() && c.id!==categoryEditor.id)) { toast("มีชื่อหมวดหมู่นี้แล้ว"); return; } const category={ id:categoryEditor.id || crypto.randomUUID(), name, icon }; await put("categories", category); await loadCategories(); draft.category=category.id; categoryEditor={id:"",icon:"✨",name:""}; screen=categoryReturnScreen; toast("บันทึกหมวดหมู่แล้ว"); render(); }
document.addEventListener("click", async (e) => { const el=e.target.closest("button"); if(!el) return; if(el.dataset.nav) { screen=el.dataset.nav; return render(); } if(el.dataset.add!==undefined) { editingId=null; draft=newDraft(); receiptBlob=null; screen="form"; return render(); } if(el.dataset.import!==undefined || el.dataset.changeReceipt!==undefined) return receiptInput.click(); if(el.dataset.type) { keepDraftFields(); draft.type=el.dataset.type; return render(); } if(el.dataset.category) { keepDraftFields(); draft.category=el.dataset.category; return render(); } if(el.dataset.manageCategories!==undefined) { keepDraftFields(); categoryReturnScreen=screen; categoryEditor={id:"",icon:"✨",name:""}; screen="categories"; return render(); } if(el.dataset.closeCategories!==undefined) { screen=categoryReturnScreen; return render(); } if(el.dataset.editCategory) { const category=categories.find(c=>c.id===el.dataset.editCategory); if(category) { categoryEditor={...category}; return renderCategoryManager(); } } if(el.dataset.cancelCategoryEdit!==undefined) { categoryEditor={id:"",icon:"✨",name:""}; return renderCategoryManager(); } if(el.dataset.deleteCategory) { const category=categories.find(c=>c.id===el.dataset.deleteCategory); const used=(await transactions()).filter(t=>t.category===category?.id).length; const warning=used?`หมวดหมู่ “${category.name}” ถูกใช้แล้ว ${used} รายการ รายการเก่าจะไม่หายและยังแสดงชื่อเดิมได้\n\nลบหมวดหมู่นี้ใช่หรือไม่?`:`ลบหมวดหมู่ “${category.name}” ใช่หรือไม่?`; if(confirm(warning)) { await remove("categories",category.id); await loadCategories(); if(draft.category===category.id) draft.category=""; categoryEditor={id:"",icon:"✨",name:""}; toast("ลบหมวดหมู่แล้ว"); renderCategoryManager(); } return; } if(el.dataset.settings!==undefined) { screen="settings"; return render(); } if(el.dataset.summaryMode) { summaryMode=el.dataset.summaryMode; return renderSummary(); } if(el.dataset.month) { summaryDate.setMonth(summaryDate.getMonth()+Number(el.dataset.month)); return renderSummary(); } if(el.dataset.viewReceipt) { const receipt=await get("receipts",el.dataset.viewReceipt); if(receipt?.blob) { const url=URL.createObjectURL(receipt.blob); const viewer=document.createElement("div"); viewer.className="receipt-viewer"; viewer.innerHTML=`<button class="back" aria-label="ปิด">×</button><img src="${url}" alt="รูปสลิป" />`; viewer.querySelector("button").onclick=()=>{URL.revokeObjectURL(url);viewer.remove();}; document.body.append(viewer); } return; } if(el.dataset.edit) { const t=await get("transactions",el.dataset.edit); editingId=t.id; draft={...t}; receiptBlob=t.receiptId?(await get("receipts",t.receiptId))?.blob:null; screen="form"; return render(); } if(el.dataset.delete) { if(confirm("ลบรายการนี้ใช่หรือไม่?")) { const t=await get("transactions",el.dataset.delete); await remove("transactions",t.id); if(t.receiptId) await remove("receipts",t.receiptId); toast("ลบรายการแล้ว"); renderHistory(); } } if(el.dataset.cancelEdit!==undefined) { editingId=null; draft=newDraft(); receiptBlob=null; screen="history"; render(); } if(el.dataset.saveSettings!==undefined) { await put("settings",{key:"initialBalance",value:Number(document.querySelector("#initial-balance").value||0)}); toast("บันทึกยอดเงินเริ่มต้นแล้ว"); } });
function handleLiveField(e) { if(e.target.dataset.filter) { historyFilters[e.target.dataset.filter]=e.target.value; renderHistory(); } if("summaryDate" in e.target.dataset) { summaryDay=e.target.value || localDate(); renderSummary(); } }
document.addEventListener("input", handleLiveField);
document.addEventListener("change", handleLiveField);
receiptInput.addEventListener("change", async () => { const file=receiptInput.files[0]; if(!file) return; receiptBlob=file; draft={...newDraft(), category:"", date:"", source:"receipt"}; receiptInput.value=""; toast("แนบรูปแล้ว กำลังอ่านข้อความสลิป…"); await runOcr(file); });
document.addEventListener("submit", (e) => { if(e.target.id==='transaction-form') { e.preventDefault(); saveTransaction(e.target); } if(e.target.id==='category-form') { e.preventDefault(); saveCategory(e.target); } });
await openDb(); await loadCategories(); if("serviceWorker" in navigator) { const appBase = new URL("./", import.meta.url); navigator.serviceWorker.register(new URL("sw.js", appBase), { scope: appBase.pathname }).catch(()=>{}); } render();
