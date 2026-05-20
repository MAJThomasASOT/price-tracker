
require("dotenv").config();

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { Pool } = require("pg");
const axios = require("axios");
const cheerio = require("cheerio");
const cron = require("node-cron");
const { Resend } = require("resend");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3001;
const DATABASE_TYPE = process.env.DATABASE_TYPE || "sqlite";

let db;
let pgPool;

if (DATABASE_TYPE === "postgres") {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
  });

  console.log("Using PostgreSQL database.");
} else {
  db = new sqlite3.Database(process.env.SQLITE_PATH || "./price-tracker.db");
  console.log("Using SQLite database.");
}
function normaliseSql(sql) {
  if (DATABASE_TYPE !== "postgres") return sql;

  let index = 0;

  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

function dbRun(sql, params = []) {
  if (DATABASE_TYPE === "postgres") {
    return pgPool.query(normaliseSql(sql), params);
  }

  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  if (DATABASE_TYPE === "postgres") {
    return pgPool.query(normaliseSql(sql), params).then((result) => result.rows[0] || null);
  }

  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  if (DATABASE_TYPE === "postgres") {
    return pgPool.query(normaliseSql(sql), params).then((result) => result.rows);
  }

  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}
const resend = new Resend(process.env.RESEND_API_KEY);

async function initialiseDatabase() {
  if (DATABASE_TYPE === "postgres") {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS tracked_items (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL,
        store TEXT,
        product_name TEXT,
        current_price REAL,
        previous_price REAL,
        target_price REAL,
        email TEXT NOT NULL,

        price_selector TEXT,
        price_context_text TEXT,
        last_confidence_score INTEGER DEFAULT 0,
        last_confidence_reason TEXT,

        product_image TEXT,
        custom_name TEXT,

        stock_status TEXT DEFAULT 'unknown',
        previous_stock_status TEXT DEFAULT 'unknown',
        last_stock_confidence_score INTEGER DEFAULT 0,
        last_stock_confidence_reason TEXT,

        page_status TEXT DEFAULT 'unknown',
        previous_page_status TEXT DEFAULT 'unknown',

        notify_on_price_drop INTEGER DEFAULT 1,
        notify_on_target_price INTEGER DEFAULT 0,
        notify_on_back_in_stock INTEGER DEFAULT 1,
        notify_on_out_of_stock INTEGER DEFAULT 1,
        notify_on_page_removed INTEGER DEFAULT 1,

        display_order INTEGER DEFAULT 0,
        last_stock_manual_check INTEGER DEFAULT 0,
        last_alert_sent TEXT,

        status TEXT DEFAULT 'tracked',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_checked_at TIMESTAMP
      )
    `);

    const pgMigrations = [
      "ALTER TABLE tracked_items ADD COLUMN IF NOT EXISTS product_image TEXT",
      "ALTER TABLE tracked_items ADD COLUMN IF NOT EXISTS custom_name TEXT",
      "ALTER TABLE tracked_items ADD COLUMN IF NOT EXISTS last_stock_confidence_score INTEGER DEFAULT 0",
      "ALTER TABLE tracked_items ADD COLUMN IF NOT EXISTS last_stock_confidence_reason TEXT",
      "ALTER TABLE tracked_items ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0",
      "ALTER TABLE tracked_items ADD COLUMN IF NOT EXISTS last_stock_manual_check INTEGER DEFAULT 0",
      "ALTER TABLE tracked_items ADD COLUMN IF NOT EXISTS last_alert_sent TEXT"
    ];
    for (const sql of pgMigrations) {
      await dbRun(sql);
    }

    return;
  }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS tracked_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      store TEXT,
      product_name TEXT,
      current_price REAL,
      previous_price REAL,
      target_price REAL,
      email TEXT NOT NULL,

      price_selector TEXT,
      price_context_text TEXT,
      last_confidence_score INTEGER DEFAULT 0,
      last_confidence_reason TEXT,

      product_image TEXT,
      custom_name TEXT,

      stock_status TEXT DEFAULT 'unknown',
      previous_stock_status TEXT DEFAULT 'unknown',
      last_stock_confidence_score INTEGER DEFAULT 0,
      last_stock_confidence_reason TEXT,

      page_status TEXT DEFAULT 'unknown',
      previous_page_status TEXT DEFAULT 'unknown',

      notify_on_price_drop INTEGER DEFAULT 1,
      notify_on_target_price INTEGER DEFAULT 0,
      notify_on_back_in_stock INTEGER DEFAULT 1,
      notify_on_out_of_stock INTEGER DEFAULT 1,
      notify_on_page_removed INTEGER DEFAULT 1,

      display_order INTEGER DEFAULT 0,
      last_stock_manual_check INTEGER DEFAULT 0,
      last_alert_sent TEXT,

      status TEXT DEFAULT 'tracked',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_checked_at TEXT
    )
  `);

  // Use PRAGMA to check which columns actually exist, then add any that are missing.
  // This is more reliable than ALTER TABLE + .catch() because it logs what happened.
  const existingColumns = await dbAll("PRAGMA table_info(tracked_items)");
  const colNames = existingColumns.map(c => c.name);

  const neededColumns = [
    { name: "product_image",               def: "TEXT" },
    { name: "custom_name",                 def: "TEXT" },
    { name: "last_stock_confidence_score", def: "INTEGER DEFAULT 0" },
    { name: "last_stock_confidence_reason",def: "TEXT" },
    { name: "display_order",               def: "INTEGER DEFAULT 0" },
    { name: "last_stock_manual_check",     def: "INTEGER DEFAULT 0" },
    { name: "last_alert_sent",             def: "TEXT" }
  ];

  for (const col of neededColumns) {
    if (!colNames.includes(col.name)) {
      await dbRun(`ALTER TABLE tracked_items ADD COLUMN ${col.name} ${col.def}`);
      console.log(`[DB migration] Added missing column: ${col.name}`);
    }
  }
}

async function sendEmail(to, subject, body, htmlBody = null) {
  if (!process.env.RESEND_API_KEY) {
    console.log("Resend API key not configured. Skipping email.");
    return;
  }

  const { data, error } = await resend.emails.send({
    from: process.env.RESEND_FROM || "Price Tracker <onboarding@resend.dev>",
    to,
    subject,
    text: body,
    html: htmlBody || undefined
  });

  if (error) {
    throw new Error(JSON.stringify(error));
  }

  return data;
}

function formatStatus(status) {
  const labels = {
    in_stock: "In stock",
    out_of_stock: "Out of stock",
    preorder: "Pre-order",
    unknown: "Unknown",
    active: "Active",
    not_found: "Page not found",
    error: "Error"
  };

  return labels[status] || status;
}

function parsePrices(text) {
  const matches = text.match(/\$[0-9,]+(?:\.[0-9]{2})?/g) || [];

  return [...new Set(
    matches
      .map((price) => Number(price.replace("$", "").replace(/,/g, "")))
      .filter((price) => price > 0)
  )];
}

function detectStockStatus(text) {
  const lower = text.toLowerCase();

  const strongOutSignals = [
    { phrase: "out of stock", score: 5 },
    { phrase: "out-of-stock", score: 5 },
    { phrase: "sold out", score: 5 },
    { phrase: "sold-out", score: 5 },
    { phrase: "currently out of stock", score: 5 },
    { phrase: "notify me when available", score: 5 },
    { phrase: "notify me when back in stock", score: 5 },
    { phrase: "email me when available", score: 5 },
    { phrase: "back in stock notification", score: 5 }
  ];

  const generalOutSignals = [
    { phrase: "currently unavailable", score: 3 },
    { phrase: "temporarily unavailable", score: 3 },
    { phrase: "not available", score: 3 },
    { phrase: "no longer available", score: 3 },
    { phrase: "this item is unavailable", score: 3 },
    { phrase: "item unavailable", score: 3 },
    { phrase: "product unavailable", score: 3 },
    { phrase: "unavailable online", score: 3 },
    { phrase: "stock unavailable", score: 3 },
    { phrase: "cannot be added to cart", score: 3 },
    { phrase: "notify when available", score: 3 }
  ];

  // Only phrases that clearly mean "this specific item is available to buy"
  const strongInSignals = [
    { phrase: "in stock", score: 5 },
    { phrase: "ready to ship", score: 5 }
  ];

  const generalInSignals = [
    { phrase: "add to cart", score: 4 },
    { phrase: "add to basket", score: 4 },
    { phrase: "buy now", score: 4 },
    { phrase: "available now", score: 3 },
    { phrase: "available for delivery", score: 3 },
    { phrase: "ships today", score: 3 },
    { phrase: "ships now", score: 3 },
    { phrase: "dispatches today", score: 3 },
    { phrase: "dispatches within", score: 3 },
    { phrase: "left in stock", score: 5 },
    { phrase: "low stock", score: 3 },
    { phrase: "limited stock", score: 3 }
    // Note: "available online" and bare "availability" are intentionally excluded
    // to avoid false positives from headings like "Stock availability" or
    // "Warehouse availability: Call for stock availability".
  ];

  const preorderSignals = [
    { phrase: "pre-order", score: 4 },
    { phrase: "preorder", score: 4 },
    { phrase: "pre order", score: 4 },
    { phrase: "available for pre-order", score: 4 },
    { phrase: "available for preorder", score: 4 }
  ];

  // Phrases that indicate unclear/contradictory availability requiring manual check
  const contradictionSignals = [
    "call for stock availability",
    "call for availability",
    "contact us for availability",
    "contact store for availability",
    "check store availability",
    "check availability",
    "warehouse availability",
    "store availability",
    "call to confirm availability",
    "ring for availability",
    "phone for availability"
  ];

  let outScore = 0;
  let inScore = 0;
  let preorderScore = 0;
  const outOfStockSignalsFound = [];
  const inStockSignalsFound = [];
  const stockConflictReasons = [];
  const reasons = [];

  for (const { phrase, score } of strongOutSignals) {
    if (lower.includes(phrase)) {
      outScore += score;
      outOfStockSignalsFound.push(phrase);
    }
  }

  for (const { phrase, score } of generalOutSignals) {
    if (lower.includes(phrase)) {
      outScore += score;
      outOfStockSignalsFound.push(phrase);
    }
  }

  for (const { phrase, score } of strongInSignals) {
    if (lower.includes(phrase)) {
      inScore += score;
      inStockSignalsFound.push(phrase);
    }
  }

  for (const { phrase, score } of generalInSignals) {
    if (lower.includes(phrase)) {
      inScore += score;
      inStockSignalsFound.push(phrase);
    }
  }

  for (const { phrase, score } of preorderSignals) {
    if (lower.includes(phrase)) {
      preorderScore += score;
    }
  }

  if (/only\s+\d+\s+left/.test(lower)) {
    inScore += 5;
    inStockSignalsFound.push("only X left");
  }
  if (/\d+\s+left\s+in\s+stock/.test(lower)) {
    inScore += 5;
    inStockSignalsFound.push("X left in stock");
  }

  // Detect contradiction/unclear signals
  for (const phrase of contradictionSignals) {
    if (lower.includes(phrase)) {
      stockConflictReasons.push(`Unclear availability wording found: "${phrase}"`);
    }
  }

  // Detect conflicting in-stock + out-of-stock signals on same page
  if (inScore >= 3 && outScore >= 3) {
    stockConflictReasons.push(
      `Conflicting stock signals: in-stock (${inStockSignalsFound.join(", ")}) and out-of-stock (${outOfStockSignalsFound.join(", ")}) both detected.`
    );
  }

  // Strong in-stock evidence (e.g. "2 in stock" + "add to cart") overrides
  // contradiction signals. Pages with a "Stock Availability" heading and a
  // numeric count or "add to cart" button are clearly available — the
  // contradictory phrase is likely from a different section of the page.
  const strongInStockConfirmed =
    inStockSignalsFound.some(s => s.includes("left in stock") || s.includes("only X")) ||
    (inStockSignalsFound.includes("in stock") && inStockSignalsFound.includes("add to cart")) ||
    inScore >= 8;

  const stockConflictDetected = stockConflictReasons.length > 0 && !strongInStockConfirmed;
  const stockManualCheckRequired = stockConflictDetected;

  let status;

  if (stockManualCheckRequired) {
    // Keep unknown when wording is contradictory — don't flip to in_stock
    status = "unknown";
    reasons.push("Manual check required: unclear or contradictory availability wording.");
    stockConflictReasons.forEach((r) => reasons.push(r));
  } else if (preorderScore > outScore && preorderScore >= inScore) {
    status = "preorder";
    reasons.push("Pre-order wording found.");
  } else if (outScore > inScore) {
    status = "out_of_stock";
    if (outOfStockSignalsFound.length) {
      reasons.push(`Out-of-stock wording found: ${outOfStockSignalsFound.join(", ")}.`);
    }
  } else if (inScore > outScore) {
    status = "in_stock";
    if (inStockSignalsFound.length) {
      reasons.push(`Available wording found: ${inStockSignalsFound.join(", ")}.`);
    }
  } else {
    status = "unknown";
    reasons.push("No clear stock signals found.");
  }

  const confidenceScore = Math.max(outScore, inScore, preorderScore);

  return {
    status,
    confidenceScore,
    reasons,
    outOfStockSignalsFound,
    inStockSignalsFound,
    stockConflictDetected,
    stockManualCheckRequired,
    stockConflictReasons
  };
}

function findSaleIndicators(text) {
  const lower = text.toLowerCase();
  const indicators = [];

  const patterns = [
    "sale",
    "special",
    "clearance",
    "discount",
    "was",
    "now",
    "save",
    "off",
    "% off",
    "don't pay",
    "reduced",
    "limited time",
    "vip specials"
  ];

  patterns.forEach((pattern) => {
    if (lower.includes(pattern)) indicators.push(pattern);
  });

  const percentMatches = lower.match(/[0-9]{1,2}(?:\.[0-9]+)?%\s*off/g) || [];
  percentMatches.forEach((match) => indicators.push(match));

  return [...new Set(indicators)];
}

function chooseClosestPrice(prices, previousPrice) {
  if (!prices.length) return null;

  if (previousPrice === null || previousPrice === undefined) {
    return Math.min(...prices);
  }

  let closest = prices[0];
  let smallestDiff = Math.abs(prices[0] - previousPrice);

  for (const price of prices) {
    const diff = Math.abs(price - previousPrice);

    if (diff < smallestDiff) {
      smallestDiff = diff;
      closest = price;
    }
  }

  return closest;
}

function calculateDropPercent(oldPrice, newPrice) {
  if (!oldPrice || !newPrice || newPrice >= oldPrice) return 0;
  return ((oldPrice - newPrice) / oldPrice) * 100;
}

function scorePriceConfidence(item, newPrice, selectorWorked, selectorText, pageText) {
  let score = 0;
  const reasons = [];

  const previousPrice = item.current_price;
  const saleIndicators = findSaleIndicators(`${selectorText || ""}\n${pageText || ""}`);
  const dropPercent = calculateDropPercent(previousPrice, newPrice);

  if (selectorWorked) {
    score += 55;
    reasons.push("Saved price selector matched.");
  }

  if (newPrice !== null && previousPrice !== null) {
    const ratio = newPrice / previousPrice;

    if (ratio >= 0.5 && ratio < 1) {
      score += 20;
      reasons.push(`Price dropped by ${dropPercent.toFixed(1)}%.`);
    } else if (ratio >= 0.25 && ratio < 0.5) {
      score += 5;
      reasons.push(`Large price drop detected: ${dropPercent.toFixed(1)}%.`);
    } else if (ratio < 0.25) {
      score -= 40;
      reasons.push("Price drop looks unusually large and may be unrelated.");
    } else if (ratio === 1) {
      score += 5;
      reasons.push("Price unchanged from previous check.");
    }
  }

  if (saleIndicators.length > 0) {
    score += 20;
    reasons.push(`Sale indicators found: ${saleIndicators.join(", ")}.`);
  }

  if (
    item.price_context_text &&
    selectorText &&
    selectorText.toLowerCase().includes(item.price_context_text.toLowerCase().slice(0, 30))
  ) {
    score += 10;
    reasons.push("Price context still resembles selected price area.");
  }

  if (newPrice !== null && item.target_price !== null && newPrice <= item.target_price) {
    score += 10;
    reasons.push("Target price condition matched.");
  }

  return {
    score,
    reasons,
    saleIndicators,
    dropPercent
  };
}

async function scanProductPage(item) {
  try {
    const response = await axios.get(item.url, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 PriceTrackerBot/1.0"
      },
      validateStatus: () => true
    });

    if (response.status === 404 || response.status === 410) {
      return {
        pageStatus: "not_found",
        currentPrice: null,
        stockStatus: "unknown",
        stockResult: { status: "unknown", confidenceScore: 0, reasons: ["Page not found."], outOfStockSignalsFound: [], inStockSignalsFound: [] },
        productName: null,
        selectorWorked: false,
        selectorText: "",
        confidence: { score: 0, reasons: ["Page not found."], saleIndicators: [], dropPercent: 0 }
      };
    }

    if (response.status >= 400) {
      return {
        pageStatus: "error",
        currentPrice: null,
        stockStatus: "unknown",
        stockResult: { status: "unknown", confidenceScore: 0, reasons: ["Page returned an error."], outOfStockSignalsFound: [], inStockSignalsFound: [] },
        productName: null,
        selectorWorked: false,
        selectorText: "",
        confidence: { score: 0, reasons: ["Page returned an error."], saleIndicators: [], dropPercent: 0 }
      };
    }

    const $ = cheerio.load(response.data);
    const bodyText = $("body").text();

    const productName =
      $("h1").first().text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      $("title").text().trim() ||
      null;

    const productImage =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      null;

    let selectorWorked = false;
    let selectorText = "";
    let selectedPrice = null;

    if (item.price_selector) {
      try {
        const selectedEl = $(item.price_selector).first();

        if (selectedEl.length) {
          selectorWorked = true;
          selectorText = selectedEl.text().trim();
          const selectorPrices = parsePrices(selectorText);
          selectedPrice = chooseClosestPrice(selectorPrices, item.current_price);
        }
      } catch (error) {
        selectorWorked = false;
      }
    }

    const allPrices = parsePrices(bodyText);
    const fallbackPrice = chooseClosestPrice(allPrices, item.current_price);
    const currentPrice = selectedPrice ?? fallbackPrice;

    const confidence = scorePriceConfidence(
      item,
      currentPrice,
      selectorWorked,
      selectorText,
      bodyText
    );

    const stockResult = detectStockStatus(bodyText);

    return {
      pageStatus: "active",
      currentPrice,
      priceCandidates: allPrices,
      stockStatus: stockResult.status,
      stockResult,
      productName,
      productImage,
      selectorWorked,
      selectorText,
      confidence
    };
  } catch (error) {
    return {
      pageStatus: "error",
      currentPrice: null,
      stockStatus: "unknown",
      stockResult: { status: "unknown", confidenceScore: 0, reasons: ["Request failed."], outOfStockSignalsFound: [], inStockSignalsFound: [] },
      productName: null,
      selectorWorked: false,
      selectorText: "",
      confidence: { score: 0, reasons: ["Request failed."], saleIndicators: [], dropPercent: 0 }
    };
  }
}

