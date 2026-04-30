
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
  db = new sqlite3.Database("./price-tracker.db");
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

        stock_status TEXT DEFAULT 'unknown',
        previous_stock_status TEXT DEFAULT 'unknown',

        page_status TEXT DEFAULT 'unknown',
        previous_page_status TEXT DEFAULT 'unknown',

        notify_on_price_drop INTEGER DEFAULT 1,
        notify_on_target_price INTEGER DEFAULT 0,
        notify_on_back_in_stock INTEGER DEFAULT 1,
        notify_on_out_of_stock INTEGER DEFAULT 1,
        notify_on_page_removed INTEGER DEFAULT 1,

        status TEXT DEFAULT 'tracked',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_checked_at TIMESTAMP
      )
    `);

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

      stock_status TEXT DEFAULT 'unknown',
      previous_stock_status TEXT DEFAULT 'unknown',

      page_status TEXT DEFAULT 'unknown',
      previous_page_status TEXT DEFAULT 'unknown',

      notify_on_price_drop INTEGER DEFAULT 1,
      notify_on_target_price INTEGER DEFAULT 0,
      notify_on_back_in_stock INTEGER DEFAULT 1,
      notify_on_out_of_stock INTEGER DEFAULT 1,
      notify_on_page_removed INTEGER DEFAULT 1,

      status TEXT DEFAULT 'tracked',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_checked_at TEXT
    )
  `);
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

  const outOfStockSignals = [
    "out of stock",
    "sold out",
    "currently unavailable",
    "notify me when available",
    "notify when available",
    "email me when available",
    "back in stock notification",
    "temporarily unavailable",
    "not available",
    "no longer available",
    "currently out of stock",
    "this item is unavailable",
    "cannot be added to cart",
    "sold-out"
  ];

  const inStockSignals = [
    "ready to ship",
    "in stock",
    "add to cart",
    "add to basket",
    "buy now",
    "available now",
    "available for delivery",
    "available online",
    "ships today",
    "ships now",
    "dispatches today",
    "dispatches within",
    "left in stock",
    "low stock",
    "limited stock"
  ];

  const preorderSignals = [
    "pre-order",
    "preorder",
    "pre order",
    "available for pre-order",
    "available for preorder"
  ];

  let outScore = 0;
  let inScore = 0;
  let preorderScore = 0;

  outOfStockSignals.forEach((signal) => {
    if (lower.includes(signal)) outScore += 2;
  });

  inStockSignals.forEach((signal) => {
    if (lower.includes(signal)) inScore += 2;
  });

  preorderSignals.forEach((signal) => {
    if (lower.includes(signal)) preorderScore += 2;
  });

  if (/only\s+\d+\s+left/.test(lower)) inScore += 4;
  if (/\d+\s+left\s+in\s+stock/.test(lower)) inScore += 4;
  if (/add\s+to\s+cart/.test(lower)) inScore += 3;
  if (/notify\s+me\s+when\s+(available|back\s+in\s+stock)/.test(lower)) outScore += 4;
  if (/out\s+of\s+stock/.test(lower)) outScore += 5;

  if (preorderScore > outScore && preorderScore >= inScore) {
    return "preorder";
  }

  if (outScore > inScore) {
    return "out_of_stock";
  }

  if (inScore > outScore) {
    return "in_stock";
  }

  return "unknown";
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

    return {
      pageStatus: "active",
      currentPrice,
      stockStatus: detectStockStatus(bodyText),
      productName,
      selectorWorked,
      selectorText,
      confidence
    };
  } catch (error) {
    return {
      pageStatus: "error",
      currentPrice: null,
      stockStatus: "unknown",
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
    alerts.push("Item is back in stock.");
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

  return alerts;
}

async function checkOneItem(item) {
  const newData = await scanProductPage(item);
  const alerts = buildAlerts(item, newData);
  const updatedProductName = newData.productName || item.product_name;

  await dbRun(
    `
    UPDATE tracked_items
    SET
      product_name = ?,
      previous_price = current_price,
      current_price = ?,
      previous_stock_status = stock_status,
      stock_status = ?,
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
      newData.pageStatus,
      newData.confidence?.score ?? 0,
      JSON.stringify(newData.confidence?.reasons || []),
      item.id
    ]
  );

  if (alerts.length > 0) {
    const subject = `Price Tracker Alert: ${updatedProductName || item.url}`;

    const plainTextBody = `
${updatedProductName || "Tracked item"}

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
    <h3 style="color: #1f2937;">${updatedProductName || "Tracked item"}</h3>

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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
        `,
        [
          url,
          store || null,
          productName || null,
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          url,
          store || null,
          productName || null,
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
    const rows = await dbAll("SELECT * FROM tracked_items ORDER BY created_at DESC");
    res.json(rows);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load tracked items.",
      error: error.message
    });
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

    const subject = `Test Price Tracker Alert: ${item.product_name || item.url}`;

    const plainTextBody = `
TEST ALERT

${item.product_name || "Tracked item"}

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
    <h3 style="color: #1f2937;">${item.product_name || "Tracked item"}</h3>

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