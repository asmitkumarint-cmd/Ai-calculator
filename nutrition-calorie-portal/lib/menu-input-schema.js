export const TEMPLATE_INGREDIENT_SLOT_COUNT = 6;

export const REQUIRED_MENU_FIELDS = ["RID", "ITEM_NAME", "ITEM_PRICE"];

const TEMPLATE_INGREDIENT_FIELDS = Array.from({ length: TEMPLATE_INGREDIENT_SLOT_COUNT }, (_, index) => {
  const slot = index + 1;
  return [`MAIN_INGREDIENT_${slot}`, `MAIN_INGREDIENT_${slot}_GRAMMAGE`];
}).flat();

export const OPTIONAL_MENU_FIELDS = [
  "ITEM_GRAMMAGE",
  "ITEM_DESCRIPTION",
  "RX_CUISINE",
  "DISH_TYPE",
  "DISH_FAMILY",
  "DISH_PREPARATION_STYLE",
  "RX_CLASSIFIER",
  "RX_SEGMENTS",
  ...TEMPLATE_INGREDIENT_FIELDS,
  "INGREDIENTS_LIST",
  "COMPULSORY_COMPONENTS",
  "OPTIONAL_COMPONENTS",
];

export const CSV_HEADER_ORDER = [...REQUIRED_MENU_FIELDS, ...OPTIONAL_MENU_FIELDS];

export const MENU_FIELD_GUIDE = [
  {
    key: "RID",
    label: "RID",
    required: true,
    description: "Numeric restaurant ID. The RID maps to the restaurant RX category used as context when retrieving similar dishes.",
  },
  {
    key: "ITEM_NAME",
    label: "Item name",
    required: true,
    description: "Customer-facing dish name exactly as it appears on the menu.",
  },
  {
    key: "ITEM_PRICE",
    label: "Item price",
    required: true,
    description: "Selling price for this item only. Do not use restaurant-level averages.",
  },
  {
    key: "ITEM_GRAMMAGE",
    label: "Item grammage",
    required: false,
    description: "Approximate total plated weight of the full dish in grams. Improves accuracy when available, no longer required to run an estimate.",
  },
  {
    key: "ITEM_DESCRIPTION",
    label: "Short description",
    required: false,
    description:
      "Actionable operator note, not marketing copy. Prefer key ingredients with grams, for example: Paneer 50 g, tomato gravy 120 g, butter 15 g.",
  },
  {
    key: "DISH_TYPE",
    label: "Dish type",
    required: false,
    description: "Category like bowl, curry, or snack, if already classified. Helps the model calibrate against similar dish types.",
  },
  {
    key: "DISH_FAMILY",
    label: "Dish family",
    required: false,
    description: "Broader grouping the dish belongs to, e.g. North Indian curries. Used as extra context, not a nutrition source itself.",
  },
  {
    key: "DISH_PREPARATION_STYLE",
    label: "Preparation style",
    required: false,
    description: "How the dish is cooked, e.g. deep fried, grilled, steamed. Preparation style materially affects calorie content.",
  },
  {
    key: "RX_CLASSIFIER",
    label: "Classifier",
    required: false,
    description: "Internal dish classification tag, if available.",
  },
  {
    key: "RX_SEGMENTS",
    label: "Segment",
    required: false,
    description: "Menu segment or positioning tag, e.g. high protein, balanced, indulgent, if available.",
  },
  {
    key: "MAIN_INGREDIENT_N",
    label: "Ingredient cards",
    required: false,
    description:
      "Optional ingredient rows. Add as many key ingredients as needed and include grams whenever possible.",
  },
  {
    key: "INGREDIENTS_LIST",
    label: "Ingredients list",
    required: false,
    description:
      "Spreadsheet-friendly optional field for many ingredients. Format example: Paneer:50 g; Tomato gravy:120 g; Butter:15 g.",
  },
];