function buildAlerts(item, newData) {
  const alerts = [];
  const confidenceScore = newData.confidence?.score ?? 0;

  if (
    item.notify_on_price_drop &&
    item.current_price !== null &&
    newData.currentPrice !== null &&
    newData.currentPrice < item.current_price &&
    confidenceScore >= 50
  ) {
    alerts.push(`Price dropped from $${item.current_price} to $${newData.currentPrice}. Confidence: ${confidenceScore}/100.`);
  }

  if (
    item.notify_on_target_price &&
    item.target_price !== null &&
    newData.currentPrice !== null &&
    newData.currentPrice <= item.target_price &&
    confidenceScore >= 50
  ) {
    alerts.push(`Target price reached. Target: $${item.target_price}. Current: $${newData.currentPrice}. Confidence: ${confidenceScore}/100.`);
  }

  if (
    item.notify_on_back_in_stock &&
    item.stock_status !== "in_stock" &&
    newData.stockStatus === "in_stock"
  ) {
    alerts.push("Item appears to be available again.");
  }

  if (
    item.notify_on_back_in_stock &&
    item.stock_status === "out_of_stock" &&
    newData.stockStatus !== "in_stock" &&
    (newData.stockResult?.outOfStockSignalsFound?.length ?? 0) === 0
  ) {
    alerts.push("Possible availability change detected. The previous out-of-stock wording is no longer visible. Please manually check the product page.");
  }

  if (
    item.notify_on_out_of_stock &&
    item.stock_status === "in_stock" &&
    newData.stockStatus === "out_of_stock"
  ) {
    alerts.push("Item is now out of stock.");
  }

  if (
    item.notify_on_page_removed &&
    item.page_status === "active" &&
    newData.pageStatus === "not_found"
  ) {
    alerts.push("Product page appears to have been removed.");
  }

  if (
    item.notify_on_page_removed &&
    item.page_status === "active" &&
    newData.pageStatus === "error"
  ) {
    alerts.push("Product page could not be checked. The website may be blocking the tracker or may have changed.");
  }

  if (
    item.current_price !== null &&
    newData.currentPrice !== null &&
    newData.currentPrice < item.current_price &&
    confidenceScore < 50
  ) {
    alerts.push(`Possible price drop detected, but confidence was low (${confidenceScore}/100). Please manually confirm the item.`);
  }

  if (
    item.notify_on_back_in_stock &&
    newData.stockResult?.stockManualCheckRequired
  ) {
    const conflictReasons = newData.stockResult?.stockConflictReasons || [];
    const reasonText = conflictReasons.length ? `\nReason: ${conflictReasons[0]}` : "";
    alerts.push(`Manual check required: the tracker found conflicting or unclear stock availability wording. Please check the product page directly.${reasonText}`);
  }

  return alerts;
}

