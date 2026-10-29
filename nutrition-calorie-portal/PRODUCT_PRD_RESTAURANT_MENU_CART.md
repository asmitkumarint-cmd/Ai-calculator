# PRD: Swiggy Restaurant Menu Nutrition Cart

## 1. Product Summary

Build a restaurant-facing menu nutrition product that feels like adding items to a cart. A restaurant operator should be able to add one menu item at a time, enrich it with ingredients and add-ons, review a cart of menu items, run protein and calorie estimation, then export or submit the reviewed results.

The product must be easy enough for Swiggy to circulate broadly across restaurants, without requiring partners to understand nutrition modeling, retrieval, ICMR references, or internal confidence logic.

## 2. Current Codebase Snapshot

Current app: `rx-restaurant-calorie-portal`

Stack:
- Next.js 16 app router
- React 19
- OpenAI SDK for runtime GenAI estimation
- PapaParse and XLSX for CSV/Excel upload
- Local generated data assets under `app-data`

Important files:
- `app/page.js`: single-item builder entry page
- `app/bulk/page.js`: bulk upload page
- `components/minimal-calculator.js`: single-item estimator UI
- `components/portal-workbench.js`: manual batch/cart plus CSV/XLSX upload UI
- `lib/menu-input-schema.js`: field aliases, validation, normalization
- `lib/genai-estimator.js`: GenAI RAG estimator, prompt construction, ICMR lookup, confidence output
- `lib/portal-data.js`: API-facing estimator orchestration
- `app/api/estimate/route.js`: estimation API

Current product behavior:
- Requires `RID`, `ITEM_NAME`, `ITEM_PRICE`, and `ITEM_GRAMMAGE`.
- Supports optional description, cuisine, ingredient cards, compulsory components, optional components, and upload templates.
- Already has a cart-like batch queue in `PortalWorkbench`.
- Sends `RID` into the GenAI prompt, even though RID is an identifier and should not influence nutrition.

## 3. Core Problems To Solve

1. RID is visually and behaviorally confusing.
   - Current placeholder examples use strings like `RID-1001`.
   - User requirement: for RID, show/add only the number. Remove hyphen and words.
   - RID should be a stable tracking ID, not a nutrition signal.

2. Component language is not partner-friendly.
   - Current UI says `Compulsory components` and `Optional components`.
   - User requirement: use `add-ons` wording instead of `components`.

3. Calorie/kcal presentation needs to be shorter and clearer.
   - Current output shows exact calories like `425 kcal`.
   - Requirement: show a compact kcal range where appropriate, with less verbose language.

4. RID changes can affect output today.
   - Current `buildPrompt()` includes `RID: ${item.rid}`.
   - Even if retrieval does not use RID in `buildQueryBlob()`, the LLM sees RID in the prompt. Any prompt change can affect generated estimates.
   - Fix requirement: RID must be excluded from nutrition reasoning and model prompts, or explicitly isolated as metadata outside the estimator input.

5. Product needs to shift from internal calculator to restaurant-ready workflow.
   - Restaurants should feel like they are adding menu items to a cart.
   - Swiggy teams need to circulate a simple, guided product across many restaurants.

## 4. Target Users

Primary:
- Restaurant owner/operator entering or uploading menu items.
- Swiggy onboarding or category team collecting nutrition estimates from restaurants.

Secondary:
- Internal nutrition review team.
- Product/business team tracking adoption and completion.
- Engineering/data science team monitoring model quality.

## 5. Product Goal

Enable a restaurant to complete nutrition estimation for their menu with minimal training.

Success looks like:
- Operator adds menu items like a shopping cart.
- Required fields are obvious and low-friction.
- Ingredient/add-on enrichment is guided but optional.
- RID is treated only as a tracking number.
- Estimates are easy to review: protein, kcal range, confidence, and action needed.
- Results can be exported, shared, or submitted back to Swiggy.

## 6. Primary Workflow

1. Restaurant starts a menu cart.
2. Restaurant adds an item.
3. Restaurant enters required item details:
   - RID number
   - Item name
   - Item price
   - Item grammage
4. Restaurant optionally adds:
   - Ingredients with grams
   - Included add-ons
   - Optional add-ons
   - Cuisine
   - Short prep/recipe note