const EMPTY_DRAFT = {
  rid: "",
  name: "",
  description: "",
  cuisine: "",
  price: "",
  grammage: "",
  compulsoryComponents: "",
  optionalComponents: "",
  ingredients: [createEmptyIngredient()],
};

const FIELD_ALIASES = {
  rid: ["RID", "RID (Required)", "rid", "Rid"],
  name: ["ITEM_NAME", "ITEM_NAME (Required)", "item_name", "name", "ItemName"],
  description: [
    "ITEM_DESCRIPTION",
    "ITEM_DESCRIPTION (Optional)",
    "item_description",
    "description",
    "Description",
  ],
  cuisine: ["RX_CUISINE", "RX_CUISINE (Optional)", "rx_cuisine", "cuisine", "CUISINE"],
  dishType: ["DISH_TYPE", "dish_type", "DishType"],
  dishFamily: ["DISH_FAMILY", "dish_family", "DishFamily"],
  preparationStyle: [
    "DISH_PREPARATION_STYLE",
    "dish_preparation_style",
    "DishPreparationStyle",
  ],
  classifier: ["RX_CLASSIFIER", "rx_classifier", "RxClassifier"],
  // Supports both spellings, the reference corpus build script uses the
  // plural RX_SEGMENTS, some source datasets use the singular RX_SEGMENT.
  segment: ["RX_SEGMENTS", "rx_segments", "RX_SEGMENT", "rx_segment", "RxSegment"],
  price: ["ITEM_PRICE", "ITEM_PRICE (Required)", "item_price", "price", "Price"],
  grammage: [
    "ITEM_GRAMMAGE",
    "ITEM_GRAMMAGE (Required)",
    "item_grammage",
    "grammage",
    "Grammage",
  ],
  ingredientsList: ["INGREDIENTS_LIST", "ingredients_list", "ingredientsList", "KEY_INGREDIENTS"],
  compulsoryComponents: [
    "COMPULSORY_COMPONENTS",
    "compulsory_components",
    "compulsoryComponents",
  ],
  optionalComponents: ["OPTIONAL_COMPONENTS", "optional_components", "optionalComponents"],
};

export function createEmptyIngredient() {
  return { name: "", grammage: "" };
}

function readAliasedValue(source = {}, aliases = []) {
  for (const alias of aliases) {
    if (!(alias in source)) {
      continue;
    }

    const value = source[alias];
    if (value == null) {
      continue;
    }

    const normalized = String(value).trim();
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

export function sanitizeRid(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function normalizeIngredientEntry(ingredient = {}) {
  const name = String(ingredient?.name || ingredient?.ingredient || ingredient?.ITEM_INGREDIENT || "").trim();
  const grammage = String(
    ingredient?.grammage || ingredient?.grams || ingredient?.quantity || ingredient?.ITEM_INGREDIENT_GRAMMAGE || ""
  ).trim();

  return { name, grammage };
}

function parseIngredientsList(value = "") {
  return String(value || "")
    .split(/\r?\n|;|\|/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(.*?)(?:\s*[:\-]\s*|\s*\(\s*)(\d+(?:\.\d+)?)?\s*(?:g|gm|grams?)?\s*\)?$/i);
      if (!match) {
        return { name: entry, grammage: "" };
      }

      const name = String(match[1] || "").trim();
      const grammage = String(match[2] || "").trim();
      return { name, grammage };
    })
    .filter((ingredient) => ingredient.name || ingredient.grammage);
}

export function extractDescriptionIngredients(description = "") {
  return String(description || "")
    .split(/[,;|\n]+/)
    .map((entry) => entry.trim().replace(/[.]+$/, ""))
    .filter(Boolean)
    .flatMap((entry) => {
      if (/^(?:protein|energy|calories?)\b/i.test(entry)) {
        return [];
      }

      const match =
        entry.match(/^(.+?)\s*[:(]\s*(\d+(?:\.\d+)?)\s*(?:g|gm|grams?)\s*\)?$/i) ||
        entry.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*(?:g|gm|grams?)$/i) ||
        entry.match(/^(\d+(?:\.\d+)?)\s*(?:g|gm|grams?)\s+(.+)$/i);

      if (!match) {
        return [];
      }

      const quantityFirst = /^\d/.test(entry);
      const name = String(quantityFirst ? match[2] : match[1])
        .replace(/^(?:(?:ingredients?)\s+)?(?:(?:include(?:s)?)|with)\s+/i, "")
        .replace(/[.]+$/, "")
        .trim();
      const grammage = String(quantityFirst ? match[1] : match[2]).trim();

      if (!name || /^(?:protein|energy|calories?)\b/i.test(name)) {
        return [];
      }

      return [{ name, grammage }];
    });
}

