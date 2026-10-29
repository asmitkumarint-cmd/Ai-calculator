"use client";

import { useEffect } from "react";

import styles from "./bulk.module.css";

export default function ErrorDrawer({ error, onClose }) {
  useEffect(() => {
    if (!error) {
      return undefined;
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [error, onClose]);

  if (!error) {
    return null;
  }

  async function copyRawBody() {
    const text = error.rawBody || JSON.stringify(error.details || error, null, 2);
    await navigator.clipboard?.writeText(text);
  }

  return (
    <div className={styles.drawerLayer} role="presentation" onMouseDown={onClose}>
      <aside
        className={styles.errorDrawer}
        role="dialog"
        aria-modal="true"
        aria-label="Estimate error details"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={styles.drawerHeader}>
          <div>
            <span className={styles.stepLabel}>Error details</span>
            <h3>{error.message || "The estimate request failed."}</h3>
          </div>
          <button className={styles.iconButton} type="button" onClick={onClose} aria-label="Close error details">
            x
          </button>
        </div>

        <dl className={styles.errorMeta}>
          <div>
            <dt>HTTP status</dt>
            <dd>{error.status || "Not available"}</dd>
          </div>
          {error.parseError ? (
            <div>
              <dt>Parse error</dt>
              <dd>{error.parseError}</dd>
            </div>
          ) : null}
        </dl>

        {Array.isArray(error.details) && error.details.length ? (
          <div className={styles.drawerSection}>
            <strong>Validation details</strong>
            <ul className={styles.errorList}>
              {error.details.map((detail, index) => (
                <li key={`${detail.rowId || detail.rid || "detail"}-${index}`}>
                  {detail.message || JSON.stringify(detail)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className={styles.drawerSection}>
          <div className={styles.drawerSectionHeader}>
            <strong>Raw response</strong>
            <button className={styles.textButton} type="button" onClick={copyRawBody}>
              Copy
            </button>
          </div>
          <pre className={styles.rawBlock}>{error.rawBody || "No raw response body was captured."}</pre>
        </div>
      </aside>
    </div>
  );
}