async function checkOneItem(item) {
  const newData = await scanProductPage(item);
  const alerts = buildAlerts(item, newData);
  const updatedProductName = newData.productName || item.product_name;
  const displayName = item.custom_name || updatedProductName || item.url;

  await dbRun(
    `
    UPDATE tracked_items
    SET
      product_name = ?,
      previous_price = current_price,
      current_price = ?,
      previous_stock_status = stock_status,
      stock_status = ?,
      last_stock_confidence_score = ?,
      last_stock_confidence_reason = ?,
      last_stock_manual_check = ?,
      previous_page_status = page_status,
      page_status = ?,
      last_confidence_score = ?,
      last_confidence_reason = ?,
      last_checked_at = CURRENT_TIMESTAMP
    WHERE id = ?
    `,
    [
      updatedProductName,
      newData.currentPrice,
      newData.stockStatus,
      newData.stockResult?.confidenceScore ?? 0,
      JSON.stringify(newData.stockResult?.reasons || []),
      newData.stockResult?.stockManualCheckRequired ? 1 : 0,
      newData.pageStatus,
      newData.confidence?.score ?? 0,
      JSON.stringify(newData.confidence?.reasons || []),
      item.id
    ]
  );

  // Only send email if alerts changed since last send.
  // This prevents repeated emails when nothing on the page has changed.
  const alertsJson = JSON.stringify(alerts);
  const lastAlertSent = item.last_alert_sent || "[]";
  const alertsChanged = alertsJson !== lastAlertSent;

  // Always persist the current alert state so the next check can compare
  await dbRun(
    "UPDATE tracked_items SET last_alert_sent = ? WHERE id = ?",
    [alerts.length > 0 ? alertsJson : "[]", item.id]
  );

  if (alerts.length > 0 && alertsChanged) {
    const subject = `Price Tracker Alert: ${displayName}`;

    const plainTextBody = `
${displayName}

Alerts:
${alerts.join("\n")}

Current price: ${newData.currentPrice !== null ? "$" + newData.currentPrice : "Unknown"}
Previous price: ${item.current_price !== null ? "$" + item.current_price : "Unknown"}
Target price: ${item.target_price !== null ? "$" + item.target_price : "None set"}
Stock status: ${formatStatus(newData.stockStatus)}
Page status: ${formatStatus(newData.pageStatus)}
Confidence: ${newData.confidence?.score ?? 0}/100

Confidence notes:
${(newData.confidence?.reasons || []).join("\n")}

Link:
${item.url}
`;

    const htmlBody = `
<div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; background: #f5f7fb; padding: 24px;">
  <div style="background: #ffffff; border-radius: 14px; padding: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.08);">
    <h2 style="margin-top: 0; color: #111827;">Price Tracker Alert</h2>
    <h3 style="color: #1f2937;">${displayName}</h3>

    <div style="background: #eff6ff; border-left: 4px solid #2563eb; padding: 12px 16px; margin: 18px 0;">
      <strong>Alert:</strong>
      <ul>${alerts.map(alert => `<li>${alert}</li>`).join("")}</ul>
    </div>

    <p><strong>Current price:</strong> ${newData.currentPrice !== null ? "$" + newData.currentPrice : "Unknown"}</p>
    <p><strong>Previous price:</strong> ${item.current_price !== null ? "$" + item.current_price : "Unknown"}</p>
    <p><strong>Target price:</strong> ${item.target_price !== null ? "$" + item.target_price : "None set"}</p>
    <p><strong>Stock status:</strong> ${formatStatus(newData.stockStatus)}</p>
    <p><strong>Page status:</strong> ${formatStatus(newData.pageStatus)}</p>
    <p><strong>Confidence:</strong> ${newData.confidence?.score ?? 0}/100</p>

    <div style="background: #f9fafb; padding: 12px 16px; border-radius: 10px;">
      <strong>Confidence notes:</strong>
      <ul>${(newData.confidence?.reasons || []).map(reason => `<li>${reason}</li>`).join("")}</ul>
    </div>

    <a href="${item.url}" style="display: inline-block; margin-top: 16px; background: #16a34a; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 10px; font-weight: bold;">
      View Product
    </a>
  </div>
</div>
`;

    await sendEmail(item.email, subject, plainTextBody, htmlBody);
  }

  return {
    id: item.id,
    url: item.url,
    alerts,
    newData
  };
}

