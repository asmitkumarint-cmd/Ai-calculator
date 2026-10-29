# RX Restaurant Calorie Portal

This is a restaurant-facing nutrition estimation portal built from the modeling artifacts in the parent `Rx Nutritional Calculator` workspace.

The product goal is straightforward:
- let restaurant partners upload a menu,
- estimate calories and protein per item using the GenAI backend,
- show which rows look ready to use and which ones still need review.

## What this app uses

- `final_prediction_v4.csv`: modeled Swiggy nutrition outputs used in the packaged catalog layer.
- `hp_test_data.csv`: item metadata such as cuisine, classifier, and segment.
- `hp_train_data.csv`: training-side context used for rollout framing and summary metrics.
- `High Protein Estimator (version 1)/train_metadata.csv` and `embedding_train data.csv`: reference-set context from the earlier FAISS prototype.
- `active_health_items_20Apr.csv`: April 20 active menu coverage dataset used for runtime retrieval context.
- `High Protein Estimator (version 1)/nutritional_100gm_db.csv`: ICMR ingredient reference data used by the GenAI flow.
- `Interface Screen Grabs/*.png`: legacy prototype screenshots used in the product story section.

## What a partner sees

- Landing page that explains:
  - what to upload,
  - which fields are mandatory,
  - how the current estimate is generated,
  - what confidence means,
  - when a row should be reviewed manually.
- Menu estimation workbench with:
  - manual item entry,
  - CSV and Excel upload,
  - explicit required-field guidance,
  - optional ingredient-card enrichment,
  - included and optional add-ons,
  - confidence-aware calorie and protein estimation,
  - internal logic and review signals.
- Catalog coverage and example sections that show the kinds of dishes the current labeled data already supports well.

## Intake schema

The portal now accepts the Gen AI document intake shape below.

Required partner inputs:
- `RID` (numeric restaurant ID; also retained as the result row identifier)
- `ITEM_NAME`
- `ITEM_PRICE` (item-level price, not restaurant-level price)

Optional partner inputs:
- `ITEM_GRAMMAGE`
- `ITEM_DESCRIPTION`
- `RX_CUISINE`
- `MAIN_INGREDIENT_1` ... `MAIN_INGREDIENT_6`
- `MAIN_INGREDIENT_1_GRAMMAGE` ... `MAIN_INGREDIENT_6_GRAMMAGE`
- `INGREDIENTS_LIST`
- `COMPULSORY_COMPONENTS`
- `OPTIONAL_COMPONENTS`

Backward-compatibility notes:
- CSV parsing still reads older aliases such as `item_name`, `description`, `cuisine`, and `price`.
- Estimation validates `RID`, `ITEM_NAME`, and `ITEM_PRICE`; grammage is optional.
- Internal `rowId` values are still generated for UI state, but they are not treated as partner `RID`.
- `RID` is stripped to digits during normalization. In the default estimator mode it is used for result tracking only.

## Local development

```bash
npm install
npm run build:data
npm run dev
```

Open `http://localhost:3000`.

If you want the retrieval-plus-LLM path, copy `.env.example` to `.env.local` and add `OPENAI_API_KEY`.

## Data build

```bash
npm run build:data
```

This generates:
- `app-data/catalog.json`
- `app-data/overview.json`
- `app-data/featured.json`
- `app-data/active-menu-catalog.json`
- `public/sample-menu.csv`

## GenAI asset build

The GenAI path needs precomputed embedding assets for the labeled nutrition reference set.

```bash
npm run build:genai-assets
```

This requires `OPENAI_API_KEY` and writes:
- `app-data/genai-reference-records.json`
- `app-data/genai-reference-embeddings.f32`
- `app-data/genai-reference-manifest.json`

Without these assets, or without OpenAI credentials at runtime, the API fails loudly instead of switching to a deterministic matcher.

## Production build

```bash
npm run build
```

## Runtime modes

The portal now prefers the GenAI backend when it can run:
- query embedding from the uploaded row using `text-embedding-3-small`,
- retrieval of similar historical items from the labeled nutrition reference set,
- retrieval of active menu context from the April 20 dataset,
- ICMR ingredient lookup from the 100g reference file,
- helper rules for broad food families,
- structured OpenAI response for protein, calories, reasoning trace, and separate protein versus calorie confidence.

Important behavior:
- `ITEM_PRICE` is item-level only and stays a weak contextual signal,
- `RID`, `ITEM_NAME`, and `ITEM_PRICE` are the three required inputs; item grammage is optional,
- ingredient cards and explicit gram quantities in the description are passed to the estimator as structured ingredient inputs,
- the restaurant form collects cuisine and preparation style as optional fields, with sides and add-on details in `ITEM_DESCRIPTION`; older API and upload fields remain accepted for compatibility,
- restaurant-facing calorie output uses compact kcal display, with ranges for lower-confidence estimates,
- final confidence is the lower of the protein and calorie evidence-adjusted confidence scores,
- explicit protein or calorie values in `ITEM_DESCRIPTION` are extracted separately and do not override the estimate.