5. Item is added to cart.
6. Restaurant repeats until the menu is ready.
7. Restaurant runs estimates for the cart.
8. Product shows:
   - Protein estimate
   - Kcal range
   - Confidence
   - Review status
9. Restaurant edits weak items.
10. Restaurant exports/submits final reviewed menu.

## 7. Functional Requirements

### 7.1 RID Handling

Requirements:
- Rename helper text to clarify RID is a numeric item ID.
- Placeholder should be numeric only, for example `1001`.
- Strip display examples like `RID-1001`, `DEMO-001`, `REST-001` from user-facing inputs and templates unless demo labels are needed internally.
- Validate RID as numeric-only if Swiggy agrees that all partner RIDs can be numeric.
- Store RID as metadata only.
- Do not include RID in model prompt text used for nutrition reasoning.
- Do not include RID in embedding query text.
- Do not allow RID changes to change protein/kcal estimates.
- Cache or compare estimates using a nutrition input hash that excludes RID.

Recommended implementation:
- Add a `sanitizeRid(value)` utility in `lib/menu-input-schema.js`.
- Normalize `RID-1001`, `REST-001`, and `DEMO-001` to `1001` only if numeric-only is confirmed.
- Add a validation error for non-numeric RID if required by business.
- Remove the `RID:` line from `buildPrompt()` in `lib/genai-estimator.js`, or move RID to a metadata object that is not sent to the model.
- Add a regression test: same item details with RID `1001` and `9999` must produce the same retrieval input and should not change the prompt.

Open decision:
- If restaurants already use alphanumeric item codes, numeric-only validation may break real partner workflows. Confirm whether numeric-only applies to all restaurants or only demo/default examples.

### 7.2 Add-ons Language

Current fields:
- `COMPULSORY_COMPONENTS`
- `OPTIONAL_COMPONENTS`

User-facing copy should become:
- `Included add-ons`
- `Optional add-ons`

Data contract can remain backward-compatible:
- Keep API/schema keys as `COMPULSORY_COMPONENTS` and `OPTIONAL_COMPONENTS` for compatibility.
- Display labels, helper text, docs, and table copy should say add-ons.
- CSV template headers can either remain technical or add friendlier aliases.

Recommended labels:
- `Included add-ons`: Items that always come with the dish.
- `Optional add-ons`: Items the customer may add or choose.

### 7.3 Kcal Range Display

Requirement:
- Make kcal output shorter and easier to understand.

Recommended display:
- High confidence: `420 kcal`
- Medium/Low confidence: `390-450 kcal`
- If model returns exact `estimated_energy_kcal`, create display range from confidence:
  - High: +/- 5%
  - Medium: +/- 10%
  - Low: +/- 15%
- Round range to nearest 10 kcal.
- Keep exact estimate internally for audit/export.

Example:
- Internal estimate: `425.5`
- High confidence display: `430 kcal`
- Medium confidence display: `380-470 kcal`
- Low confidence display: `360-490 kcal`

Copy:
- Replace `Energy` with `Calories`.
- Use `kcal` consistently.
- Avoid long explanation in the primary result card.

### 7.4 Cart-Like Menu Builder

The main product should be the cart workflow, not a calculator.

Requirements:
- Landing/default screen should show the menu cart builder first.
- Each item row/card should show:
  - RID number
  - Item name
  - Price
  - Grammage
  - Add-ons summary
  - Ingredient count
  - Estimate status
- CTA should be `Add item to menu` or `Add to menu cart`.
- Cart summary should show:
  - Total menu items
  - Ready to estimate
  - Needs required info
  - Needs review after estimate
- Allow edit/remove before estimation.
- Allow edit/re-run after estimation.
- Keep bulk upload as a secondary path for advanced users.

### 7.5 Restaurant Distribution Readiness

Requirements:
- Public partner-facing URL.
- No local setup required for restaurant users.
- Clear upload templates.
- Simple onboarding text, not internal model language.
- Export results to CSV/XLSX.
- Save draft cart locally or server-side.
- Submit final reviewed menu to Swiggy.
- Add sample/demo mode that does not pollute production analytics.
- Add error messages that tell the restaurant exactly what to fix.