async function getTrackedItems() {
  return await dbAll("SELECT * FROM tracked_items WHERE status = 'tracked'");
}

async function checkAllItems() {
  const items = await getTrackedItems();
  const results = [];

  for (const item of items) {
    const result = await checkOneItem(item);
    results.push(result);
  }

  return results;
}

app.get("/", (req, res) => {
  res.send("Price Tracker Backend Running");
});

app.post("/track", async (req, res) => {
  const {
    url,
    store,
    productName,
    productImage,
    currentPrice,
    targetPrice,
    email,
    stockStatus,
    pageStatus,
    priceSelector,
    priceContextText,
    notifyOnPriceDrop,
    notifyOnTargetPrice,
    notifyOnBackInStock,
    notifyOnOutOfStock,
    notifyOnPageRemoved
  } = req.body;

  // Accept several possible field names so popup and import form can't get out of sync
  const customName = (
    req.body.customName ??
    req.body.custom_name ??
    req.body.customDisplayName ??
    req.body.displayName ??
    null
  );
  const customNameTrimmed = customName?.trim() || null;

  console.log(`[POST /track] url=${url?.slice(0, 60)} | customName=${customNameTrimmed} | productName=${productName?.slice(0, 40)}`);

  if (!url || !email) {
    return res.status(400).json({
      success: false,
      message: "URL and email are required."
    });
  }

  try {
    const existingItem = await dbGet(
      "SELECT * FROM tracked_items WHERE url = ? AND email = ?",
      [url, email]
    );

    if (existingItem) {
      await dbRun(
        `
        UPDATE tracked_items
        SET
          store = ?,
          product_name = ?,
          product_image = ?,
          custom_name = ?,
          previous_price = current_price,
          current_price = ?,
          target_price = ?,
          previous_stock_status = stock_status,
          stock_status = ?,
          previous_page_status = page_status,
          page_status = ?,
          price_selector = ?,
          price_context_text = ?,
          notify_on_price_drop = ?,
          notify_on_target_price = ?,
          notify_on_back_in_stock = ?,
          notify_on_out_of_stock = ?,
          notify_on_page_removed = ?,
          status = 'tracked',
          last_checked_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [
          store || existingItem.store,
          productName || existingItem.product_name,
          productImage || existingItem.product_image,
          customNameTrimmed !== null ? customNameTrimmed : (existingItem.custom_name || null),
          currentPrice ?? existingItem.current_price,
          targetPrice ?? existingItem.target_price,
          stockStatus || existingItem.stock_status,
          pageStatus || existingItem.page_status,
          priceSelector || existingItem.price_selector,
          priceContextText || existingItem.price_context_text,
          notifyOnPriceDrop ?? existingItem.notify_on_price_drop,
          notifyOnTargetPrice ?? existingItem.notify_on_target_price,
          notifyOnBackInStock ?? existingItem.notify_on_back_in_stock,
          notifyOnOutOfStock ?? existingItem.notify_on_out_of_stock,
          notifyOnPageRemoved ?? existingItem.notify_on_page_removed,
          existingItem.id
        ]
      );

      return res.json({
        success: true,
        message: "Existing tracked item updated.",
        itemId: existingItem.id
      });
    }

    let insertedId = null;

    if (DATABASE_TYPE === "postgres") {
      const result = await dbRun(
        `
        INSERT INTO tracked_items
        (
          url,
          store,
          product_name,
          product_image,
          custom_name,
          current_price,
          previous_price,
          target_price,
          email,
          stock_status,
          previous_stock_status,
          page_status,
          previous_page_status,
          price_selector,
          price_context_text,
          notify_on_price_drop,
          notify_on_target_price,
          notify_on_back_in_stock,
          notify_on_out_of_stock,
          notify_on_page_removed
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
        `,
        [
          url,
          store || null,
          productName || null,
          productImage || null,
          customNameTrimmed,
          currentPrice ?? null,
          null,
          targetPrice ?? null,
          email,
          stockStatus || "unknown",
          "unknown",
          pageStatus || "active",
          "unknown",
          priceSelector || null,
          priceContextText || null,
          notifyOnPriceDrop ?? 1,
          notifyOnTargetPrice ?? 0,
          notifyOnBackInStock ?? 1,
          notifyOnOutOfStock ?? 1,
          notifyOnPageRemoved ?? 1
        ]
      );

      insertedId = result.rows?.[0]?.id ?? null;
    } else {
      const result = await dbRun(
        `
        INSERT INTO tracked_items
        (
          url,
          store,
          product_name,
          product_image,
          custom_name,
          current_price,
          previous_price,
          target_price,
          email,
          stock_status,
          previous_stock_status,
          page_status,
          previous_page_status,
          price_selector,
          price_context_text,
          notify_on_price_drop,
          notify_on_target_price,
          notify_on_back_in_stock,
          notify_on_out_of_stock,
          notify_on_page_removed
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          url,
          store || null,
          productName || null,
          productImage || null,
          customNameTrimmed,
          currentPrice ?? null,
          null,
          targetPrice ?? null,
          email,
          stockStatus || "unknown",
          "unknown",
          pageStatus || "active",
          "unknown",
          priceSelector || null,
          priceContextText || null,
          notifyOnPriceDrop ?? 1,
          notifyOnTargetPrice ?? 0,
          notifyOnBackInStock ?? 1,
          notifyOnOutOfStock ?? 1,
          notifyOnPageRemoved ?? 1
        ]
      );

      insertedId = result.lastID ?? null;
    }

    return res.json({
      success: true,
      message: "Item saved for tracking.",
      itemId: insertedId
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to save tracked item.",
      error: error.message
    });
  }
});

app.delete("/items/:id", async (req, res) => {
  try {
    await dbRun("DELETE FROM tracked_items WHERE id = ?", [req.params.id]);

    res.json({
      success: true,
      message: "Item deleted.",
      deletedId: req.params.id
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete item.",
      error: error.message
    });
  }
});

app.get("/items", async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM tracked_items ORDER BY display_order ASC, created_at DESC");
    if (rows.length > 0) {
      const s = rows[0];
      console.log(`[GET /items] ${rows.length} items. First: id=${s.id} | product_name=${String(s.product_name || "").slice(0, 40)} | custom_name=${s.custom_name}`);
    }
    res.json(rows);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load tracked items.",
      error: error.message
    });
  }
});