function getIngredientAliases(slot) {
  return {
    name: [
      `MAIN_INGREDIENT_${slot}`,
      `MAIN_INGREDIENT_${slot} (Optional)`,
      `main_ingredient_${slot}`,
      `mainIngredient${slot}`,
      `Ingredient ${slot}`,
    ],
    grammage: [
      `MAIN_INGREDIENT_${slot}_GRAMMAGE`,
      `MAIN_INGREDIENT_${slot}_GRAMMAGE (Optional)`,
      `main_ingredient_${slot}_grammage`,
      `mainIngredient${slot}Grammage`,
      `Ingredient ${slot} Grammage`,
    ],
  };
}

function readIndexedIngredients(source = {}) {
  const ingredients = [];

  for (let slot = 1; slot <= TEMPLATE_INGREDIENT_SLOT_COUNT; slot += 1) {
    const aliases = getIngredientAliases(slot);
    const ingredient = {
      name: readAliasedValue(source, aliases.name),
      grammage: readAliasedValue(source, aliases.grammage),
    };

    if (ingredient.name || ingredient.grammage) {
      ingredients.push(ingredient);
    }
  }

  return ingredients;
}

function dedupeIngredients(items = []) {
  const seen = new Set();
  const output = [];

  for (const ingredient of items) {
    const normalized = normalizeIngredientEntry(ingredient);
    if (!normalized.name && !normalized.grammage) {
      continue;
    }

    const key = `${normalized.name.toLowerCase()}::${normalized.grammage}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(normalized);
  }

  return output;
}

function collectIngredients(input = {}) {
  const arrayIngredients = Array.isArray(input.ingredients) ? input.ingredients.map(normalizeIngredientEntry) : [];
  const indexedIngredients = readIndexedIngredients(input);
  const listedIngredients = parseIngredientsList(readAliasedValue(input, FIELD_ALIASES.ingredientsList));
  const descriptionIngredients = extractDescriptionIngredients(readAliasedValue(input, FIELD_ALIASES.description));
  const combined = [...arrayIngredients, ...indexedIngredients, ...listedIngredients];

  for (const ingredient of descriptionIngredients) {
    const existing = combined.find((entry) => entry.name.toLowerCase() === ingredient.name.toLowerCase());
    if (!existing) {
      combined.push(ingredient);
    } else if (!existing.grammage) {
      existing.grammage = ingredient.grammage;
    }
  }

  return dedupeIngredients(combined);
}

function buildLegacyIngredientFields(ingredients = []) {
  const slots = Array.from({ length: 3 }, (_, index) => ingredients[index] || createEmptyIngredient());

  return {
    mainIngredient1: slots[0].name,
    mainIngredient1Grammage: slots[0].grammage,
    mainIngredient2: slots[1].name,
    mainIngredient2Grammage: slots[1].grammage,
    mainIngredient3: slots[2].name,
    mainIngredient3Grammage: slots[2].grammage,
  };
}

export function serializeIngredientsList(ingredients = []) {
  return ingredients
    .filter((ingredient) => ingredient?.name || ingredient?.grammage)
    .map((ingredient) => {
      if (ingredient.name && ingredient.grammage) {
        return `${ingredient.name}:${ingredient.grammage} g`;
      }
      return ingredient.name || `${ingredient.grammage} g`;
    })
    .join("; ");
}

export function createEmptyDraft() {
  return {
    ...EMPTY_DRAFT,
    ingredients: EMPTY_DRAFT.ingredients.map((ingredient) => ({ ...ingredient })),
  };
}

export function normalizeMenuInput(input = {}, index = 0, options = {}) {
  const ingredients = collectIngredients(input);
  const legacyFields = buildLegacyIngredientFields(ingredients);

  return {
    rowId: String(options.rowId || input.rowId || input.internalRowId || `row-${index + 1}`),
    rid: sanitizeRid(readAliasedValue(input, FIELD_ALIASES.rid)),
    name: readAliasedValue(input, FIELD_ALIASES.name),
    description: readAliasedValue(input, FIELD_ALIASES.description),
    cuisine: readAliasedValue(input, FIELD_ALIASES.cuisine),
    dishType: readAliasedValue(input, FIELD_ALIASES.dishType),
    dishFamily: readAliasedValue(input, FIELD_ALIASES.dishFamily),
    preparationStyle: readAliasedValue(input, FIELD_ALIASES.preparationStyle),
    classifier: readAliasedValue(input, FIELD_ALIASES.classifier),
    segment: readAliasedValue(input, FIELD_ALIASES.segment),
    price: readAliasedValue(input, FIELD_ALIASES.price),
    grammage: readAliasedValue(input, FIELD_ALIASES.grammage),
    ingredients,
    ingredientsList: serializeIngredientsList(ingredients),
    compulsoryComponents: readAliasedValue(input, FIELD_ALIASES.compulsoryComponents),
    optionalComponents: readAliasedValue(input, FIELD_ALIASES.optionalComponents),
    ...legacyFields,
    sourceRowNumber: index + 1,
  };
}

export function mapCsvMenuRow(row = {}, index = 0) {
  return normalizeMenuInput(row, index, { rowId: `csv-${index + 1}` });
}

export function hasMenuInputContent(item = {}) {
  const normalized = item.sourceRowNumber ? item : normalizeMenuInput(item);
  return [
    normalized.rid,
    normalized.name,
    normalized.description,
    normalized.cuisine,
    normalized.price,
    normalized.grammage,
    normalized.ingredientsList,
    normalized.compulsoryComponents,
    normalized.optionalComponents,
  ].some(Boolean);
}

export function getMissingRequiredFields(item = {}) {
  const normalized = item.sourceRowNumber ? item : normalizeMenuInput(item);
  const missing = [];

  if (!normalized.rid) {
    missing.push("RID");
  }
  if (!normalized.name) {
    missing.push("ITEM_NAME");
  }
  if (!normalized.price) {
    missing.push("ITEM_PRICE");
  }
  // ITEM_GRAMMAGE intentionally not checked here, no longer a blocking field.
  // The pipeline already degrades gracefully without it (buildQueryBlob and
  // the prompt just show it blank, the masala dosa guardrail already falls
  // back to a 230g default when grammage is missing or out of range).

  return missing;
}

export function validateMenuItems(items = []) {
  const normalizedItems = items.map((item, index) => normalizeMenuInput(item, index)).filter(hasMenuInputContent);
  const errors = normalizedItems
    .map((item) => {
      const missingFields = getMissingRequiredFields(item);
      if (!missingFields.length) {
        return null;
      }

      return {
        rowId: item.rowId,
        rid: item.rid || null,
        rowNumber: item.sourceRowNumber,
        itemName: item.name || null,
        missingFields,
        message: `Row ${item.sourceRowNumber} is missing ${missingFields.join(", ")}.`,
      };
    })
    .filter(Boolean);

  return { normalizedItems, errors };
}
