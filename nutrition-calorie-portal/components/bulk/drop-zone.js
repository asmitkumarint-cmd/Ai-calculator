"use client";

import { useRef, useState } from "react";

import styles from "./bulk.module.css";

const ACCEPTED_EXTENSIONS = [".csv", ".xlsx", ".xls"];
const ACCEPTED_MIME = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "",
]);

function isAcceptedFile(file) {
  const lowerName = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((extension) => lowerName.endsWith(extension)) && ACCEPTED_MIME.has(file.type || "");
}

function formatBytes(size = 0) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 102.4) / 10} KB`;
  }
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

export default function DropZone({ fileInfo, onFile, onPasteCsv, onError }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function pickFile(file) {
    if (!file) {
      return;
    }
    if (!isAcceptedFile(file)) {
      onError("Upload a .csv, .xlsx, or .xls file.");
      return;
    }
    onFile(file);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    pickFile(event.dataTransfer.files?.[0]);
  }

  function handlePaste(event) {
    const file = Array.from(event.clipboardData?.files || []).find(Boolean);
    if (file) {
      pickFile(file);
      return;
    }

    const text = event.clipboardData?.getData("text/plain");
    if (text?.trim()) {
      onPasteCsv(text);
    }
  }

  return (
    <div>
      <button
        className={`${styles.dropZone} ${dragging ? styles.dropZoneActive : ""}`}
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onPaste={handlePaste}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          className={styles.fileInput}
          onChange={(event) => pickFile(event.target.files?.[0])}
        />
        <span className={styles.dropKicker}>CSV or Excel</span>
        <strong>{fileInfo ? fileInfo.name : "Drop your menu file here"}</strong>
        <span>
          {fileInfo
            ? `${formatBytes(fileInfo.size)} • ${fileInfo.rowCount} parsed rows`
            : "Drag and drop, click to browse, or paste CSV rows from the clipboard."}
        </span>
        {fileInfo ? <span className={styles.replaceLink}>Replace file</span> : null}
      </button>

      <div className={styles.templateLinks}>
        <a href="/api/template/xlsx">Download Excel template</a>
        <a href="/api/template/csv">Download CSV template</a>
      </div>
    </div>
  );
}
