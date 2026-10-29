function roundToNearest(value, step = 10) {
  return Math.round(value / step) * step;
}

function normalizeBand(value = "") {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("high")) return "High";
  if (normalized.includes("med")) return "Medium";
  if (normalized.includes("low")) return "Low";
  return "";
}

export function formatKcalDisplay(value, confidenceBand) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "Not available";
  }

  const band = normalizeBand(confidenceBand);
  if (band === "High") {
    return `${roundToNearest(numeric)} kcal`;
  }

  const spread = band === "Low" ? 0.15 : 0.1;
  const lower = Math.max(0, roundToNearest(numeric * (1 - spread)));
  const upper = Math.max(lower + 10, roundToNearest(numeric * (1 + spread)));
  return `${lower}-${upper} kcal`;
}

export function formatProteinDisplay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "Not available";
  }

  return `${Math.round(numeric * 10) / 10} g`;
}
