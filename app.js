const dbName = "my-account";
const categories = [
  ["food", "🍜", "อาหาร"], ["goods", "🛒", "ของใช้"], ["travel", "🚗", "เดินทาง"], ["home", "🏠", "บ้าน"],
  ["bills", "💳", "บิล"], ["shopping", "🛍️", "ช้อปปิ้ง"], ["fun", "🎮", "บันเทิง"], ["other", "📦", "อื่น ๆ"]
].map(([id, icon, name]) => ({ id, icon, name }));
let db; let screen = "home"; let editingId = null; let draft = newDraft(); let receiptBlob = null; let ocrState = { status:"idle", message:"", rawText:"", amountTexts:[] }; let historyFilters = { query:"", type:"all", category:"all", date:"" }; let summaryDate = new Date(); let summaryMode = "daily"; let summaryDay = localDate();
const app = document.querySelector("#app"); const receiptInput = document.querySelector("#receipt-input");
let ocrWorkerPromise = null;

let tesseractLoadPromise = null;

async function ensureTesseract() {
  if (window.Tesseract) return window.Tesseract;
  if (tesseractLoadPromise) return tesseractLoadPromise;

  tesseractLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-tesseract-local]');
    if (existing) {
      existing.addEventListener("load", () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("โหลด Tesseract.js แล้วแต่ไม่พบตัวแปร Tesseract")), { once:true });
      existing.addEventListener("error", () => reject(new Error("โหลดไฟล์ OCR ไม่สำเร็จ")), { once:true });
      return;
    }

    const script = document.createElement("script");
    script.src = new URL("./ocr/tesseract.min.js", import.meta.url).href;
    script.async = true;
    script.dataset.tesseractLocal = "1";
    script.onload = () => window.Tesseract
      ? resolve(window.Tesseract)
      : reject(new Error("ไฟล์ Tesseract.js โหลดแล้ว แต่ไม่พบตัวแปร Tesseract"));
    script.onerror = () => reject(new Error(`เปิดไฟล์ Tesseract.js ไม่ได้: ${script.src}`));
    document.head.appendChild(script);
  });

  try { return await tesseractLoadPromise; }
  catch (error) { tesseractLoadPromise = null; throw error; }
}

async function getOcrWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  ocrWorkerPromise = (async () => {
    const Tesseract = await ensureTesseract();
    const base = new URL("./ocr/", import.meta.url);
    const workerPath = new URL("worker.min.js", base).href;
    const langPath = new URL("lang/", base).href;
    const corePath = new URL("core/tesseract-core-simd-lstm.wasm.js", base).href;

    const worker = await Tesseract.createWorker("tha", 1, {
      workerPath,
      langPath,
      corePath,
      gzip: false,
      logger: (m) => {
        if (m.status === "recognizing text" && typeof m.progress === "number") {
          ocrState.message = `กำลังอ่านข้อความสลิป… ${Math.round(m.progress * 100)}%`;
          if (screen === "import") renderForm(true);
        }
      }
    });
    return worker;
  })();
  try { return await ocrWorkerPromise; }
  catch (error) { ocrWorkerPromise = null; throw error; }
}

