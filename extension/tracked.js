let allItems = [];
let dragSrcId = null;
let scanResult = null;

// ─── Centralized tag definitions ────────────────────────────────────────────
// Single source of truth for badge label, CSS class, and legend description.

const TAG_DEFS = [
  {
    key: "price_drop",
    label: "Price drop / sale",
    cls: "badge-green",
    desc: "Alerts when the item drops below the previously saved price, or sale wording is detected on the page."
  },
  {
    key: "back_in_stock",
    label: "Back in stock",
    cls: "badge-blue",
    desc: "Alerts when an item that was previously unavailable appears to become available again."
  },
  {
    key: "possible_availability",
    label: "Possible availability change",
    cls: "badge-blue",
    desc: "Alerts when previous out-of-stock wording disappears, even if the page does not clearly say \"in stock\"."
  },
  {
    key: "target_price",
    label: "Target price",
    cls: "badge-amber",
    desc: "Alerts when the item reaches or drops below the target price you set."
  },
  {
    key: "out_of_stock",
    label: "Out of stock",
    cls: "badge-red",
    desc: "Alerts when an item that was previously available appears to become unavailable."
  },
  {
    key: "page_removed",
    label: "Page removed",
    cls: "badge-gray",
    desc: "Alerts when the product page appears to be missing, removed, or returning an error."
  },
  {
    key: "manual_check",
    label: "⚠ Manual check required",
    cls: "badge-orange",
    desc: "The tracker found conflicting or unclear availability wording and recommends checking the product page yourself."
  }
];

function tagBadgeHtml(key) {
  const def = TAG_DEFS.find(t => t.key === key);
  return def ? `<span class="badge ${def.cls}">${def.label}</span>` : "";
}

// ─── Display name helper ─────────────────────────────────────────────────────

function getDisplayName(item) {
  const custom  = item.custom_name?.trim();
  const product = item.product_name?.trim();
  return custom || product || item.url || "Unnamed item";
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatStockLabel(s) {
  return { in_stock: "In stock", out_of_stock: "Out of stock", preorder: "Pre-order", unknown: "Unknown" }[s] || s;
}
function formatPageLabel(s) {
  return { active: "Active", not_found: "Page not found", error: "Error", unknown: "Unknown" }[s] || s;
}
function formatPrice(val) {
  return val !== null && val !== undefined ? "$" + Number(val).toFixed(2) : null;
}
function formatDate(val) {
  if (!val) return "Never";
  const d = new Date(val);
  return isNaN(d) ? val : d.toLocaleString();
}
function parseFirstReason(json) {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a[0] || "" : ""; } catch { return ""; }
}
function parseAllReasons(json) {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a : []; } catch { return []; }
}
function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Tag legend ─────────────────────────────────────────────────────────────

function buildTagLegend() {
  const grid = document.getElementById("tagGrid");
  grid.innerHTML = "";
  TAG_DEFS.forEach(def => {
    const entry = document.createElement("div");
    entry.className = "tag-entry";
    entry.innerHTML = `<span class="badge ${def.cls}">${def.label}</span><p>${escHtml(def.desc)}</p>`;
    grid.appendChild(entry);
  });
}

// ─── Card builder ────────────────────────────────────────────────────────────