### 7.6 Estimation Stability

Requirements:
- Estimate should depend on nutrition-relevant fields only:
  - Item name
  - Item grammage
  - Price as weak context only
  - Description
  - Cuisine
  - Ingredients and grams
  - Included/optional add-ons
- Estimate should not depend on:
  - RID
  - Row order
  - Upload filename
  - Internal row ID
- Add stable caching keyed by normalized nutrition inputs.
- Add model output logging for audit.
- Add automated comparisons for RID-only changes.

### 7.7 Review and Confidence

Requirements:
- Keep internal explainability available, but hide it by default.
- Partner-facing review states:
  - `Ready`
  - `Review suggested`
  - `Needs more detail`
- Internal users can expand:
  - References used
  - Ingredient matches
  - Confidence details
  - Price note
- Show separate protein and calorie confidence if available.

## 8. Non-Functional Requirements

Performance:
- Single item estimate should complete within 5-10 seconds.
- 80-item batch should show progress and partial completion.

Reliability:
- If OpenAI or assets are unavailable, show a clear unavailable state.
- Do not silently return stale or deterministic fallback results unless product explicitly allows it.

Security:
- Protect API keys server-side only.
- Add rate limiting before public rollout.
- Prevent arbitrary large uploads.
- Do not expose raw internal data assets to partners.

Privacy:
- Treat uploaded restaurant menu data as partner data.
- Add retention policy for uploaded menus and estimates.

Accessibility:
- Forms must be keyboard usable.
- Required field errors must be tied to fields.
- Tables must be readable on mobile.

Observability:
- Track estimation success/failure.
- Track rows by confidence band.
- Track edit-after-estimate rate.
- Track missing field frequency.
- Track model cost per batch.

## 9. AI Tool Build Brief

Use this prompt for an AI coding tool:

Build the restaurant-facing menu nutrition cart in the existing Next.js app. Start by reading `components/portal-workbench.js`, `components/minimal-calculator.js`, `lib/menu-input-schema.js`, and `lib/genai-estimator.js`. Preserve the existing GenAI API contract unless a requirement explicitly changes it.

Implement the following:
1. Make the cart/batch builder the primary product experience.
2. Change user-facing RID inputs to numeric-only examples and copy.
3. Add RID sanitization and remove RID from any model prompt or nutrition reasoning input.
4. Replace user-facing `components` language with `add-ons`.
5. Add compact calorie/kcal display formatting, including confidence-based ranges.
6. Keep backwards compatibility for CSV/XLSX headers.
7. Add tests or assertions proving RID-only changes do not alter nutrition prompt/query text.
8. Add export/submit-ready output structure for restaurant rollout.
9. Update docs and README copy for partner-facing usage.

Do not remove existing fields without providing aliases. Do not revert unrelated local changes. Keep data contracts stable where possible.

## 10. Skills Needed To Make This Live

Product skills:
- Partner onboarding flow design
- Restaurant menu data collection
- Nutrition estimate review workflow
- CSV/XLSX template design
- Error-message and form UX writing

Frontend skills:
- Next.js app router
- React forms and state management
- Responsive table/cart UI
- Accessible validation patterns
- Download/export flows

Backend/API skills:
- API route design
- Input normalization and schema versioning
- Server-side OpenAI integration
- File upload validation
- Rate limiting
- Structured logging

AI/ML skills:
- Retrieval augmented generation
- Prompt isolation and prompt regression testing
- Embedding asset generation
- Confidence calibration
- Model evaluation on food/nutrition datasets
- Determinism/caching strategy

Nutrition/domain skills:
- Indian restaurant food taxonomy
- Ingredient-level nutrition references
- Portion/grammage estimation
- Protein and kcal sanity checks
- ICMR reference interpretation

Data engineering skills:
- Catalog normalization
- Menu item deduplication
- Batch processing
- Data lineage and audit trails
- Offline evaluation datasets

Launch/ops skills:
- Vercel or production Next.js deployment
- Environment variable management
- Cost monitoring
- Error monitoring
- Usage analytics
- Partner support workflow

Security/legal skills:
- Partner data retention policy
- API key security
- Public endpoint protection
- Terms/disclaimer for estimated nutrition
- Audit log retention

