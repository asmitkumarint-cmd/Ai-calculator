"use client";

import { useMemo, useRef, useState } from "react";

import Papa from "papaparse";
import * as XLSX from "xlsx";

import {
  getMissingRequiredFields,
  hasMenuInputContent,
  mapCsvMenuRow,
  sanitizeRid,
  validateMenuItems,
} from "@/lib/menu-input-schema";
import { formatKcalDisplay, formatProteinDisplay } from "@/lib/nutrition-display";

import DropZone from "./drop-zone";
import ErrorDrawer from "./error-drawer";
import ProgressBar from "./progress-bar";
import QueueTable from "./queue-table";
import ResultsTable from "./results-table";
import styles from "./bulk.module.css";

const IMPORT_LIMIT = 1000;
const CHUNK_SIZE = 25;

class BulkEstimateError extends Error {
  constructor({ message, status, rawBody, details, parseError, retryable = true }) {
    super(message);
    this.name = "BulkEstimateError";
    this.status = status;
    this.rawBody = rawBody;
    this.details = details;
    this.parseError = parseError;
    this.retryable = retryable;
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function resultKey(row) {
  return row.result_key || row.rowId || row.row_id;
}

function getRowLabelRange(chunk, allRows) {
  const indices = chunk
    .map((row) => allRows.findIndex((candidate) => candidate.rowId === row.rowId))
    .filter((index) => index >= 0)
    .map((index) => index + 1);

  if (!indices.length) {
    return "selected rows";
  }

  return `rows ${Math.min(...indices)}-${Math.max(...indices)}`;
}

function buildResultsCsv(results = []) {
  const headers = [
    "RID",
    "ITEM_NAME",
    "ITEM_PRICE",
    "ITEM_GRAMMAGE",
    "CALORIES_DISPLAY",
    "ESTIMATED_ENERGY_KCAL",
    "PROTEIN_DISPLAY",
    "ESTIMATED_PROTEIN_G",
    "STATUS",
    "CONFIDENCE_BAND",
    "CONFIDENCE_PERCENT",
    "ERROR_MESSAGE",
    "REASONING",
  ];

  const lines = results.map((row) => [
    row.row_id,
    row.input_name,
    row.input_item_price,
    row.input_item_grammage,
    row.estimation_status === "failed" ? "" : formatKcalDisplay(row.estimated_energy_kcal, row.confidence_band),
    row.estimated_energy_kcal,
    row.estimation_status === "failed" ? "" : formatProteinDisplay(row.estimated_protein_g),
    row.estimated_protein_g,
    row.estimation_status === "failed" ? "Failed" : "Done",
    row.confidence_band,
    row.confidence_score,
    row.error_message || "",
    row.reasoning_trace || row.rationale || "",
  ]);

  return [headers, ...lines].map((line) => line.map(csvEscape).join(",")).join("\n");
}

function summarizeResults(results = []) {
  const successful = results.filter((row) => row.estimation_status !== "failed");
  const estimated = successful.filter((row) => row.estimated_energy_kcal != null || row.estimated_protein_g != null);
  const failed = results.filter((row) => row.estimation_status === "failed");
  const needsReview = successful.filter(
    (row) => row.estimated_energy_kcal == null || row.confidence_band !== "High"
  );
  const withCalories = estimated.filter((row) => Number.isFinite(Number(row.estimated_energy_kcal)));
  const averageCalories = withCalories.length
    ? Math.round(withCalories.reduce((sum, row) => sum + Number(row.estimated_energy_kcal), 0) / withCalories.length)
    : 0;

  return {
    estimated: estimated.length,
    failed: failed.length,
    needsReview: needsReview.length,
    averageCalories,
  };
}

async function postChunk(items) {
  const response = await fetch("/api/estimate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const contentType = response.headers.get("content-type") || "";
  const rawText = await response.text();

  let payload = null;
  let parseError = null;
  if (contentType.includes("application/json")) {
    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      parseError = error;
    }
  }

  if (!payload) {
    throw new BulkEstimateError({
      message: "The server returned an unexpected response. Please retry.",
      status: response.status,
      rawBody: rawText.slice(0, 2000),
      parseError: parseError?.message || null,
    });
  }

  if (!response.ok) {
    throw new BulkEstimateError({
      message: payload.error || "The estimate request failed.",
      status: response.status,
      details: payload.details || null,
      rawBody: payload.detail || payload.rawBody || null,
      retryable: payload.retryable ?? false,
    });
  }

  return payload;
}

function normalizeDecimalInput(value, previousValue) {
  if (value === "") {
    return "";
  }
  if (value.startsWith("-")) {
    return previousValue || "";
  }
  return /^\d*\.?\d*$/.test(value) ? value : previousValue || "";
}

export default function BulkUploader() {
  const stepTwoRef = useRef(null);
  const [queue, setQueue] = useState([]);
  const [rowStates, setRowStates] = useState({});
  const [results, setResults] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const [importBanner, setImportBanner] = useState("");
  const [toast, setToast] = useState("");
  const [errorDrawer, setErrorDrawer] = useState(null);
  const [progress, setProgress] = useState(null);
  const [running, setRunning] = useState(false);
  const [retryCounts, setRetryCounts] = useState({});

  const readyCount = useMemo(() => queue.filter((row) => getMissingRequiredFields(row).length === 0).length, [queue]);
  const needsInputCount = queue.length - readyCount;
  const metrics = useMemo(() => summarizeResults(results?.results || []), [results]);

  function resetRunState() {
    setResults(null);
    setProgress(null);
    setRowStates({});
    setRetryCounts({});
  }

  function applyParsedRows(rows, source) {
    const normalizedRows = rows.map(mapCsvMenuRow).filter(hasMenuInputContent);
    if (!normalizedRows.length) {
      setToast("The uploaded file did not contain readable menu rows.");
      return;
    }

    const limitedRows = normalizedRows.slice(0, IMPORT_LIMIT);
    setQueue(limitedRows);
    setFileInfo({
      name: source.name,
      size: source.size || new Blob([source.rawText || ""]).size,
      rowCount: limitedRows.length,
    });
    setImportBanner(
      normalizedRows.length > IMPORT_LIMIT
        ? `Only the first ${IMPORT_LIMIT} of ${normalizedRows.length} rows were imported. Split the file to process the rest.`
        : ""
    );
    resetRunState();
    setToast("");
    window.requestAnimationFrame(() => stepTwoRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function handleFile(file) {
    try {
      const lowerName = file.name.toLowerCase();
      let rows = [];

      if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: "array" });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
      } else {
        const text = await file.text();
        const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
        if (parsed.errors.length) {
          throw new Error(parsed.errors[0].message);
        }
        rows = parsed.data;
      }

      applyParsedRows(rows, file);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to parse the uploaded file.");
    }
  }

  function handlePasteCsv(text) {
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    if (parsed.errors.length) {
      setToast(parsed.errors[0].message);
      return;
    }

    applyParsedRows(parsed.data, { name: "Pasted CSV", rawText: text });
  }

  function editRow(rowId, field, value) {
    setQueue((current) =>
      current.map((row) => {
        if (row.rowId !== rowId) {
          return row;
        }

        let nextValue = value;
        if (field === "rid") {
          nextValue = sanitizeRid(value);
        }
        if (field === "price" || field === "grammage") {
          nextValue = normalizeDecimalInput(value, row[field]);
        }

        return { ...row, [field]: nextValue };
      })
    );
    setRowStates((current) => ({ ...current, [rowId]: undefined }));
  }

  function removeRow(rowId) {
    setQueue((current) => current.filter((row) => row.rowId !== rowId));
    setResults((current) =>
      current
        ? { ...current, results: current.results.filter((row) => resultKey(row) !== rowId) }
        : current
    );
  }

  function mergeResults(payload, fallbackItems = []) {
    const incoming = payload.results || [];
    setResults((current) => {
      const base = current || {
        generatedAt: payload.generatedAt || new Date().toISOString(),
        estimator: payload.estimator || null,
        summary: payload.summary || {},
        results: [],
      };
      const merged = new Map(base.results.map((row) => [resultKey(row), row]));
      for (const row of incoming) {
        merged.set(resultKey(row), row);
      }
      for (const row of fallbackItems) {
        merged.set(resultKey(row), row);
      }
      const mergedResults = Array.from(merged.values());
      return {
        ...base,
        generatedAt: payload.generatedAt || base.generatedAt,
        estimator: payload.estimator || base.estimator,
        summary: { ...(payload.summary || {}), ...summarizeResults(mergedResults) },
        results: mergedResults,
      };
    });

    setRowStates((current) => {
      const next = { ...current };
      for (const row of incoming) {
        next[resultKey(row)] =
          row.estimation_status === "failed"
            ? { status: "failed", error: row.error_message || "Estimate failed." }
            : { status: "done" };
      }
      for (const row of fallbackItems) {
        next[resultKey(row)] = { status: "failed", error: row.error_message };
      }
      return next;
    });
  }

  async function runRows(rowsToRun, { retry = false } = {}) {
    const { normalizedItems, errors } = validateMenuItems(rowsToRun);
    if (errors.length) {
      const message = errors[0]?.message || "Some rows still need required fields.";
      setToast(message);
      setErrorDrawer({ message, status: 400, details: errors, rawBody: JSON.stringify(errors, null, 2) });
      return;
    }

    setRunning(true);
    setToast("");
    if (!retry) {
      setResults(null);
      setRowStates({});
    }

    const chunks = [];
    for (let index = 0; index < normalizedItems.length; index += CHUNK_SIZE) {
      chunks.push(normalizedItems.slice(index, index + CHUNK_SIZE));
    }

    setProgress({ total: normalizedItems.length, completed: 0, failed: 0 });

    for (const chunk of chunks) {
      const chunkLabel = getRowLabelRange(chunk, queue);
      setRowStates((current) => {
        const next = { ...current };
        for (const row of chunk) {
          next[row.rowId] = { status: "running" };
        }
        return next;
      });

      try {
        const payload = await postChunk(chunk);
        const failedRows = (payload.results || []).filter((row) => row.estimation_status === "failed").length;
        const completedRows = chunk.length - failedRows;
        mergeResults(payload);
        setProgress((current) => ({
          total: current?.total || normalizedItems.length,
          completed: (current?.completed || 0) + completedRows,
          failed: (current?.failed || 0) + failedRows,
        }));
      } catch (error) {
        const message =
          error instanceof BulkEstimateError
            ? error.message
            : error instanceof Error
              ? error.message
              : "The estimate request failed.";
        const failedRows = chunk.map((item) => ({
          row_id: item.rid,
          result_key: item.rowId,
          input_name: item.name,
          input_item_price: item.price,
          input_item_grammage: item.grammage,
          estimation_status: "failed",
          error_code: "request_error",
          error_message: message,
          retryable: true,
        }));
        mergeResults({ results: [] }, failedRows);
        setProgress((current) => ({
          total: current?.total || normalizedItems.length,
          completed: current?.completed || 0,
          failed: (current?.failed || 0) + chunk.length,
        }));
        setToast(`The server hit a hiccup on ${chunkLabel}. Click Retry to try again.`);
        setErrorDrawer({
          message,
          status: error.status,
          rawBody: error.rawBody,
          details: error.details,
          parseError: error.parseError,
        });
      }
    }

    setRunning(false);
  }

  function runEstimate() {
    runRows(queue);
  }

  async function retryRows(rowIds) {
    const blocked = rowIds.find((rowId) => (retryCounts[rowId] || 0) >= 3);
    if (blocked) {
      const state = rowStates[blocked];
      setErrorDrawer({
        message: state?.error || "This row has already been retried three times.",
        status: 500,
        rawBody: state?.error || "",
      });
      return;
    }

    setRetryCounts((current) => {
      const next = { ...current };
      for (const rowId of rowIds) {
        next[rowId] = (next[rowId] || 0) + 1;
      }
      return next;
    });

    const rows = queue.filter((row) => rowIds.includes(row.rowId));
    await runRows(rows, { retry: true });
  }

  function retryFailedRows() {
    const failedIds = Object.entries(rowStates)
      .filter(([, state]) => state?.status === "failed")
      .map(([rowId]) => rowId);
    retryRows(failedIds);
  }

  function downloadCsv() {
    if (!results?.results?.length) {
      return;
    }

    const blob = new Blob([`${buildResultsCsv(results.results)}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `rx-menu-nutrition-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadXlsx() {
    if (!results?.results?.length) {
      return;
    }

    const response = await fetch("/api/estimate/export/xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(results),
    });
    if (!response.ok) {
      setToast("Failed to export XLSX.");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `rx-menu-nutrition-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const hasFailedRows = Object.values(rowStates).some((state) => state?.status === "failed");
  const runDisabled = running || !queue.length || needsInputCount > 0;

  return (
    <section className={styles.bulkFlow}>
      {toast ? (
        <div className={styles.toast}>
          <span>{toast}</span>
          {errorDrawer ? (
            <button className={styles.textButton} type="button" onClick={() => setErrorDrawer(errorDrawer)}>
              Details
            </button>
          ) : null}
        </div>
      ) : null}

      <section className={styles.stepSection} aria-labelledby="bulk-upload-heading">
        <div className={styles.sectionTitle}>
          <span className={styles.stepLabel}>Step 1</span>
          <h1 id="bulk-upload-heading">Upload menu</h1>
          <p>Use the template columns or upload your own CSV/XLSX with one menu item per row.</p>
        </div>
        <DropZone
          fileInfo={fileInfo}
          onFile={handleFile}
          onPasteCsv={handlePasteCsv}
          onError={(message) => setToast(message)}
        />
        <p className={styles.requiredNote}>Required inside the file: RID, ITEM_NAME, ITEM_PRICE.</p>
      </section>

      {queue.length ? (
        <section ref={stepTwoRef} className={styles.stepSection} aria-labelledby="bulk-review-heading">
          <div className={styles.sectionTitle}>
            <span className={styles.stepLabel}>Step 2</span>
            <h2 id="bulk-review-heading">Review and edit rows</h2>
          </div>

          {importBanner ? <div className={styles.banner}>{importBanner}</div> : null}
          <ProgressBar progress={progress} />

          <div className={styles.queueToolbar}>
            <div className={styles.queueStatus}>
              {queue.length} rows • {readyCount} ready • {needsInputCount} need input
            </div>
            <div className={styles.toolbarActions}>
              {hasFailedRows ? (
                <button className={styles.outlineButton} type="button" onClick={retryFailedRows} disabled={running}>
                  Retry failed rows
                </button>
              ) : null}
              <button
                className={styles.primaryButton}
                type="button"
                onClick={runEstimate}
                disabled={runDisabled}
                title={needsInputCount > 0 ? "Complete RID, Item name, and Price before running." : ""}
              >
                {running ? "Running..." : "Run estimate"}
              </button>
            </div>
          </div>

          <QueueTable
            rows={queue}
            rowStates={rowStates}
            onEdit={editRow}
            onRemove={removeRow}
            onRetry={retryRows}
            retryCounts={retryCounts}
          />

          <div className={styles.stickyRunBar}>
            <span>{queue.length} rows • {needsInputCount} need input</span>
            <button className={styles.primaryButton} type="button" onClick={runEstimate} disabled={runDisabled}>
              {running ? "Running..." : "Run estimate"}
            </button>
          </div>
        </section>
      ) : null}

      {results?.results?.length ? (
        <ResultsTable
          results={results.results}
          metrics={metrics}
          onExportCsv={downloadCsv}
          onExportXlsx={downloadXlsx}
          onRetry={retryRows}
          retryCounts={retryCounts}
        />
      ) : null}

      <ErrorDrawer error={errorDrawer} onClose={() => setErrorDrawer(null)} />
    </section>
  );
}