function buildCard(item) {
  const displayName  = getDisplayName(item);
  const customSet    = !!item.custom_name?.trim();
  const productName  = item.product_name?.trim() || "";
  // Tooltip shows the original detected product name when a custom name is active
  const tooltipName  = customSet && productName && productName !== displayName
    ? productName
    : displayName;
  // Only show the secondary line when there is actually something different to show
  const showOriginal = customSet && productName && productName !== displayName;

  const currentPrice  = formatPrice(item.current_price);
  const previousPrice = formatPrice(item.previous_price);
  const targetPrice   = formatPrice(item.target_price);
  const priceDropped  = item.current_price !== null && item.previous_price !== null
                        && item.current_price < item.previous_price;

  const imageHtml = item.product_image
    ? `<img class="item-thumb" src="${escHtml(item.product_image)}" alt=""
         onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
       <div class="item-thumb-placeholder" style="display:none">📦</div>`
    : `<div class="item-thumb-placeholder">📦</div>`;

  const badges = [];
  if (item.notify_on_price_drop)    badges.push(tagBadgeHtml("price_drop"));
  if (item.notify_on_back_in_stock) badges.push(tagBadgeHtml("back_in_stock"));
  if (item.notify_on_target_price)  badges.push(tagBadgeHtml("target_price"));
  if (item.notify_on_out_of_stock)  badges.push(tagBadgeHtml("out_of_stock"));
  if (item.notify_on_page_removed)  badges.push(tagBadgeHtml("page_removed"));
  if (item.last_stock_manual_check) badges.push(tagBadgeHtml("manual_check"));

  const stockReasons  = parseAllReasons(item.last_stock_confidence_reason);
  const priceReason   = parseFirstReason(item.last_confidence_reason);
  const manualReasons = stockReasons.filter(r =>
    r.toLowerCase().includes("manual") ||
    r.toLowerCase().includes("conflict") ||
    r.toLowerCase().includes("unclear")
  );

  const manualWarningHtml = item.last_stock_manual_check
    ? `<div class="manual-check-warning">
        <strong>⚠ Manual check required</strong>
        ${escHtml(manualReasons[0] || "Conflicting or unclear stock wording detected. Please check the product page.")}
       </div>`
    : "";

  const confidenceHtml = (stockReasons.length || priceReason) && !item.last_stock_manual_check
    ? `<div class="card-confidence">
        ${stockReasons[0] ? `Stock: ${escHtml(stockReasons[0])}` : ""}
        ${stockReasons[0] && priceReason ? "<br>" : ""}
        ${priceReason ? `Price: ${escHtml(priceReason)}` : ""}
       </div>`
    : "";

  const card = document.createElement("div");
  card.className = "item-card";
  card.dataset.id = item.id;
  card.dataset.search = [displayName, item.store, item.url].filter(Boolean).join(" ").toLowerCase();
  card.draggable = true;

  card.innerHTML = `
    <div class="card-top">
      <span class="drag-handle" title="Drag to reorder">⣿</span>
      ${imageHtml}
      <div class="card-names">
        <div class="item-custom-name" title="${escHtml(tooltipName)}">${escHtml(displayName)}</div>
        ${showOriginal ? `<div class="item-product-name" title="${escHtml(item.product_name)}">${escHtml(item.product_name)}</div>` : ""}
        ${item.store ? `<div class="item-store">${escHtml(item.store)}</div>` : ""}
      </div>
    </div>

    <div class="card-prices">
      <div class="price-block">
        <span class="price-label">Current</span>
        <span class="price-value ${priceDropped ? "dropped" : ""}">${currentPrice || "Unknown"}</span>
      </div>
      ${previousPrice ? `<div class="price-block"><span class="price-label">Previous</span><span class="price-value">${previousPrice}</span></div>` : ""}
      ${targetPrice   ? `<div class="price-block"><span class="price-label">Target</span><span class="price-value">${targetPrice}</span></div>` : ""}
    </div>

    <div class="card-status">
      <div class="status-block">
        <span class="status-label">Stock</span>
        <span class="stock-pill stock-${item.stock_status || "unknown"}">${formatStockLabel(item.stock_status)}</span>
      </div>
      <div class="status-block">
        <span class="status-label">Page</span>
        <span class="page-pill page-${item.page_status || "unknown"}">${formatPageLabel(item.page_status)}</span>
      </div>
    </div>

    ${manualWarningHtml}
    ${confidenceHtml}

    <div class="badge-row">${badges.join("")}</div>

    <div class="card-meta">Last checked: ${formatDate(item.last_checked_at)}</div>

    <div class="card-actions">
      <button class="btn-move btn-up"   title="Move up"   data-id="${item.id}">↑</button>
      <button class="btn-move btn-down" title="Move down" data-id="${item.id}">↓</button>
      <a class="btn btn-view" href="${escHtml(item.url)}" target="_blank" rel="noopener">View product</a>
      <button class="btn btn-delete" data-id="${item.id}">Delete</button>
    </div>
  `;

  card.querySelector(".btn-delete").addEventListener("click", () => deleteItem(item.id, card));
  card.querySelector(".btn-up").addEventListener("click",     () => moveCard(item.id, "up"));
  card.querySelector(".btn-down").addEventListener("click",   () => moveCard(item.id, "down"));
  addDragHandlers(card);
  return card;
}

