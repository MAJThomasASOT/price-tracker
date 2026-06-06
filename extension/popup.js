let scannedData = null;

document.getElementById("useTargetPrice").addEventListener("change", () => {
  document.getElementById("targetPrice").disabled = !document.getElementById("useTargetPrice").checked;
});

document.getElementById("scanBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  statusEl.innerText = "Scanning page...";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      function getCssPath(el) {
        if (!(el instanceof Element)) return null;
        const path = [];
        while (el && el.nodeType === Node.ELEMENT_NODE && el.tagName.toLowerCase() !== "html") {
          let selector = el.tagName.toLowerCase();
          if (el.id) {
            selector += `#${CSS.escape(el.id)}`;
            path.unshift(selector);
            break;
          }
          if (el.className && typeof el.className === "string") {
            const classes = el.className.trim().split(/\s+/).slice(0, 2)
              .map((c) => `.${CSS.escape(c)}`).join("");
            selector += classes;
          }
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(s => s.tagName === el.tagName);
            if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(el) + 1})`;
          }
          path.unshift(selector);
          el = el.parentElement;
        }
        return path.join(" > ");
      }

      function cleanContext(text) {
        return text.replace(/\s+/g, " ").replace(/add to cart/gi, "")
          .replace(/secure payment methods/gi, "").trim().slice(0, 90);
      }

      // --- 1. JSON-LD structured data: most reliable source of the real current price ---
      let jsonLdPrice = null;
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const walk = (obj) => {
            if (!obj || typeof obj !== "object") return;
            if ((obj["@type"] === "Offer" || obj["@type"] === "AggregateOffer") && obj.price != null) {
              const p = parseFloat(String(obj.price).replace(/,/g, ""));
              if (!isNaN(p) && p > 0) { jsonLdPrice = p; return; }
            }
            for (const v of Object.values(obj)) {
              if (jsonLdPrice != null) return;
              if (Array.isArray(v)) v.forEach(walk); else walk(v);
            }
          };
          const data = JSON.parse(script.textContent);
          (Array.isArray(data) ? data : [data]).forEach(walk);
        } catch(e) {}
        if (jsonLdPrice != null) break;
      }

      // --- 2. Visual proximity to the product h1 ---
      // The product's own price is always physically close to its title on the page.
      // Related/recommended product prices are much further down.
      const h1El = document.querySelector("h1");
      const h1AbsTop = h1El
        ? (h1El.getBoundingClientRect().top + window.scrollY)
        : null;

      // --- 3. Scoring ---
      function candidateScore(el, text, price, priceMatch, nearbyText) {
        const lower = text.toLowerCase();
        const classId = `${el.className || ""} ${el.id || ""}`.toLowerCase();
        let score = 0;

        // Visual proximity to h1 — strongest discriminator between this product's
        // prices and prices of unrelated products elsewhere on the page.
        if (h1AbsTop != null) {
          try {
            const elTop = el.getBoundingClientRect().top + window.scrollY;
            const dist = Math.abs(elTop - h1AbsTop);
            if (dist < 200)        score += 80;
            else if (dist < 500)   score += 50;
            else if (dist < 800)   score += 10;
            else if (dist < 1200)  score -= 110;
            else                   score -= 220;
          } catch(e) {}
        }

        // JSON-LD offer price: near-definitive
        if (jsonLdPrice != null && Math.abs(price - jsonLdPrice) < 0.015) score += 100;

        // Class/id signals
        if (classId.includes("price")) score += 40;
        if (classId.includes("sale")) score += 30;
        if (classId.includes("special")) score += 20;
        // Mild class penalty for "was/old" — we still WANT the was-price to appear,
        // just ranked below the now-price
        if (classId.includes("was") || classId.includes("old") || classId.includes("original")) score -= 15;
        if (classId.includes("rrp")) score -= 30;
        if (classId.includes("now") || classId.includes("current") || classId.includes("discounted")) score += 30;

        // Small text context adjustments — keep "was" penalty light so it still shows
        if (lower.includes("was")) score -= 10;
        if (lower.includes("now")) score += 20;
        if (lower.includes("rrp") || lower.includes("r.r.p")) score -= 30;
        if (lower.includes("don't pay")) score -= 20;
        if (lower.includes("save")) score += 10;
        if (lower.includes("sale") || lower.includes("special")) score += 15;

        // Fine-grained: check if THIS specific price sits right after "was" or "now".
        // Also check nearbyText (parent/grandparent innerText) to catch sites that put
        // the "NOW" label and the price value in separate sibling elements.
        const ep = priceMatch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const nearby = nearbyText || "";
        const wasRx = new RegExp(`\\bwas[\\s:]*${ep}`, "i");
        const nowRx = new RegExp(`\\bnow[\\s:]*${ep}`, "i");
        if (wasRx.test(text) || wasRx.test(nearby)) score -= 30;
        if (nowRx.test(text) || nowRx.test(nearby)) score += 60;

        if (text.length < 30) score += 15;
        if (text.length > 120) score -= 30;
        if (lower.includes("afterpay")) score -= 35;
        if (lower.includes("payments of")) score -= 120;
        if (lower.includes("free shipping") || lower.includes("shipping over") ||
            lower.includes("shipping on")) score -= 150;
        else if (lower.includes("shipping")) score -= 60;
        if (price < 20) score -= 25;

        return score;
      }

      // --- Product metadata ---
      const title =
        document.querySelector("h1")?.innerText?.trim() ||
        document.querySelector('meta[property="og:title"]')?.content ||
        document.title || "Unknown Product";

      const ogImage = document.querySelector('meta[property="og:image"]')?.content || null;
      const twitterImage = document.querySelector('meta[name="twitter:image"]')?.content || null;
      let productImage = ogImage || twitterImage || null;
      if (!productImage) {
        const imgCandidates = Array.from(document.querySelectorAll("img")).filter((img) => {
          const src = img.src || "";
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          return w >= 100 && h >= 100 && src && !src.includes("logo") &&
                 !src.includes("icon") && !src.includes("badge");
        });
        productImage = imgCandidates[0]?.src || null;
      }

      const pageText = document.body.innerText.toLowerCase();
      let stockStatus = "unknown";
      if (pageText.includes("out of stock") || pageText.includes("sold out") ||
          pageText.includes("currently unavailable")) {
        stockStatus = "out_of_stock";
      } else if (pageText.includes("ready to ship") || pageText.includes("in stock") ||
                 pageText.includes("add to cart") || pageText.includes("add to basket") ||
                 pageText.includes("buy now")) {
        stockStatus = "in_stock";
      } else if (pageText.includes("pre-order") || pageText.includes("preorder")) {
        stockStatus = "preorder";
      }

      // --- Scan elements for price candidates ---
      const candidates = [];
      for (const el of document.querySelectorAll("body *")) {
        const ownText = Array.from(el.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent).join(" ").trim();
        const text = ownText || el.innerText?.trim();
        if (!text || text.length > 180) continue;

        // Collect parent/grandparent text so we can detect "NOW" or "WAS" labels
        // that appear in sibling elements rather than the same element as the price.
        // e.g. site shows "NOW" on its own line then "$1,263.41" on the next line.
        const nearbyText = [
          el.parentElement?.innerText,
          el.parentElement?.parentElement?.innerText
        ].filter(Boolean).join(" ").slice(0, 400);

        for (const match of (text.match(/\$[0-9,]+(?:\.[0-9]{2})?/g) || [])) {
          const price = Number(match.replace("$", "").replace(/,/g, ""));
          if (!price || price <= 0) continue;

          // If this price appears after "now" (own text or nearby sibling),
          // look for a corresponding "WAS $X" in the same area and combine them
          // into a single informative context string.
          const ep = match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const nowRx = new RegExp(`\\bnow[\\s:]*${ep}`, "i");
          const isNowPrice = nowRx.test(text) || nowRx.test(nearbyText);
          let contextText = cleanContext(text);
          if (isNowPrice) {
            const wasMatch = nearbyText.match(/\bwas\s*(\$[0-9,]+(?:\.[0-9]{2})?)/i);
            if (wasMatch) contextText = `WAS ${wasMatch[1]} / NOW ${match}`;
          }

          candidates.push({
            price, display: match,
            selector: getCssPath(el),
            contextText,
            score: candidateScore(el, text, price, match, nearbyText)
          });
        }
      }

      const bestByPrice = new Map();
      for (const c of candidates) {
        const existing = bestByPrice.get(c.price);
        if (!existing || c.score > existing.score) bestByPrice.set(c.price, c);
      }

      const filtered = Array.from(bestByPrice.values())
        .filter(c => c.score >= 40)
        .sort((a, b) => b.score - a.score || b.price - a.price)
        .slice(0, 8);

      return { productName: title, productImage, stockStatus, priceCandidates: filtered };
    }
  });

  scannedData = results[0].result;

  document.getElementById("productName").innerText = scannedData.productName;
  document.getElementById("stockStatus").innerText = scannedData.stockStatus;
  document.getElementById("customName").value = scannedData.productName || "";

  const priceSelect = document.getElementById("priceSelect");
  priceSelect.innerHTML = "";

  if (scannedData.priceCandidates.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No prices detected";
    priceSelect.appendChild(option);
  } else {
    scannedData.priceCandidates.forEach((candidate, index) => {
      const option = document.createElement("option");
      option.value = index;
      option.textContent = `$${candidate.price.toFixed(2)} - ${candidate.contextText || "price detected"}`;
      priceSelect.appendChild(option);
    });
  }

  document.getElementById("scanResults").style.display = "block";
  statusEl.innerText = "Scan complete. Select the correct price location.";
});

document.getElementById("trackBtn").addEventListener("click", async () => {
  const email = document.getElementById("email").value;
  const customName = document.getElementById("customName").value.trim();
  const notifyOnSale = document.getElementById("notifyOnSale").checked;
  const notifyOnBackInStock = document.getElementById("notifyOnBackInStock").checked;
  const useTargetPrice = document.getElementById("useTargetPrice").checked;
  const targetPrice = document.getElementById("targetPrice").value;
  const selectedIndex = document.getElementById("priceSelect").value;
  const statusEl = document.getElementById("status");

  if (!email) {
    statusEl.innerText = "Email is required.";
    return;
  }

  if (!notifyOnSale && !useTargetPrice && !notifyOnBackInStock) {
    statusEl.innerText = "Select at least one alert option.";
    return;
  }

  if (useTargetPrice && !targetPrice) {
    statusEl.innerText = "Target price is enabled, but no price was entered.";
    return;
  }

  if (!scannedData) {
    statusEl.innerText = "Please scan the page first.";
    return;
  }

  const selectedCandidate = scannedData.priceCandidates[Number(selectedIndex)];

  if (!selectedCandidate) {
    statusEl.innerText = "Please select a valid price.";
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url;

  try {
    const response = await fetch(`${BACKEND_BASE_URL}/track`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        store: new URL(url).hostname,
        productName: scannedData.productName,
        productImage: scannedData.productImage || null,
        // Only store a custom name when the user actually typed something different
        // from the auto-detected product name. Sending null preserves any existing
        // custom_name on the backend for re-tracks.
        customName: (customName && customName !== (scannedData.productName || "").trim())
          ? customName
          : null,
        currentPrice: selectedCandidate.price,
        targetPrice: useTargetPrice ? Number(targetPrice) : null,
        email,
        stockStatus: scannedData.stockStatus,
        pageStatus: "active",
        priceSelector: selectedCandidate.selector,
        priceContextText: selectedCandidate.contextText,
        notifyOnPriceDrop: notifyOnSale ? 1 : 0,
        notifyOnTargetPrice: useTargetPrice ? 1 : 0,
        notifyOnBackInStock: notifyOnBackInStock ? 1 : 0,
        notifyOnOutOfStock: 1,
        notifyOnPageRemoved: 1
      })
    });

    const data = await response.json();

    if (data.success) {
      statusEl.innerText = `Tracking saved: ${scannedData.productName}`;
    } else {
      statusEl.innerText = "Error: " + data.message;
    }
  } catch (error) {
    statusEl.innerText = "Failed to connect to backend.";
  }
});

document.getElementById("viewItemsBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("tracked.html") });
});