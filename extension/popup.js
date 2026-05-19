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
            const classes = el.className
              .trim()
              .split(/\s+/)
              .slice(0, 2)
              .map((className) => `.${CSS.escape(className)}`)
              .join("");

            selector += classes;
          }

          const parent = el.parentElement;

          if (parent) {
            const siblings = Array.from(parent.children).filter(
              (sibling) => sibling.tagName === el.tagName
            );

            if (siblings.length > 1) {
              selector += `:nth-of-type(${siblings.indexOf(el) + 1})`;
            }
          }

          path.unshift(selector);
          el = el.parentElement;
        }

        return path.join(" > ");
      }

      function cleanContext(text) {
        return text
          .replace(/\s+/g, " ")
          .replace(/add to cart/gi, "")
          .replace(/secure payment methods/gi, "")
          .trim()
          .slice(0, 90);
      }

      function candidateScore(el, text, price) {
        const lower = text.toLowerCase();
        const classId = `${el.className || ""} ${el.id || ""}`.toLowerCase();

        let score = 0;

        if (classId.includes("price")) score += 40;
        if (classId.includes("sale")) score += 30;
        if (classId.includes("special")) score += 25;
        if (classId.includes("product")) score += 10;

        if (lower.includes("don't pay")) score += 15;
        if (lower.includes("was")) score += 15;
        if (lower.includes("now")) score += 20;
        if (lower.includes("off")) score += 20;
        if (lower.includes("sale")) score += 25;
        if (lower.includes("special")) score += 20;
        if (lower.includes("vip")) score += 10;

        if (text.length < 30) score += 15;
        if (text.length > 120) score -= 30;
        if (lower.includes("afterpay")) score -= 35;
        if (lower.includes("payments of")) score -= 35;
        if (lower.includes("shipping")) score -= 40;
        if (price < 20) score -= 25;

        return score;
      }

      const title =
        document.querySelector("h1")?.innerText?.trim() ||
        document.querySelector('meta[property="og:title"]')?.content ||
        document.title ||
        "Unknown Product";

      const ogImage = document.querySelector('meta[property="og:image"]')?.content || null;
      const twitterImage = document.querySelector('meta[name="twitter:image"]')?.content || null;
      let productImage = ogImage || twitterImage || null;

      if (!productImage) {
        const imgCandidates = Array.from(document.querySelectorAll("img")).filter((img) => {
          const src = img.src || "";
          const alt = (img.alt || "").toLowerCase();
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          return w >= 100 && h >= 100 && src && !src.includes("logo") && !src.includes("icon") && !src.includes("badge");
        });
        productImage = imgCandidates[0]?.src || null;
      }

      const pageText = document.body.innerText.toLowerCase();

      let stockStatus = "unknown";

      if (
        pageText.includes("out of stock") ||
        pageText.includes("sold out") ||
        pageText.includes("currently unavailable")
      ) {
        stockStatus = "out_of_stock";
      } else if (
        pageText.includes("ready to ship") ||
        pageText.includes("in stock") ||
        pageText.includes("add to cart") ||
        pageText.includes("add to basket") ||
        pageText.includes("buy now")
      ) {
        stockStatus = "in_stock";
      } else if (pageText.includes("pre-order") || pageText.includes("preorder")) {
        stockStatus = "preorder";
      }

      const elements = Array.from(document.querySelectorAll("body *"));
      const candidates = [];

      elements.forEach((el) => {
        const ownText = Array.from(el.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join(" ")
          .trim();

        const text = ownText || el.innerText?.trim();

        if (!text) return;
        if (text.length > 180) return;

        const matches = text.match(/\$[0-9,]+(?:\.[0-9]{2})?/g) || [];

        matches.forEach((match) => {
          const price = Number(match.replace("$", "").replace(/,/g, ""));

          if (!price || price <= 0) return;

          const context = cleanContext(text);
          const score = candidateScore(el, text, price);

          candidates.push({
            price,
            display: match,
            selector: getCssPath(el),
            contextText: context,
            score
          });
        });
      });

      const bestByPrice = new Map();

      candidates.forEach((candidate) => {
        const existing = bestByPrice.get(candidate.price);

        if (!existing || candidate.score > existing.score) {
          bestByPrice.set(candidate.price, candidate);
        }
      });

      const filtered = Array.from(bestByPrice.values())
        .filter((candidate) => candidate.score >= -10)
        .sort((a, b) => b.score - a.score || b.price - a.price)
        .slice(0, 8);

      return {
        productName: title,
        productImage,
        stockStatus,
        priceCandidates: filtered
      };
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