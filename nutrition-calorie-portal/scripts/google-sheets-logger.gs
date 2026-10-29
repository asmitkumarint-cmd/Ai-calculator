const SPREADSHEET_ID = "1gh4M3xOvQp8uQhjIXlSYx3qr6uTXGxSF0-waFHdGeOY";
const SHEET_TAB_NAME = "Submissions";
const LOG_COLUMNS = [
  "submitted_at",
  "rid",
  "item_name",
  "item_price",
  "item_grammage",
  "item_description",
  "cuisine",
  "preparation_style",
  "ingredients_json",
  "estimated_protein_g",
  "estimated_energy_kcal",
  "confidence_percent",
  "confidence_band",
  "estimator",
  "reasoning_trace",
];

function doPost(event) {
  try {
    const properties = PropertiesService.getScriptProperties();
    const expectedToken = properties.getProperty("LOG_WEBHOOK_TOKEN");
    const body = JSON.parse(event?.postData?.contents || "{}");

    if (!expectedToken || body.token !== expectedToken) {
      return jsonResponse({ ok: false, error: "Unauthorized logging request." });
    }

    const record = body.record || {};
    if (!record.rid || !record.item_name || !record.item_price) {
      return jsonResponse({ ok: false, error: "RID, item name, and item price are required." });
    }
    const confidence = Number(record.confidence_percent);
    if (!Number.isFinite(confidence) || confidence < 70) {
      return jsonResponse({ ok: false, error: "Only estimates at 70% confidence or above can be logged." });
    }

    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName(SHEET_TAB_NAME) || spreadsheet.insertSheet(SHEET_TAB_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(LOG_COLUMNS);
      sheet.setFrozenRows(1);
    }

    const values = {
      ...record,
      ingredients_json: JSON.stringify(Array.isArray(record.ingredients) ? record.ingredients : []),
    };
    sheet.appendRow(LOG_COLUMNS.map((column) => safeCell(values[column])));
    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ ok: false, error: "Could not append the entry to the spreadsheet." });
  }
}

function safeCell(value) {
  if (value == null) return "";
  if (typeof value === "string" && /^[=+\-@]/.test(value)) return `'${value}`;
  return value;
}

function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
