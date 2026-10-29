"use client";

import { useState } from "react";

import { getMissingRequiredFields } from "@/lib/menu-input-schema";

import styles from "./bulk.module.css";

function formatIngredientList(row) {
  const ingredients = (row.ingredients || []).filter((ingredient) => ingredient?.name || ingredient?.grammage);
  if (!ingredients.length) {
    return "Not provided";
  }

  return ingredients
    .map((ingredient) => {
      if (ingredient.name && ingredient.grammage) {
        return `${ingredient.name} (${ingredient.grammage} g)`;
      }
      return ingredient.name || `${ingredient.grammage} g`;
    })
    .join(", ");
}

function EditableCell({ row, field, label, value, inputMode, onEdit }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <input
        className={styles.cellInput}
        aria-label={label}
        value={value || ""}
        inputMode={inputMode}
        autoFocus
        onChange={(event) => onEdit(row.rowId, field, event.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape") {
            event.currentTarget.blur();
          }
        }}
      />
    );
  }

  return (
    <button className={styles.editableCell} type="button" onClick={() => setEditing(true)}>
      {value || "Missing"}
    </button>
  );
}

export default function QueueTable({ rows, rowStates, onEdit, onRemove, onRetry, retryCounts }) {
  const [expanded, setExpanded] = useState(new Set());

  function toggle(rowId) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }

  return (
    <div className={styles.tableShell}>
      <table className={styles.bulkTable}>
        <thead>
          <tr>
            <th>RID</th>
            <th>Item name</th>
            <th>Price</th>
            <th>Grammage</th>
            <th>Cuisine</th>
            <th>Ingredients</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const missingFields = getMissingRequiredFields(row);
            const state = rowStates[row.rowId] || {};
            const failed = state.status === "failed";
            const ready = !missingFields.length && !failed;
            const expandedRow = expanded.has(row.rowId);

            return (
              <tr key={row.rowId} className={expandedRow ? styles.rowExpanded : ""}>
                <td data-label="RID" className={styles.monoCell}>
                  <EditableCell row={row} field="rid" label="RID" value={row.rid} inputMode="numeric" onEdit={onEdit} />
                </td>
                <td data-label="Item name">
                  <EditableCell row={row} field="name" label="Item name" value={row.name} onEdit={onEdit} />
                </td>
                <td data-label="Price" className={styles.monoCell}>
                  <EditableCell row={row} field="price" label="Price" value={row.price} inputMode="decimal" onEdit={onEdit} />
                </td>
                <td data-label="Grammage" className={styles.monoCell}>
                  <EditableCell
                    row={row}
                    field="grammage"
                    label="Grammage"
                    value={row.grammage}
                    inputMode="decimal"
                    onEdit={onEdit}
                  />
                </td>
                <td data-label="Cuisine">{row.cuisine || "Not provided"}</td>
                <td data-label="Ingredients">
                  <button className={styles.linkCell} type="button" onClick={() => toggle(row.rowId)}>
                    {expandedRow ? "Hide" : "View"} details
                  </button>
                  {expandedRow ? (
                    <div className={styles.queueDetail}>
                      <span><strong>Description:</strong> {row.description || "Not provided"}</span>
                      <span><strong>Ingredients:</strong> {formatIngredientList(row)}</span>
                      <span><strong>Included:</strong> {row.compulsoryComponents || "Not provided"}</span>
                      <span><strong>Optional:</strong> {row.optionalComponents || "Not provided"}</span>
                    </div>
                  ) : null}
                </td>
                <td data-label="Status">
                  {failed ? (
                    <span className={`${styles.badge} ${styles.badgeFailed}`}>Failed</span>
                  ) : (
                    <span className={`${styles.badge} ${ready ? styles.badgeReady : styles.badgeNeeds}`}>
                      {ready ? "Ready" : "Needs input"}
                    </span>
                  )}
                  {!ready && !failed ? <span className={styles.statusNote}>Missing {missingFields.join(", ")}</span> : null}
                  {failed ? <span className={styles.statusNote}>{state.error || "Estimate failed."}</span> : null}
                </td>
                <td data-label="Actions">
                  <div className={styles.actionStack}>
                    {failed ? (
                      <button className={styles.textButton} type="button" onClick={() => onRetry([row.rowId])}>
                        {(retryCounts[row.rowId] || 0) >= 3 ? "Open details" : "Retry"}
                      </button>
                    ) : null}
                    <button className={styles.textButton} type="button" onClick={() => onRemove(row.rowId)}>
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