app.post("/scan-url", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, message: "url is required." });
  }

  console.log(`[scan-url] Scanning: ${url}`);

  try {
    const tempItem = {
      url,
      current_price: null,
      target_price: null,
      price_selector: null,
      price_context_text: null
    };

    const result = await scanProductPage(tempItem);

    console.log(`[scan-url] Done — pageStatus=${result.pageStatus} price=${result.currentPrice} stock=${result.stockStatus}`);

    if (result.pageStatus === "not_found") {
      return res.status(200).json({
        success: false,
        message: "Page not found (404). Check that the URL is correct and the product page still exists."
      });
    }

    if (result.pageStatus === "error") {
      return res.status(200).json({
        success: false,
        message: "The website returned an error. It may be blocking automated requests, or the URL may be invalid."
      });
    }

    res.json({
      success: true,
      url,
      productName: result.productName,
      productImage: result.productImage || null,
      currentPrice: result.currentPrice,
      priceCandidates: result.priceCandidates || [],
      stockStatus: result.stockStatus,
      stockConfidenceScore: result.stockResult?.confidenceScore ?? 0,
      stockConfidenceReason: (result.stockResult?.reasons || []).join(" "),
      stockManualCheckRequired: result.stockResult?.stockManualCheckRequired ?? false,
      pageStatus: result.pageStatus,
      priceSelector: result.selectorWorked ? result.selectorText : null,
      priceContextText: result.selectorText || null
    });
  } catch (error) {
    console.error(`[scan-url] Error scanning ${url}:`, error.message);
    res.status(500).json({
      success: false,
      message: `Scan failed: ${error.message}`
    });
  }
});

