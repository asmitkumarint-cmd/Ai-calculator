import { NextResponse } from "next/server";

import * as XLSX from "xlsx";

import { formatKcalDisplay, formatProteinDisplay } from "@/lib/nutrition-display";

function summarize(results = []) {
  const failed = results.filter((row) => row.estimation_status === "failed");
  const succeeded = results.filter((row) => row.estimation_status !== "failed");
  const withCalories = succeeded.filter((row) => Number.isFinite(Number(row.estimated_energy_kcal)));
  const averageCalories = withCalories.length
    ? Math.round(withCalories.reduce((sum, row) => sum + Number(row.estimated_energy_kcal), 0) / withCalories.length)
    : 0;

  return {
    total: results.length,
    succeeded: succeeded.length,
    failed: failed.length,
    averageCalories,
  };
}

function resultRows(results = []) {
  return results.map((row) => ({
    RID: row.row_id || "",
    ITEM_NAME: row.input_name || "",
    ITEM_PRICE: row.input_item_price || "",
    ITEM_GRAMMAGE: row.input_item_grammage || "",
    CALORIES_DISPLAY:
      row.estimation_status === "failed" ? "" : formatKcalDisplay(row.estimated_energy_kcal, row.confidence_band),
    ESTIMATED_ENERGY_KCAL: row.estimated_energy_kcal ?? "",
    PROTEIN_DISPLAY: row.estimation_status === "failed" ? "" : formatProteinDisplay(row.estimated_protein_g),
    ESTIMATED_PROTEIN_G: row.estimated_protein_g ?? "",
    STATUS: row.estimation_status === "failed" ? "Failed" : "Done",
    CONFIDENCE_BAND: row.confidence_band || "",
    CONFIDENCE_PERCENT: row.confidence_score ?? row.confidence_percent ?? "",
    ERROR_MESSAGE: row.error_message || "",
    REASONING: row.reasoning_trace || row.rationale || "",
  }));
}

export async function POST(request) {
  try {
    const body = await request.json();
    const results = Array.isArray(body?.results) ? body.results : [];
    const estimator = body?.estimator || {};
    const summary = summarize(results);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(resultRows(results)), "Results");
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        { FIELD: "model", VALUE: estimator.model || "" },
        { FIELD: "embedding_model", VALUE: estimator.embeddingModel || "" },
        { FIELD: "generated_at", VALUE: body?.generatedAt || new Date().toISOString() },
        { FIELD: "total_rows", VALUE: summary.total },
        { FIELD: "succeeded", VALUE: summary.succeeded },
        { FIELD: "failed", VALUE: summary.failed },
        { FIELD: "average_calories", VALUE: summary.averageCalories },
      ]),
      "Run metadata"
    );

    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="rx-menu-nutrition-${new Date().toISOString().slice(0, 10)}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to export XLSX.",
        detail: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