## 11. Questions For Swiggy/Product Owner

RID:
1. Is RID always numeric across all restaurants?
2. If a restaurant uses alphanumeric item IDs, should we reject them or extract only digits?
3. Should RID be unique only within one restaurant, or globally unique?
4. Should the system auto-generate RID if the restaurant does not have one?
5. Should RID be visible to restaurants after upload, or only used internally?

Restaurant identity:
6. Do restaurants need login/accounts?
7. Should each restaurant have its own saved menu drafts?
8. Should Swiggy teams be able to invite restaurants with a magic link?
9. Should one restaurant be able to have multiple outlets?
10. Should outlet/location affect nutrition estimates?

Menu cart:
11. Should the main CTA say `Add item`, `Add to menu`, or `Add to menu cart`?
12. Should restaurants add variants like half/full, regular/large, or veg/non-veg under the same item?
13. Should add-ons be estimated separately or included in the main item estimate?
14. Should optional add-ons change the final displayed nutrition, or only show as caveats?
15. Should combos have child items inside one parent item?

Nutrition:
16. Should output prioritize protein or calories?
17. Should kcal be shown as exact value, range, or both?
18. What range width is acceptable for restaurant-facing estimates?
19. Should low-confidence estimates be hidden from restaurants until reviewed?
20. Should explicit nutrition values in descriptions be allowed to override model estimates?
21. Should the product estimate carbs/fat/fiber later?
22. Should the estimate be per serving, per item, or per 100 g?
23. Should item grammage be total plated weight or edible portion only?

Review workflow:
24. Who approves estimates before they go live?
25. Can restaurants self-publish high-confidence estimates?
26. What happens to medium-confidence rows?
27. What happens to low-confidence rows?
28. Should reviewers edit the estimate manually?
29. Should manual edits be stored as ground truth for future training?

Bulk upload:
30. What is the expected average menu size?
31. Is 80 rows per batch enough?
32. Should upload support multiple sheets?
33. Should the product detect duplicate menu items?
34. Should it support Swiggy catalog export formats directly?

Distribution:
35. Will this be a public Swiggy-hosted tool or internal-assisted workflow?
36. Should restaurants be able to use it on mobile?
37. Should results be emailed, downloaded, or submitted into a Swiggy system?
38. Which languages are required for restaurant rollout?
39. Should the product include a tutorial/demo mode?

Data and compliance:
40. How long should uploaded menus be stored?
41. Are nutrition estimates legally publishable as estimates, or do they need disclaimers?
42. What audit trail is required when an estimate changes?
43. Should Swiggy expose model confidence to restaurants?
44. Should restaurants be able to dispute or correct estimates?

Engineering:
45. Where should production data be stored?
46. Which auth provider should be used?
47. What rate limits are acceptable?
48. What is the expected monthly volume?
49. What is the acceptable OpenAI cost per menu?
50. Should the app keep running if GenAI is unavailable?

## 12. Recommended MVP Scope

MVP must include:
- Cart-first manual menu builder
- CSV/XLSX upload
- Numeric-only RID UX, pending business confirmation
- RID excluded from estimator prompt
- Add-ons wording
- Compact protein and kcal result display
- Confidence-based review states
- CSV/XLSX export
- Partner-friendly docs
- Basic production deployment
- Error and usage logging

Defer:
- Restaurant login
- Multi-outlet management
- Direct Swiggy catalog integration
- Human reviewer queue
- Manual nutrition override approval system
- Multi-language rollout
- Advanced macro nutrients beyond protein/kcal

## 13. Acceptance Criteria

1. A restaurant can add at least 10 items manually in one session.
2. A restaurant can upload a CSV/XLSX menu and see a validated cart.
3. RID examples are numeric-only in user-facing UI.
4. Changing only RID does not change nutrition prompt/query text.
5. User-facing copy says add-ons instead of components.
6. Calories are shown in compact kcal format or range.
7. Each result clearly says whether it is ready, needs review, or needs more detail.
8. A completed menu can be exported.
9. Internal explainability remains available but is not the main partner-facing experience.
10. Public rollout does not expose OpenAI keys or raw internal data assets.