Confidence starts from the model's separate protein and energy assessments, then moves toward an evidence-support score based on similar labeled items, relevant ICMR matches, explicit ingredient quantities, serving grammage, and available menu context. This is a heuristic, not a benchmark-calibrated probability. Entries can be logged only when final confidence is at least 70%.

## Output contract

Each response now includes top-level estimator metadata for the GenAI result path.

Each result row still includes the existing flat fields used by the UI, and now also includes:
- `reasoning_trace`
- `estimated_protein_g`
- `estimated_energy_kcal`
- `estimation_confidence`
- `confidence_percent`
- `extracted_protein_g`
- `extracted_energy_kcal`
- `input`: the normalized partner input payload
- `output`: the forward-compatible estimate payload
- `explainability`: match details, signals checked, signals that helped, and the item-price note

GenAI behavior:
- `output.confidence_detail.protein_confidence` and `output.confidence_detail.energy_confidence` are populated,
- `output.confidence_detail.final_confidence` is derived from the minimum rule,
- `explainability.retrieval` includes labeled neighbors, active menu context, ICMR matches, and helper rules.

## Environment

Use `.env.example` as the starting point:
- `OPENAI_API_KEY`: required for embedding generation and runtime GenAI calls
- `OPENAI_NUTRITION_BACKEND`: use `auto` or `genai`
- `OPENAI_RESPONSES_MODEL`: defaults to `gpt-4.1-mini`
- `OPENAI_EMBEDDING_MODEL`: defaults to `text-embedding-3-small`
- `OPENAI_ORGANIZATION` and `OPENAI_PROJECT`: optional

## Google Sheets logging

The single-item form sends qualifying submissions through the server-side `/api/log` route. To connect the supplied spreadsheet:

1. Open the spreadsheet and choose **Extensions → Apps Script**.
2. Paste `scripts/google-sheets-logger.gs` into the Apps Script editor.
3. In **Project Settings → Script Properties**, add `LOG_WEBHOOK_TOKEN` with a long random value.
4. Deploy the script as a web app that runs as the spreadsheet owner. Copy the deployment URL.
5. Set `GOOGLE_SHEETS_WEBHOOK_URL` to that URL and `GOOGLE_SHEETS_WEBHOOK_TOKEN` to the same token in the app's server environment.

The script creates a `Submissions` tab with headers on its first successful write. Both the app route and the script enforce the 70% confidence threshold. Keep the token in server-side environment settings only.

## RID and price retrieval

The default estimator uses ICMR embedding matching and retrieves from the semantic top eight, then reranks those candidates using the RID-mapped RX restaurant category and item-price similarity. Same-category and similarly priced dishes can rank higher among the candidates sent to the estimator. The category is also provided as restaurant context to the LLM. Unknown RIDs receive no category preference; price reranking and ICMR embedding retrieval still work. This mode improves retrieval context and categorization; it does not claim to estimate serving weight in grams.

RID-to-RX category prioritization is enabled by default. Set `RID_RX_CATEGORY_MODE=0` to explicitly disable it. The runtime resolves RID through `app-data/rid-rx-classifier.bin.gz`; this packaged mapping asset must be included in the deployment. The source mapping CSV is not required at runtime.

The mapping asset can be rebuilt from the partner CSV with `python3 scripts/build_rid_rx_mapping.py INPUT.csv app-data/rid-rx-classifier.bin.gz`. The benchmark runner supports `BENCHMARK_EXPECT_RETRIEVAL_MODE=price_top8` or `rid_rx_category_and_price_top8` to assert which mode the API actually used.

The `dataset_test.xlsx` benchmark passes descriptions through unchanged by default, matching the normal prediction input. Set `BENCHMARK_STRIP_NUTRITION_FROM_DESCRIPTION=1` only when intentionally measuring performance with explicit nutrition claims removed.

`node scripts/benchmark_portion_prior.mjs` runs a deterministic grouped holdout on the packaged 8,152-record reference corpus. It excludes held-out dish names from fitting and retrieval and excludes held-out name groups whose descriptions contain explicit nutrition values. This is a reference-corpus ablation benchmark, not a comparison against live GenAI API predictions.

## Why this portal exists

This portal exists to make menu estimation operational:
- restaurants can upload real menu rows and see estimates immediately,
- teams can tell which rows are strong enough to use and which need review,
- the next refinement loop can focus on real menu gaps instead of abstract offline metrics.