// ─── Drag-and-drop ───────────────────────────────────────────────────────────

function addDragHandlers(card) {
  card.addEventListener("dragstart", (e) => {
    dragSrcId = Number(card.dataset.id);
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    document.querySelectorAll(".item-card").forEach(c => c.classList.remove("drag-over"));
  });
  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (Number(card.dataset.id) !== dragSrcId) card.classList.add("drag-over");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("drag-over");
    const targetId = Number(card.dataset.id);
    if (dragSrcId && dragSrcId !== targetId) {
      const grid = document.getElementById("itemsGrid");
      const srcCard = grid.querySelector(`[data-id="${dragSrcId}"]`);
      if (srcCard) { grid.insertBefore(srcCard, card); saveOrder(); updateMoveButtons(); }
    }
  });
}

// ─── Move Up / Down ──────────────────────────────────────────────────────────

function moveCard(id, direction) {
  const grid  = document.getElementById("itemsGrid");
  const cards = Array.from(grid.children);
  const idx   = cards.findIndex(c => Number(c.dataset.id) === id);
  if (idx === -1) return;
  if (direction === "up"   && idx > 0)                grid.insertBefore(cards[idx], cards[idx - 1]);
  if (direction === "down" && idx < cards.length - 1) grid.insertBefore(cards[idx + 1], cards[idx]);
  saveOrder();
  updateMoveButtons();
}

function updateMoveButtons() {
  const cards = Array.from(document.getElementById("itemsGrid").children);
  cards.forEach((card, idx) => {
    const up   = card.querySelector(".btn-up");
    const down = card.querySelector(".btn-down");
    if (up)   up.disabled   = idx === 0;
    if (down) down.disabled = idx === cards.length - 1;
  });
}

// ─── Save order ──────────────────────────────────────────────────────────────