app.post("/items/reorder", async (req, res) => {
  const { orderedIds } = req.body;

  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ success: false, message: "orderedIds must be an array." });
  }

  try {
    for (let i = 0; i < orderedIds.length; i++) {
      await dbRun("UPDATE tracked_items SET display_order = ? WHERE id = ?", [i, orderedIds[i]]);
    }
    res.json({ success: true, message: "Order saved." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to save order.", error: error.message });
  }
});

app.post("/test-email/:id", async (req, res) => {
  try {
    const item = await dbGet("SELECT * FROM tracked_items WHERE id = ?", [req.params.id]);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Tracked item not found."
      });
    }

    const testDisplayName = item.custom_name || item.product_name || item.url;

    const subject = `Test Price Tracker Alert: ${testDisplayName}`;

    const plainTextBody = `
TEST ALERT

${testDisplayName}

This is a test email to confirm your alert layout is working.

Current price: ${item.current_price !== null ? "$" + item.current_price : "Unknown"}
Target price: ${item.target_price !== null ? "$" + item.target_price : "None set"}
Stock status: ${formatStatus(item.stock_status)}
Page status: ${formatStatus(item.page_status)}

Link:
${item.url}
`;

    const htmlBody = `
<div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; background: #f5f7fb; padding: 24px;">
  <div style="background: #ffffff; border-radius: 14px; padding: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.08);">
    <h2 style="margin-top: 0; color: #111827;">Test Price Tracker Alert</h2>
    <h3 style="color: #1f2937;">${testDisplayName}</h3>

    <div style="background: #ecfdf5; border-left: 4px solid #16a34a; padding: 12px 16px; margin: 18px 0;">
      <strong>This is a test email.</strong>
      <p style="margin-bottom: 0;">Your email alert layout is working.</p>
    </div>

    <p><strong>Current price:</strong> ${item.current_price !== null ? "$" + item.current_price : "Unknown"}</p>
    <p><strong>Target price:</strong> ${item.target_price !== null ? "$" + item.target_price : "None set"}</p>
    <p><strong>Stock status:</strong> ${formatStatus(item.stock_status)}</p>
    <p><strong>Page status:</strong> ${formatStatus(item.page_status)}</p>

    <a href="${item.url}" style="display: inline-block; margin-top: 16px; background: #16a34a; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 10px; font-weight: bold;">
      View Product
    </a>
  </div>
</div>
`;

    await sendEmail(item.email, subject, plainTextBody, htmlBody);

    res.json({
      success: true,
      message: "Test email sent."
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to send test email.",
      error: error.message
    });
  }
});

app.post("/check-now", async (req, res) => {
  try {
    const results = await checkAllItems();

    res.json({
      success: true,
      message: "Check complete.",
      results
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Check failed.",
      error: error.message
    });
  }
});

cron.schedule("0 */2 * * *", async () => {
  console.log("Running scheduled price check...");
  await checkAllItems();
  console.log("Scheduled price check complete.");
});

async function startServer() {
  try {
    await initialiseDatabase();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();