import * as XLSX from "xlsx";

import { CSV_HEADER_ORDER, MENU_FIELD_GUIDE, TEMPLATE_INGREDIENT_SLOT_COUNT } from "@/lib/menu-input-schema";

/**
 * Builds the rx-menu-template.xlsx / rx-menu-template.csv files served
 * from /api/template/xlsx and /api/template/csv.
 *
 * Purpose: an empty menu form for restaurant operators to fill and re-upload.
 * NOT used for model training. NOT used as retrieval reference data.
 * The training/retrieval corpus is app-data/genai-reference-records.json
 * plus app-data/genai-reference-embeddings.f32; those are unrelated to this file.
 */

function buildBlankRow() {
  return {
    RID: "",
    ITEM_NAME: "",
    ITEM_PRICE: "",
    ITEM_GRAMMAGE: "",
    ITEM_DESCRIPTION: "",
    RX_CUISINE: "",
    INGREDIENTS_LIST: "",
    COMPULSORY_COMPONENTS: "",
    OPTIONAL_COMPONENTS: "",
    ...Object.fromEntries(
      Array.from({ length: TEMPLATE_INGREDIENT_SLOT_COUNT }, (_, index) => {
        const slot = index + 1;
        return [
          [`MAIN_INGREDIENT_${slot}`, ""],
          [`MAIN_INGREDIENT_${slot}_GRAMMAGE`, ""],
        ];
      }).flat()
    ),
  };
}

export function buildTemplateRows() {
  return [
    {
      RID: "1001",
      ITEM_NAME: "Paneer Butter Masala",
      ITEM_PRICE: "250",
      ITEM_GRAMMAGE: "320",
      ITEM_DESCRIPTION: "Paneer 120 g, tomato gravy 150 g, butter 20 g.",
      RX_CUISINE: "North Indian",
      MAIN_INGREDIENT_1: "Paneer",
      MAIN_INGREDIENT_1_GRAMMAGE: "120",
      MAIN_INGREDIENT_2: "Tomato gravy",
      MAIN_INGREDIENT_2_GRAMMAGE: "150",
      MAIN_INGREDIENT_3: "Butter",
      MAIN_INGREDIENT_3_GRAMMAGE: "20",
      MAIN_INGREDIENT_4: "",
      MAIN_INGREDIENT_4_GRAMMAGE: "",
      MAIN_INGREDIENT_5: "",
      MAIN_INGREDIENT_5_GRAMMAGE: "",
      MAIN_INGREDIENT_6: "",
      MAIN_INGREDIENT_6_GRAMMAGE: "",
      INGREDIENTS_LIST: "Paneer:120 g; Tomato gravy:150 g; Butter:20 g",
      COMPULSORY_COMPONENTS: "Paneer cubes, gravy",
      OPTIONAL_COMPONENTS: "Onion salad",
    },
    {
      RID: "22",
      ITEM_NAME: "Idli (2 pieces)",
      ITEM_PRICE: "80",
      ITEM_GRAMMAGE: "100",
      ITEM_DESCRIPTION: "",
      RX_CUISINE: "South Indian",
      MAIN_INGREDIENT_1: "Rice batter",
      MAIN_INGREDIENT_1_GRAMMAGE: "75",
      MAIN_INGREDIENT_2: "Urad dal batter",
      MAIN_INGREDIENT_2_GRAMMAGE: "25",
      MAIN_INGREDIENT_3: "",
      MAIN_INGREDIENT_3_GRAMMAGE: "",
      MAIN_INGREDIENT_4: "",
      MAIN_INGREDIENT_4_GRAMMAGE: "",
      MAIN_INGREDIENT_5: "",
      MAIN_INGREDIENT_5_GRAMMAGE: "",
      MAIN_INGREDIENT_6: "",
      MAIN_INGREDIENT_6_GRAMMAGE: "",
      INGREDIENTS_LIST: "Rice batter:75 g; Urad dal batter:25 g",
      COMPULSORY_COMPONENTS: "Sambar, coconut chutney",
      OPTIONAL_COMPONENTS: "Tomato chutney",
    },
    buildBlankRow(),
  ].map((row) =>
    Object.fromEntries(CSV_HEADER_ORDER.map((field) => [field, row[field] ?? ""]))
  );
}

export function buildFieldGuideRows() {
  return MENU_FIELD_GUIDE.map((field) => ({
    FIELD: field.key,
    LABEL: field.label,
    STATUS: field.required ? "Required" : "Optional",
    DESCRIPTION:
      field.key === "ITEM_PRICE"
        ? `${field.description} (rupees, integer)`
        : field.key === "ITEM_GRAMMAGE"
          ? `${field.description} (grams, integer)`
          : field.description,
  }));
}

export function buildCsvTemplateString() {
  const rows = buildTemplateRows();
  const lines = [
    CSV_HEADER_ORDER.join(","),
    ...rows.map((row) =>
      CSV_HEADER_ORDER.map((field) => csvEscape(row[field] ?? "")).join(",")
    ),
  ];

  return `${lines.join("\n")}\n`;
}

export function buildWorkbookBuffer() {
  const workbook = XLSX.utils.book_new();
  const templateSheet = XLSX.utils.json_to_sheet(buildTemplateRows(), {
    header: CSV_HEADER_ORDER,
  });
  const fieldGuideSheet = XLSX.utils.json_to_sheet(buildFieldGuideRows());

  XLSX.utils.book_append_sheet(workbook, templateSheet, "Menu Template");
  XLSX.utils.book_append_sheet(workbook, fieldGuideSheet, "Field Guide");

  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll('"', '""')}"`;
}
