"use client";

import { useState } from "react";

import { sanitizeRid } from "@/lib/menu-input-schema";
import { formatKcalDisplay, formatProteinDisplay } from "@/lib/nutrition-display";

import styles from "./minimal-calculator.module.css";

function createEmptyIngredient() {
  return { name: "", grammage: "" };
}

function formatIngredientList(ingredients = []) {
  const validIngredients = (ingredients || []).filter((ingredient) => ingredient?.name || ingredient?.grammage);
  if (!validIngredients.length) {
    return "Not provided";
  }

  return validIngredients
    .map((ingredient) => {
      if (ingredient.name && ingredient.grammage) {
        return `${ingredient.name} (${ingredient.grammage} g)`;
      }

      return ingredient.name || `${ingredient.grammage} g`;
    })
    .join(", ");
}

export default function MinimalCalculator() {
  const [form, setForm] = useState(() => ({
    rid: "",
    name: "",
    price: "",
    grammage: "",
    description: "",
    cuisine: "",
    preparationStyle: "",
    ingredients: [createEmptyIngredient()],
  }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [estimatorMeta, setEstimatorMeta] = useState(null);
  const [logging, setLogging] = useState(false);
  const [logStatus, setLogStatus] = useState(null);

  function invalidateEstimate() {
    setResult(null);
    setEstimatorMeta(null);
    setLogStatus(null);
    setError(null);
  }

  function updateField(key, value) {
    invalidateEstimate();
    setForm((current) => ({ ...current, [key]: key === "rid" ? sanitizeRid(value) : value }));
  }

  function updateIngredient(index, key, value) {
    invalidateEstimate();
    setForm((current) => ({
      ...current,
      ingredients: current.ingredients.map((ingredient, ingredientIndex) =>
        ingredientIndex === index ? { ...ingredient, [key]: value } : ingredient
      ),
    }));
  }

  function addIngredient() {
    invalidateEstimate();
    setForm((current) => ({
      ...current,
      ingredients: [...current.ingredients, createEmptyIngredient()],
    }));
  }

  function removeIngredient(index) {
    invalidateEstimate();
    setForm((current) => {
      const nextIngredients = current.ingredients.filter((_, ingredientIndex) => ingredientIndex !== index);

      return {
        ...current,
        ingredients: nextIngredients.length ? nextIngredients : [createEmptyIngredient()],
      };
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setResult(null);

    const missingFields = [];
    if (!form.rid.trim()) missingFields.push("RID");
    if (!form.name.trim()) missingFields.push("Item name");
    if (!form.price.trim()) missingFields.push("Item price");

    if (missingFields.length) {
      setError(`Please add ${missingFields.join(", ")} before estimating.`);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              RID: form.rid.trim(),
              ITEM_NAME: form.name.trim(),
              ITEM_PRICE: form.price.trim(),
              ITEM_GRAMMAGE: form.grammage.trim(),
              ITEM_DESCRIPTION: form.description.trim(),
              RX_CUISINE: form.cuisine.trim(),
              DISH_PREPARATION_STYLE: form.preparationStyle.trim(),
              ingredients: form.ingredients
                .map((ingredient) => ({
                  name: ingredient.name.trim(),
                  grammage: ingredient.grammage.trim(),
                }))
                .filter((ingredient) => ingredient.name || ingredient.grammage),
            },
          ],
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "The estimator could not process this dish.");
      }

      const firstResult = Array.isArray(data?.results) ? data.results[0] : null;
      if (!firstResult) {
        throw new Error("No estimate was returned. Try again with a more explicit dish build.");
      }

      setResult(firstResult);
      setEstimatorMeta(data.estimator || null);
      setLogStatus(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  async function handleLog() {
    const confidence = Number(result?.confidence_percent);
    if (!result || !Number.isFinite(confidence) || confidence < 70 || logging) return;

    setLogging(true);
    setLogStatus(null);
    try {
      const response = await fetch("/api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: {
            rid: form.rid.trim(),
            name: form.name.trim(),
            price: form.price.trim(),
            grammage: form.grammage.trim(),
            description: form.description.trim(),
            cuisine: form.cuisine.trim(),
            preparation_style: form.preparationStyle.trim(),
            ingredients: form.ingredients
              .map((ingredient) => ({ name: ingredient.name.trim(), grammage: ingredient.grammage.trim() }))
              .filter((ingredient) => ingredient.name || ingredient.grammage),
          },
          estimate: {
            estimated_energy_kcal: result.estimated_energy_kcal,
            estimated_protein_g: result.estimated_protein_g,
            confidence_percent: confidence,
            confidence_band: result.estimation_confidence,
            reasoning_trace: result.reasoning_trace || "",
          },
          estimator: estimatorMeta?.engine || "GenAI",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "The entry could not be logged.");
      setLogStatus({ type: "success", message: "Entry logged for review." });
    } catch (requestError) {
      setLogStatus({
        type: "error",
        message: requestError instanceof Error ? requestError.message : "The entry could not be logged.",
      });
    } finally {
      setLogging(false);
    }
  }

  function handleReset() {
    setForm({
      rid: "",
      name: "",
      price: "",
      grammage: "",
      description: "",
      cuisine: "",
      preparationStyle: "",
      ingredients: [createEmptyIngredient()],
    });
    setResult(null);
    setEstimatorMeta(null);
    setError(null);
    setLogStatus(null);
  }

  return (
    <section className={styles.calculator} aria-label="Single menu-item nutrition builder">
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.headerBlock}>
          <span className={styles.eyebrow}>Item estimate</span>
          <h2>Enter the menu item exactly as the restaurant sells it.</h2>
          <p>Enter the required item details to get an estimate.</p>
        </div>

        <section className={styles.requiredSection} aria-labelledby="required-fields-heading">
          <h3 id="required-fields-heading" className={styles.requiredHeading}>Required fields</h3>
          <div className={styles.requiredGrid}>
            <Field
              label="RID"
              required
              value={form.rid}
              placeholder="1001"
              helper="Numeric item ID for tracking only."
              inputMode="numeric"
              onChange={(value) => updateField("rid", value)}
            />
            <Field
              label="Item name"
              required
              value={form.name}
              placeholder="Paneer Butter Masala"
              helper="Customer-facing dish name."
              onChange={(value) => updateField("name", value)}
            />
            <Field
              label="Item price"
              required
              value={form.price}
              placeholder="250"
              helper="Selling price for this dish only."
              inputMode="decimal"
              onChange={(value) => updateField("price", value)}
            />
          </div>
        </section>

        <details className={styles.optionalSection}>
          <summary className={styles.disclosureSummary}>Additional information <span>Optional</span></summary>
          <p className={styles.sectionNote}>Add any details you have to improve the estimate.</p>
          <div className={styles.optionalGrid}>
            <Field
              label="Item grammage"
              value={form.grammage}
              placeholder="320"
              helper="Approximate total plated weight in grams."
              inputMode="decimal"
              onChange={(value) => updateField("grammage", value)}
            />
            <Field
              label="Cuisine"
              value={form.cuisine}
              placeholder="North Indian"
              helper="Optional cuisine or food style."
              onChange={(value) => updateField("cuisine", value)}
            />
            <Field
              label="Dish preparation style"
              value={form.preparationStyle}
              placeholder="Grilled, fried, steamed"
              helper="How the dish is cooked."
              onChange={(value) => updateField("preparationStyle", value)}
            />
            <Field
              label="Short description"
              value={form.description}
              placeholder="Paneer 120 g; tomato gravy 150 g; butter 20 g. Served with salad and raita."
              helper="Include ingredients and quantities, sides, or any included or optional add-ons."
              as="textarea"
              full
              onChange={(value) => updateField("description", value)}
            />
          </div>

          <details className={styles.ingredientsDisclosure}>
            <summary className={styles.disclosureSummary}>Ingredients <span>Optional</span></summary>
            <p className={styles.sectionNote}>Add main ingredients and approximate grams when the dish has a custom build.</p>

            <div className={styles.cardList}>
              {form.ingredients.map((ingredient, index) => (
                <article key={`ingredient-${index}`} className={styles.ingredientCard}>
                  <Field
                    label={`Ingredient ${index + 1}`}
                    value={ingredient.name}
                    placeholder="Paneer"
                    helper="Main ingredient name."
                    onChange={(value) => updateIngredient(index, "name", value)}
                  />
                  <Field
                    label="Grammage"
                    value={ingredient.grammage}
                    placeholder="50"
                    helper="Approximate grams for this ingredient."
                    inputMode="decimal"
                    onChange={(value) => updateIngredient(index, "grammage", value)}
                  />
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => removeIngredient(index)}
                    disabled={form.ingredients.length === 1 && !ingredient.name && !ingredient.grammage}
                  >
                    Remove
                  </button>
                </article>
              ))}
            </div>

            <div className={styles.actionRow}>
              <button type="button" className={styles.secondaryButton} onClick={addIngredient}>
                Add ingredient
              </button>
              <div className={styles.cartSummary}>
                <span>Ingredient summary</span>
                <strong>{formatIngredientList(form.ingredients)}</strong>
              </div>
            </div>
          </details>
        </details>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.submitRow}>
          <button type="submit" className={styles.primaryButton} disabled={loading}>
            {loading ? "Estimating..." : "Estimate item"}
          </button>
          <button type="button" className={styles.linkButton} onClick={handleReset}>
            Reset builder
          </button>
        </div>
      </form>

      {result ? (
        <ResultCard
          result={result}
          estimatorMeta={estimatorMeta}
          logging={logging}
          logStatus={logStatus}
          onLog={handleLog}
          onReset={handleReset}
        />
      ) : null}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  helper,
  required = false,
  inputMode,
  as = "input",
  full = false,
}) {
  const Control = as === "textarea" ? "textarea" : "input";

  return (
    <label className={`${styles.field} ${full ? styles.fieldFull : ""}`}>
      <span className={styles.labelRow}>
        <span>{label}</span>
        <span className={required ? styles.requiredBadge : styles.optionalBadge}>
          {required ? "Required" : "Optional"}
        </span>
      </span>
      <Control
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
      />
      <small>{helper}</small>
    </label>
  );
}