async function saveOrder() {
  const orderedIds = Array.from(document.getElementById("itemsGrid").children)
    .map(c => Number(c.dataset.id));
  try {
    await fetch(`${BACKEND_BASE_URL}/items/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds })
    });
  } catch { /* silent — DOM already updated */ }
}

// ─── Render items ────────────────────────────────────────────────────────────

function renderItems(items) {
  const grid    = document.getElementById("itemsGrid");
  const empty   = document.getElementById("emptyState");
  const loading = document.getElementById("loadingState");
  const status  = document.getElementById("statusBar");

  loading.style.display = "none";
  grid.innerHTML = "";

  if (!items.length) {
    empty.style.display = "block";
    status.textContent = "";
    return;
  }

  empty.style.display = "none";
  status.textContent = `${items.length} tracked item${items.length !== 1 ? "s" : ""}`;
  items.forEach(item => grid.appendChild(buildCard(item)));
  updateMoveButtons();
}

// ─── Load items ──────────────────────────────────────────────────────────────

async function loadItems() {
  document.getElementById("loadingState").style.display = "block";
  document.getElementById("emptyState").style.display   = "none";
  document.getElementById("itemsGrid").innerHTML        = "";
  document.getElementById("statusBar").textContent      = "";
  document.getElementById("searchInput").value          = "";

  try {
    const res = await fetch(`${BACKEND_BASE_URL}/items`);
    allItems = await res.json();
    renderItems(allItems);
  } catch {
    document.getElementById("loadingState").style.display = "none";
    document.getElementById("statusBar").textContent =
      "Failed to load items. Is the backend running on port 3001?";
  }
}

// ─── Search / filter ─────────────────────────────────────────────────────────

function applyFilter() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const filtered = query
    ? allItems.filter(item => {
        const hay = [item.custom_name, item.product_name, item.store, item.url]
          .filter(Boolean).join(" ").toLowerCase();
        return hay.includes(query);
      })
    : allItems;
  renderItems(filtered);
}

// ─── Delete ──────────────────────────────────────────────────────────────────

async function deleteItem(id, card) {
  if (!confirm("Remove this tracked item?")) return;
  try {
    const res  = await fetch(`${BACKEND_BASE_URL}/items/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (data.success) {
      allItems = allItems.filter(i => i.id !== id);
      card.remove();
      updateMoveButtons();
      const remaining = document.getElementById("itemsGrid").children.length;
      document.getElementById("statusBar").textContent =
        remaining ? `${remaining} tracked item${remaining !== 1 ? "s" : ""}` : "";
      if (!remaining) document.getElementById("emptyState").style.display = "block";
    } else {
      alert("Failed to delete: " + data.message);
    }
  } catch { alert("Failed to connect to backend."); }
}

// ─── URL Import ──────────────────────────────────────────────────────────────

function setImportStatus(msg, type = "") {
  const el = document.getElementById("importStatus");
  el.textContent = msg;
  el.className = type;
}

function resetImportForm() {
  document.getElementById("importUrlInput").value = "";
  document.getElementById("importReview").style.display = "none";
  document.getElementById("importReview").innerHTML = "";
  setImportStatus("");
  scanResult = null;
}

function buildReviewForm(result) {
  const imageHtml = result.productImage
    ? `<img id="reviewImage" src="${escHtml(result.productImage)}" alt=""
          onerror="this.style.display='none';document.getElementById('reviewImagePlaceholder').style.display='flex'" />
       <div id="reviewImagePlaceholder" style="display:none">📦</div>`
    : `<div id="reviewImagePlaceholder">📦</div>`;

  const candidateOptions = (result.priceCandidates || [])
    .filter(p => p > 0)
    .map(p => `<option value="${p}" ${p === result.currentPrice ? "selected" : ""}>$${Number(p).toFixed(2)}</option>`)
    .join("");

  const priceSection = candidateOptions
    ? `<label class="form-label">Detected price</label>
       <select id="reviewPrice" class="form-input">${candidateOptions}</select>`
    : result.currentPrice !== null
      ? `<label class="form-label">Detected price</label>
         <input id="reviewPrice" class="form-input" type="number" step="0.01" value="${result.currentPrice}" />`
      : `<label class="form-label">Price (none detected — enter manually if needed)</label>
         <input id="reviewPrice" class="form-input" type="number" step="0.01" placeholder="Optional" />`;

  return `
    <div class="review-top">
      ${imageHtml}
      <div class="review-info">
        ${result.productName ? `<div class="detected-name">Detected: ${escHtml(result.productName)}</div>` : ""}
        <label class="form-label">Custom display name</label>
        <input id="reviewCustomName" class="form-input" type="text"
          value="${escHtml(result.productName || "")}"
          placeholder="e.g. Blue headphones" />
      </div>
    </div>

    <div style="margin-top:2px; font-size:12px; color:#6b7280;">
      Stock: <strong>${formatStockLabel(result.stockStatus)}</strong>
      &nbsp;Page: <strong>${formatPageLabel(result.pageStatus)}</strong>
      ${result.stockManualCheckRequired ? '&nbsp;<span class="badge badge-orange">⚠ Manual check</span>' : ""}
    </div>

    ${priceSection}

    <div class="form-row" style="margin-top:10px">
      <div class="form-col">
        <label class="form-label">Your email for alerts</label>
        <input id="reviewEmail" class="form-input" type="email" placeholder="you@example.com" />
      </div>
      <div class="form-col">
        <label class="form-label">Target price (optional)</label>
        <input id="reviewTargetPrice" class="form-input" type="number" step="0.01" placeholder="e.g. 299.00" disabled />
      </div>
    </div>

    <label class="form-label" style="margin-top:12px">Notify me when…</label>
    <div class="checkbox-group">
      <label class="checkbox-row">
        <input type="checkbox" id="rvPriceDrop" checked />
        <span>Price drops / goes on sale</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" id="rvBackInStock" checked />
        <span>Item comes back in stock / becomes available</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" id="rvTargetPrice" />
        <span>Target price is reached</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" id="rvOutOfStock" checked />
        <span>Item goes out of stock</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" id="rvPageRemoved" checked />
        <span>Product page is removed</span>
      </label>
    </div>

    <button id="reviewSaveBtn">Track This Item</button>
  `;
}

async function scanUrl() {
  const url = document.getElementById("importUrlInput").value.trim();
  if (!url) {
    setImportStatus("Please paste a product URL first.", "error");
    return;
  }

  const btn = document.getElementById("scanUrlBtn");
  btn.disabled = true;
  btn.textContent = "Scanning…";
  setImportStatus("Scanning product page…");
  document.getElementById("importReview").style.display = "none";
  document.getElementById("importReview").innerHTML = "";

  try {
    const res  = await fetch(`${BACKEND_BASE_URL}/scan-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await res.json();

    if (!data.success) {
      setImportStatus("Could not scan this URL. Please check the link or try again.", "error");
      return;
    }

    scanResult = data;
    const reviewEl = document.getElementById("importReview");
    reviewEl.innerHTML = buildReviewForm(data);
    reviewEl.style.display = "block";
    setImportStatus("Review the details below, then click Track This Item.");

    // Wire target price toggle
    document.getElementById("rvTargetPrice").addEventListener("change", (e) => {
      document.getElementById("reviewTargetPrice").disabled = !e.target.checked;
    });

    // Wire save button
    document.getElementById("reviewSaveBtn").addEventListener("click", saveImport);

  } catch {
    setImportStatus("Could not scan this URL. Please check the link or try again.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Scan / Import Item";
  }
}

async function saveImport() {
  if (!scanResult) return;

  const email = document.getElementById("reviewEmail").value.trim();
  if (!email) {
    setImportStatus("Email is required for alerts.", "error");
    return;
  }

  const rawCustomName   = document.getElementById("reviewCustomName").value.trim();
  const customName      = (rawCustomName && rawCustomName !== (scanResult.productName || "").trim())
    ? rawCustomName
    : null;
  const priceEl         = document.getElementById("reviewPrice");
  const currentPrice    = priceEl ? (Number(priceEl.value) || null) : null;
  const useTarget       = document.getElementById("rvTargetPrice").checked;
  const targetPriceVal  = useTarget ? (Number(document.getElementById("reviewTargetPrice").value) || null) : null;

  const payload = {
    url:                 scanResult.url,
    store:               (() => { try { return new URL(scanResult.url).hostname; } catch { return null; } })(),
    productName:         scanResult.productName || null,
    productImage:        scanResult.productImage || null,
    customName:          customName,
    currentPrice,
    targetPrice:         targetPriceVal,
    email,
    stockStatus:         scanResult.stockStatus || "unknown",
    pageStatus:          scanResult.pageStatus  || "active",
    priceSelector:       null,
    priceContextText:    scanResult.priceContextText || null,
    notifyOnPriceDrop:   document.getElementById("rvPriceDrop").checked    ? 1 : 0,
    notifyOnTargetPrice: useTarget                                          ? 1 : 0,
    notifyOnBackInStock: document.getElementById("rvBackInStock").checked  ? 1 : 0,
    notifyOnOutOfStock:  document.getElementById("rvOutOfStock").checked   ? 1 : 0,
    notifyOnPageRemoved: document.getElementById("rvPageRemoved").checked  ? 1 : 0
  };

  const saveBtn = document.getElementById("reviewSaveBtn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  try {
    const res  = await fetch(`${BACKEND_BASE_URL}/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      setImportStatus("Item saved! Refreshing list…", "success");
      resetImportForm();
      await loadItems();
    } else {
      setImportStatus("Error: " + data.message, "error");
      saveBtn.disabled = false;
      saveBtn.textContent = "Track This Item";
    }
  } catch {
    setImportStatus("Failed to connect to backend.", "error");
    saveBtn.disabled = false;
    saveBtn.textContent = "Track This Item";
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.getElementById("refreshBtn").addEventListener("click", loadItems);
document.getElementById("searchInput").addEventListener("input", applyFilter);
document.getElementById("scanUrlBtn").addEventListener("click", scanUrl);

buildTagLegend();
loadItems();
