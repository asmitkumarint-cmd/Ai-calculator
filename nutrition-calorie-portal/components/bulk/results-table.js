"use client";

import { Fragment, useState } from "react";

import { formatKcalDisplay, formatProteinDisplay } from "@/lib/nutrition-display";

import styles from "./bulk.module.css";

function list(values, fallback = "None") {
  return values?.length ? values.join(", ") : fallback;
}

function confidenceClass(band) {
  if (band === "High") return styles.badgeHigh;
  if (band === "Medium") return styles.badgeMedium;
  return styles.badgeLow;
}

function resultStatus(row) {
  if (row.estimation_status === "failed") {
    return "Failed";
  }
  if (row.estimated_energy_kcal == null && row.estimated_protein_g == null) {
    return "Needs review";
  }
  return "Done";
}

function DetailPanel({ row }) {
  const explainability = row.explainability || {};
  const inputs = explainability.inputs || {};
  const checkedSignals = inputs.signals_checked_by_genai?.length
    ? inputs.signals_checked_by_genai
    : inputs.signals_checked_by_v1;
  const helpedSignals = inputs.signals_that_helped_this_match || [];
  const neighbors = explainability.retrieval?.neighbors?.map((neighbor) => neighbor.ITEM_NAME).filter(Boolean);
  const active = explainability.retrieval?.active_menu_context?.map((candidate) => candidate.display_name).filter(Boolean);
  const icmr = explainability.retrieval?.icmr_matches?.map((match) => match.name).filter(Boolean);

  if (row.estimation_status === "failed") {
    return (
      <div className={styles.resultDetail}>
        <div>
          <strong>Error</strong>
          <p>{row.error_message || "This row failed before an estimate was produced."}</p>
        </div>
        <div>
          <strong>Retryable</strong>
          <p>{row.retryable ? "Yes" : "No"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.resultDetail}>
      <div>
        <strong>Reasoning</strong>
        <p>{row.reasoning_trace || row.rationale || "Not available"}</p>
        <strong>Signals checked</strong>
        <p>{list(checkedSignals, "ITEM_NAME")}</p>
        <strong>Signals that helped</strong>
        <p>{list(helpedSignals, "ITEM_NAME")}</p>
      </div>
      <div>
        <strong>Labeled references</strong>
        <p>{list(neighbors)}</p>
        <strong>Active menu context</strong>
        <p>{list(active)}</p>
        <strong>ICMR matches</strong>
        <p>{list(icmr)}</p>
        <strong>Price note</strong>
        <p>{explainability.price_signal?.note || "Price did not materially affect the estimate."}</p>
      </div>
    </div>
  );
}

export default function ResultsTable({ results, metrics, onExportCsv, onExportXlsx, onRetry, retryCounts }) {
  const [expanded, setExpanded] = useState(new Set());

  function toggle(key) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <section className={styles.stepSection} aria-labelledby="bulk-results-heading">
      <div className={styles.sectionTitle}>
        <span className={styles.stepLabel}>Step 3</span>
        <h2 id="bulk-results-heading">Results</h2>
      </div>

      <div className={styles.resultsToolbar}>
        <div className={styles.metricStrip}>
          <span><strong>{metrics.estimated}</strong> Estimated</span>
          <span><strong>{metrics.needsReview}</strong> Needs review</span>
          <span><strong>{metrics.averageCalories || "NA"}</strong> Avg calories</span>
          <span><strong>{metrics.failed}</strong> Failed</span>
        </div>
        <div className={styles.toolbarActions}>
          <button className={styles.outlineButton} type="button" onClick={onExportCsv}>
            Export CSV
          </button>
          <button className={styles.outlineButton} type="button" onClick={onExportXlsx}>
            Export XLSX
          </button>
        </div>
      </div>

      <div className={styles.tableShell}>
        <table className={styles.bulkTable}>
          <thead>
            <tr>
              <th />
              <th>Dish</th>
              <th>Calories</th>
              <th>Protein</th>
              <th>Confidence band</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {results.map((row, index) => {
              const key = row.result_key || `${row.row_id}-${index}`;
              const open = expanded.has(key);
              const failed = row.estimation_status === "failed";

              return (
                <Fragment key={key}>
                  <tr>
                    <td data-label="">
                      <button className={styles.chevronButton} type="button" onClick={() => toggle(key)}>
                        {open ? "v" : "▸"}
                      </button>
                    </td>
                    <td data-label="Dish">
                      <strong>{row.input_name || "Unnamed row"}</strong>
                      <span className={styles.mutedLine}>RID {row.row_id || "NA"}</span>
                    </td>
                    <td data-label="Calories" className={styles.monoCell}>
                      {failed ? "Not available" : formatKcalDisplay(row.estimated_energy_kcal, row.confidence_band)}
                    </td>
                    <td data-label="Protein" className={styles.monoCell}>
                      {failed ? "Not available" : formatProteinDisplay(row.estimated_protein_g)}
                    </td>
                    <td data-label="Confidence band">
                      {failed ? (
                        <span className={`${styles.badge} ${styles.badgeFailed}`}>Failed</span>
                      ) : (
                        <span className={`${styles.badge} ${confidenceClass(row.confidence_band)}`}>
                          {row.confidence_band || "Low"}
                        </span>
                      )}
                    </td>
                    <td data-label="Status">
                      <div className={styles.statusInline}>
                        <span className={`${styles.badge} ${failed ? styles.badgeFailed : styles.badgeReady}`}>
                          {resultStatus(row)}
                        </span>
                        {failed && row.retryable ? (
                          <button className={styles.textButton} type="button" onClick={() => onRetry([row.result_key])}>
                            {(retryCounts[row.result_key] || 0) >= 3 ? "Open details" : "Retry"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {open ? (
                    <tr className={styles.detailRow}>
                      <td colSpan={6}>
                        <DetailPanel row={row} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