function ResultCard({ result, estimatorMeta, logging, logStatus, onLog, onReset }) {
  const confidenceLabel = humanizeConfidence(result.estimation_confidence);
  const confidencePercent =
    typeof result.confidence_percent === "number" ? `${Math.round(result.confidence_percent)}%` : null;
  const canLog =
    typeof result.confidence_percent === "number" &&
    result.confidence_percent >= 70 &&
    Number.isFinite(Number(result.estimated_protein_g)) &&
    Number.isFinite(Number(result.estimated_energy_kcal));
  const reasoning = result.reasoning_trace || result.rationale || null;

  return (
    <article className={styles.resultCard} aria-live="polite">
      <header className={styles.resultHeader}>
        <span className={styles.resultEyebrow}>Estimated nutrition</span>
        <h3>{result.input_name || "Your dish"}</h3>
        <p>
          Labeled nutrition references, the April 20 active menu dataset, and ICMR ingredient checks all informed this
          estimate.
        </p>
      </header>

      <div className={styles.resultStats}>
        <div className={styles.statBlock}>
          <span>Calories</span>
          <strong>{formatKcalDisplay(result.estimated_energy_kcal, result.estimation_confidence)}</strong>
        </div>
        <div className={styles.statBlock}>
          <span>Protein</span>
          <strong>{formatProteinDisplay(result.estimated_protein_g)}</strong>
        </div>
        <div className={`${styles.statBlock} ${styles.statBlockMuted}`}>
          <span>Confidence</span>
          <strong>
            {confidenceLabel}
            {confidencePercent ? ` - ${confidencePercent}` : ""}
          </strong>
        </div>
      </div>

      {reasoning ? (
        <p className={styles.reasoning}>
          <span>Why:</span> {reasoning}
        </p>
      ) : null}

      <div className={styles.resultFooter}>
        <span className={styles.engineBadge}>Engine: {estimatorMeta?.engine || "GenAI"}</span>
        <button type="button" className={styles.primaryButton} onClick={onLog} disabled={!canLog || logging}>
          {logging ? "Logging..." : "Log entry"}
        </button>
        <button type="button" className={styles.linkButton} onClick={onReset}>
          Build another dish
        </button>
      </div>
      <p
        className={`${styles.logGuidance} ${logStatus?.type === "error" ? styles.logError : ""} ${logStatus?.type === "success" ? styles.logSuccess : ""}`}
        role="status"
      >
        {logStatus?.message ||
          (canLog
            ? "This estimate meets the 70% confidence threshold for logging."
            : "Logging is available when a complete estimate reaches 70% confidence.")}
      </p>
    </article>
  );
}

function humanizeConfidence(value) {
  if (!value) return "--";
  const normalized = String(value).toLowerCase();
  if (normalized.includes("high")) return "High";
  if (normalized.includes("med")) return "Medium";
  if (normalized.includes("low")) return "Low";
  return value;
}