function parseOcrText(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const compact = lines.join(" ");

  // Normalize common OCR mistakes in money-looking tokens, e.g. 95.OO -> 95.00.
  const normalizeMoney = (value) => value
    .replace(/[Oo]/g, "0")
    .replace(/\s+(?=\d{2}\b)/g, ".")
    .replace(/,/g, "")
    .replace(/[^0-9.]/g, "");

  let amount = "";
  let bestScore = -Infinity;
  lines.forEach((line, index) => {
    // Fees are not the paid amount on Thai bank slips.
    if (/(?:ค่าธรรมเนียม|fee)/i.test(line)) return;
    // Avoid IDs/account/reference rows which often contain long digit strings.
    if (/(?:รหัสร้านค้า|รหัสธุรกรรม|รหัสอ้างอิง|เลขอ้างอิง|reference|transaction|บัญชี)/i.test(line)) return;

    const candidates = line.match(/(?:\d{1,3}(?:,\d{3})*|\d+)[.,][0-9Oo]{2}\b/g) || [];
    for (const raw of candidates) {
      const normalized = normalizeMoney(raw.replace(/,(?=\d{2}\b)/, "."));
      const value = Number(normalized);
      if (!Number.isFinite(value) || value <= 0 || value > 10000000) continue;

      let score = 10;
      if (/(?:ยอดเงิน|จำนวนเงิน|ยอดชำระ|ยอดจ่าย|รวม|total|amount|payment|บาท|THB|฿)/i.test(line)) score += 100;
      // Amounts on slips are commonly isolated on their own line and near the top.
      if (line.replace(raw, "").trim().length <= 3) score += 45;
      score += Math.max(0, 25 - index * 2);
      // Prefer normal purchase-sized values over 0.xx noise when otherwise tied.
      if (value >= 1) score += 5;

      if (score > bestScore) { bestScore = score; amount = normalized; }
    }
  });

  // Fallback for explicit labels where OCR may omit decimals.
  if (!amount) {
    const explicit = compact.match(/(?:ยอดเงิน|จำนวนเงิน|ยอดชำระ|ยอดจ่าย|รวม|total|amount|payment)[^0-9]{0,20}([0-9]{1,3}(?:,[0-9]{3})*(?:[.,][0-9Oo]{1,2})?)/i);
    if (explicit) { const candidate = normalizeMoney(explicit[1].replace(/,(?=\d{2}\b)/, ".")); if (Number(candidate) > 0) amount = candidate; }
  }

  let date = "";
  const dm = compact.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (dm) {
    let y = Number(dm[3]);
    if (y < 100) y += 2500; // Thai slips commonly print 2-digit Buddhist year, e.g. 69.
    if (y > 2400) y -= 543;
    date = `${y.toString().padStart(4,"0")}-${dm[2].padStart(2,"0")}-${dm[1].padStart(2,"0")}`;
  }

  const tm = compact.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)(?::([0-5]\d))?\b/);
  const time = tm ? `${tm[1].padStart(2,"0")}:${tm[2]}` : "";

  const referenceMatch = compact.match(/(?:reference|ref|เลขอ้างอิง|รหัสอ้างอิง)[^A-Z0-9ก-๙]{0,12}([A-Z0-9]{8,})/i);
  const reference = referenceMatch ? referenceMatch[1] : "";

  // Prefer an English/Thai merchant-like line around the transfer parties rather than the first OCR line.
  const merchantCandidates = lines.map((line, index) => ({ line, index })).filter(({line}) =>
    line.length >= 3 && line.length <= 60 &&
    !/(?:จ่ายบิลสำเร็จ|โอนเงินสำเร็จ|ค่าธรรมเนียม|รายละเอียด|รหัสร้านค้า|รหัสธุรกรรม|รหัสอ้างอิง|เลขอ้างอิง|ธนาคาร|promptpay|พร้อมเพย์)/i.test(line) &&
    !/^\d[\d\s.,:/()-]*$/.test(line) &&
    !/^(?:฿|THB)/i.test(line) &&
    !/^[xX*\-\d\s]+$/.test(line)
  );
  const merchant = (merchantCandidates.find(({line}) => /[A-Z]{2,}(?:\s+[A-Z0-9]{2,})+/i.test(line)) || merchantCandidates.find(({line}) => /[ก-๙A-Za-z]/.test(line)))?.line || "";
  return { amount, date, time, reference, merchant, rawText: text };
}

async function makeAmountCrops(file) {
  const bitmap = await createImageBitmap(file);
  const bands = [{y:0.18,h:0.28},{y:0.25,h:0.28},{y:0.10,h:0.45}];
  const crops = [];
  for (const band of bands) {
    const sy=Math.max(0,Math.floor(bitmap.height*band.y)), sh=Math.min(bitmap.height-sy,Math.floor(bitmap.height*band.h));
    const sx=Math.floor(bitmap.width*0.05), sw=Math.floor(bitmap.width*0.90), scale=Math.max(1,Math.min(2.5,1800/sw));
    const canvas=document.createElement("canvas"); canvas.width=Math.round(sw*scale); canvas.height=Math.round(sh*scale);
    const ctx=canvas.getContext("2d",{willReadFrequently:true}); ctx.fillStyle="white"; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(bitmap,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
    // V8: grayscale + contrast/threshold makes large dark amount digits stand out from decorative slip backgrounds.
    const imageData=ctx.getImageData(0,0,canvas.width,canvas.height), data=imageData.data;
    for(let p=0;p<data.length;p+=4){const gray=Math.round(data[p]*0.299+data[p+1]*0.587+data[p+2]*0.114);const v=gray<185?0:255;data[p]=data[p+1]=data[p+2]=v;}
    ctx.putImageData(imageData,0,0); crops.push(canvas);
  }
  bitmap.close?.(); return crops;
}
function extractAmountFromNumericText(text) {
  const cleaned=String(text||"").replace(/[Oo]/g,"0").replace(/[Il|]/g,"1").replace(/(\d)\s*[.,]\s*(\d{2})\b/g,"$1.$2");
  const values=[]; for(const match of cleaned.matchAll(/(?:^|\D)(\d{1,7}[.,]\d{2})(?=\D|$)/g)){const raw=match[1].replace(",","."),value=Number(raw);if(Number.isFinite(value)&&value>0&&value<=10000000)values.push({raw,value});}
  values.sort((a,b)=>b.value-a.value); return values[0]?.raw||"";
}
async function recognizeAmountSeparately(worker,file) {
  const crops=await makeAmountCrops(file); let best=""; const debugTexts=[];
  try {
    await worker.setParameters({tessedit_char_whitelist:"0123456789.,",tessedit_pageseg_mode:"6",preserve_interword_spaces:"1"});
    for(let i=0;i<crops.length;i++){ocrState.message=`กำลังค้นหายอดเงิน… ${i+1}/${crops.length}`;if(screen==="import")renderForm(true);const result=await worker.recognize(crops[i]);const numericText=result.data?.text||"";debugTexts.push(`CROP ${i+1}:\n${numericText}`);const candidate=extractAmountFromNumericText(numericText);if(candidate&&(!best||Number(candidate)>Number(best)))best=candidate;}
  } finally { await worker.setParameters({tessedit_char_whitelist:"",tessedit_pageseg_mode:"3",preserve_interword_spaces:"0"}).catch(()=>{}); }
  ocrState.amountTexts=debugTexts; return best;
}
async function runOcr(file) {
  ocrState={status:"processing",message:"กำลังเตรียม OCR ภาษาไทย…",rawText:"",amountTexts:[]}; screen="import"; renderForm(true);
  try {
    const worker=await getOcrWorker(); const result=await worker.recognize(file); const fullText=result.data?.text||""; ocrState.rawText=fullText; const parsed=parseOcrText(fullText);
    let amount=parsed.amount;
    // V8: 0.00 is never a useful paid amount. Always run the dedicated amount pass when the full-slip OCR found nothing or zero.
    if(!amount || Number(amount) <= 0) amount=await recognizeAmountSeparately(worker,file);
    if(amount)draft.amount=amount; if(parsed.date)draft.date=parsed.date; if(parsed.time)draft.time=parsed.time; if(parsed.merchant)draft.merchant=parsed.merchant; if(parsed.reference)draft.reference=parsed.reference;
    ocrState={status:"done",message:`อ่านสลิปเสร็จแล้ว${amount?` · พบยอด ${money(amount)}`:" · ยังไม่พบยอด กรุณากรอกยอดเงิน"}`}; renderForm(true);
  } catch(error){console.error(error);ocrState={status:"error",message:`OCR ไม่สำเร็จ (${error?.message||"ไม่ทราบสาเหตุ"})`};renderForm(true);}
}

const money = (n) => new Intl.NumberFormat("th-TH", { style:"currency", currency:"THB", maximumFractionDigits:2 }).format(Number(n || 0));
const dateText = (iso) => new Intl.DateTimeFormat("th-TH", { day:"numeric", month:"short", year:"numeric" }).format(new Date(`${iso}T00:00:00`));
const timeText = (iso) => iso ? new Intl.DateTimeFormat("th-TH", { hour:"2-digit", minute:"2-digit" }).format(new Date(iso)) : "";
function localDate(date = new Date()) { const offset = date.getTimezoneOffset(); return new Date(date.getTime() - offset * 60000).toISOString().slice(0,10); }
function newDraft() { return { type:"expense", amount:"", category:"food", merchant:"", date:localDate(), time:"", note:"", reference:"", receiptId:null, source:"manual" }; }
function categoryOf(id) { return categories.find((c) => c.id === id) || categories.at(-1); }
function openDb() { return new Promise((resolve, reject) => { const request = indexedDB.open(dbName, 1); request.onupgradeneeded = () => { const d = request.result; d.createObjectStore("transactions", { keyPath:"id" }); d.createObjectStore("receipts", { keyPath:"id" }); d.createObjectStore("settings", { keyPath:"key" }); }; request.onsuccess = () => { db = request.result; resolve(); }; request.onerror = () => reject(request.error); }); }
function store(name, mode = "readonly") { return db.transaction(name, mode).objectStore(name); }
function all(name) { return new Promise((resolve, reject) => { const r = store(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
function get(name,id) { return new Promise((resolve,reject) => { const r = store(name).get(id); r.onsuccess = () => resolve(r.result); r.onerror=()=>reject(r.error); }); }
function put(name,item) { return new Promise((resolve,reject) => { const r=store(name,"readwrite").put(item); r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error); }); }
function remove(name,id) { return new Promise((resolve,reject) => { const r=store(name,"readwrite").delete(id); r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error); }); }
async function transactions() { return (await all("transactions")).sort((a,b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`)); }
async function initialBalance() { return Number((await get("settings","initialBalance"))?.value || 0); }
function toast(message) { const t=document.createElement("div"); t.className="toast"; t.textContent=message; document.body.append(t); setTimeout(()=>t.remove(),2300); }
function layout(content, active = "") { return `${content}<nav class="bottom-nav"><button class="nav-button ${active==='home'?'active':''}" data-nav="home"><span>⌂</span>หน้าหลัก</button><button class="nav-button ${active==='history'?'active':''}" data-nav="history"><span>☷</span>รายการ</button><button class="nav-button ${active==='summary'?'active':''}" data-nav="summary"><span>◔</span>สรุป</button></nav>`; }
function itemHtml(t, actions = false) { const c=categoryOf(t.category); return `<article class="transaction"><div class="category-icon">${c.icon}</div><div class="transaction-body"><div class="transaction-title">${escapeHtml(t.merchant || c.name)}</div><div class="transaction-meta">${c.name} · ${dateText(t.date)} ${t.time || ""}</div></div><div class="amount ${t.type}">${t.type==='income'?'+':'-'}${money(t.amount)}</div>${actions?`<div class="row-actions">${t.receiptId?`<button class="small-button" data-view-receipt="${t.receiptId}">สลิป</button>`:''}<button class="small-button" data-edit="${t.id}">แก้ไข</button><button class="small-button danger" data-delete="${t.id}">ลบ</button></div>`:''}</article>`; }
function escapeHtml(value) { const div=document.createElement("div"); div.textContent=value; return div.innerHTML; }
async function renderHome() { const list=await transactions(), start=await initialBalance(), today=localDate(); const inc=list.filter(t=>t.type==='income'), exp=list.filter(t=>t.type==='expense'); const sum=a=>a.reduce((x,t)=>x+Number(t.amount),0); const balance=start+sum(inc)-sum(exp), todayIn=sum(inc.filter(t=>t.date===today)), todayOut=sum(exp.filter(t=>t.date===today)); app.innerHTML=layout(`<header class="topbar"><div><p class="eyebrow">ยินดีต้อนรับกลับมา</p><h1>My Account</h1></div><button class="icon-button" data-settings aria-label="ตั้งค่า">⚙</button></header><section class="balance-card"><span class="balance-label">ยอดคงเหลือทั้งหมด</span><div class="balance">${money(balance)}</div><div class="mini-grid"><div><span>รายรับวันนี้</span><b>${money(todayIn)}</b></div><div><span>รายจ่ายวันนี้</span><b>${money(todayOut)}</b></div><div><span>สุทธิวันนี้</span><b>${money(todayIn-todayOut)}</b></div></div></section><section class="quick-actions"><button class="primary" data-add>＋ เพิ่มรายการ</button><button class="secondary" data-import>▣ นำเข้าสลิป</button></section><section class="section"><div class="section-head"><h2>รายการล่าสุด</h2><button class="link-button" data-nav="history">ดูทั้งหมด</button></div>${list.slice(0,5).map(t=>itemHtml(t)).join("") || '<div class="empty">ยังไม่มีรายการ<br>เริ่มบันทึกรายรับหรือรายจ่ายได้เลย</div>'}</section>`,"home"); }
function categoryButtons() { return `<div class="category-grid">${categories.map(c=>`<button type="button" class="category-option ${draft.category===c.id?'selected':''}" data-category="${c.id}">${c.icon} ${c.name}</button>`).join("")}</div>`; }
function keepDraftFields() { const form=document.querySelector("#transaction-form"); if (!form) return; const data=new FormData(form); draft={...draft, amount:data.get("amount") || "", merchant:data.get("merchant") || "", date:data.get("date") || localDate(), time:data.get("time") || "", note:data.get("note") || "", reference:data.get("reference") || ""}; }
function ocrDebugHtml() { if (!ocrState.rawText && !(ocrState.amountTexts||[]).length) return ""; return `<details class="ocr-debug" open><summary>🔎 Debug OCR (ชั่วคราว)</summary><p class="hint">ข้อความดิบที่ OCR อ่านได้ — ส่งส่วนนี้มาให้ฉันดูได้</p><strong>ทั้งสลิป</strong><pre>${escapeHtml(ocrState.rawText || "(ไม่มีข้อความ)")}</pre><strong>รอบค้นหายอด</strong><pre>${escapeHtml((ocrState.amountTexts||[]).join("\n\n") || "(ไม่ได้รัน/ไม่มีข้อความ)")}</pre></details>`; }
function ocrStatusHtml() { if (ocrState.status === "processing") return `<div class="ocr-status processing">${escapeHtml(ocrState.message || "กำลังอ่านข้อความสลิปในอุปกรณ์…")}</div>`; if (ocrState.status === "done") return `<div class="ocr-status success">${escapeHtml(ocrState.message)}</div>`; if (ocrState.status === "error") return `<div class="ocr-status warning">${escapeHtml(ocrState.message)} กรุณากรอกหรือแก้ไขข้อมูลด้านล่าง</div>`; return ''; }
async function renderForm(importing=false) { const confirmLabel=importing?'ยืนยันและบันทึก':'บันทึกรายการ'; app.innerHTML=`<header class="page-head"><button class="back" data-nav="home">←</button><div><p class="eyebrow">${importing?'ตรวจสอบก่อนบันทึก':'บันทึกให้เร็ว'}</p><h1>${importing?'ตรวจสอบรายการ':'เพิ่มรายการ'}</h1></div></header><form id="transaction-form" class="form-card"><div class="type-toggle"><button type="button" data-type="expense" class="${draft.type==='expense'?'selected':''}">รายจ่าย</button><button type="button" data-type="income" class="${draft.type==='income'?'selected':''}">รายรับ</button></div>${importing?`${ocrStatusHtml()}${ocrDebugHtml()}<p class="hint">OCR เป็นเพียงข้อมูลเสนอแนะ โปรดตรวจสอบ แก้ไข และเลือกหมวดหมู่ด้วยตัวเองก่อนบันทึก</p>`:''}<label class="field">จำนวนเงิน<input class="amount-input" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0.00" value="${draft.amount}" required autofocus /></label><label class="field">เลือกหมวดหมู่${categoryButtons()}</label><label class="field">ชื่อร้าน / ผู้รับเงิน<input name="merchant" placeholder="เช่น 7-Eleven" value="${escapeHtml(draft.merchant)}" /></label><div class="filter-grid"><label class="field">วันที่<input name="date" type="date" value="${draft.date}" required /></label><label class="field">เวลา<input name="time" type="time" value="${draft.time}" /></label></div>${importing?`<label class="field">เลขอ้างอิง (ถ้ามี)<input name="reference" placeholder="เลขอ้างอิงจากสลิป" value="${escapeHtml(draft.reference || '')}" /></label>`:''}<label class="field">หมายเหตุ (ไม่บังคับ)<textarea name="note" rows="2" placeholder="เพิ่มรายละเอียดได้">${escapeHtml(draft.note)}</textarea></label>${receiptBlob?`<img class="receipt-preview" src="${URL.createObjectURL(receiptBlob)}" alt="รูปสลิปที่เลือก" /><button class="secondary" type="button" data-change-receipt>เปลี่ยนรูปสลิป</button>`:`<button class="secondary" type="button" data-import>📷 เลือกรูปสลิป</button>`}<button class="primary save" type="submit">${confirmLabel}</button>${editingId?'<button class="secondary save" type="button" data-cancel-edit>ยกเลิก</button>':''}</form>`; }
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
async function render() { if(screen==='home') return renderHome(); if(screen==='form'||screen==='import') return renderForm(screen==='import'); if(screen==='history') return renderHistory(); if(screen==='summary') return renderSummary(); return renderSettings(); }
async function saveTransaction(form) { const data=Object.fromEntries(new FormData(form)); const existing=editingId?await get("transactions",editingId):null; let receiptId=existing?.receiptId||null; if(receiptBlob) { receiptId=crypto.randomUUID(); await put("receipts",{id:receiptId, blob:receiptBlob}); } const t={id:editingId||crypto.randomUUID(), type:draft.type, amount:Number(data.amount), category:draft.category, merchant:data.merchant.trim(), date:data.date, time:data.time, note:data.note.trim(), reference:(data.reference || draft.reference || "").trim(), receiptId, createdAt:existing?.createdAt||new Date().toISOString()}; await put("transactions",t); editingId=null; draft=newDraft(); receiptBlob=null; screen="home"; toast("บันทึกรายการแล้ว"); render(); }
document.addEventListener("click", async (e) => { const el=e.target.closest("button"); if(!el) return; if(el.dataset.nav) { screen=el.dataset.nav; return render(); } if(el.dataset.add!==undefined) { editingId=null; draft=newDraft(); receiptBlob=null; screen="form"; return render(); } if(el.dataset.import!==undefined || el.dataset.changeReceipt!==undefined) return receiptInput.click(); if(el.dataset.type) { keepDraftFields(); draft.type=el.dataset.type; return render(); } if(el.dataset.category) { keepDraftFields(); draft.category=el.dataset.category; return render(); } if(el.dataset.settings!==undefined) { screen="settings"; return render(); } if(el.dataset.summaryMode) { summaryMode=el.dataset.summaryMode; return renderSummary(); } if(el.dataset.month) { summaryDate.setMonth(summaryDate.getMonth()+Number(el.dataset.month)); return renderSummary(); } if(el.dataset.edit) { const t=await get("transactions",el.dataset.edit); editingId=t.id; draft={...t}; receiptBlob=t.receiptId?(await get("receipts",t.receiptId))?.blob:null; screen="form"; return render(); } if(el.dataset.delete) { if(confirm("ลบรายการนี้ใช่หรือไม่?")) { const t=await get("transactions",el.dataset.delete); await remove("transactions",t.id); if(t.receiptId) await remove("receipts",t.receiptId); toast("ลบรายการแล้ว"); renderHistory(); } } if(el.dataset.cancelEdit!==undefined) { editingId=null; draft=newDraft(); receiptBlob=null; screen="history"; render(); } if(el.dataset.saveSettings!==undefined) { await put("settings",{key:"initialBalance",value:Number(document.querySelector("#initial-balance").value||0)}); toast("บันทึกยอดเงินเริ่มต้นแล้ว"); } });
document.addEventListener("input", (e) => { if(e.target.dataset.filter) { historyFilters[e.target.dataset.filter]=e.target.value; renderHistory(); } if(e.target.dataset.summaryDate) { summaryDay=e.target.value || localDate(); renderSummary(); } });
receiptInput.addEventListener("change", async () => { const file=receiptInput.files[0]; if(!file) return; receiptBlob=file; if(screen!=="form") { draft=newDraft(); screen="import"; } receiptInput.value=""; toast("แนบรูปแล้ว กำลังอ่านข้อความสลิป…"); await runOcr(file); });
document.addEventListener("submit", (e) => { if(e.target.id==='transaction-form') { e.preventDefault(); saveTransaction(e.target); } });
await openDb(); if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{}); render();
