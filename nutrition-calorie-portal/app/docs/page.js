import Link from "next/link";

import { MENU_FIELD_GUIDE, REQUIRED_MENU_FIELDS } from "@/lib/menu-input-schema";
import { formatKcalDisplay } from "@/lib/nutrition-display";
import { getFeaturedItems, getOverview } from "@/lib/portal-data";

import styles from "../page.module.css";

export default async function DocsPage() {
  const overview = await getOverview();
  const featured = (await getFeaturedItems()).slice(0, 4);

  const confidenceGuide = [
    {
      band: "High confidence",
      headline: "Ready",
      detail: "The estimate is strongly supported by labeled nutrition references and retrieval context.",
    },
    {
      band: "Medium confidence",
      headline: "Review suggested",
      detail: "The estimate is directionally useful, but recipe or portion differences could still matter.",
    },
    {
      band: "Low confidence",
      headline: "Needs more detail",
      detail: "The system found weak or mixed evidence, so treat the output as an internal draft only.",
    },
  ];

  const ownerTips = [
    {
      step: "01",
      title: "Complete the three required fields",
      detail: "Numeric RID, item name, and item price are required. Grammage is optional.",
    },
    {
      step: "02",
      title: "Include useful details in the description",
      detail: "Add ingredients with gram quantities, cuisine, preparation style, sides, and included or optional add-ons under Additional information.",
    },
    {
      step: "03",
      title: "Add ingredient cards when quantities need more space",
      detail: "Description entries with explicit gram amounts are also extracted into the structured ingredient list.",
    },
  ];

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.brandLockup}>
          <span className={styles.brandMark}>RX</span>
          <div>
            <strong>How RX Menu Nutrition Desk works</strong>
            <span>Required intake rules, confidence bands, and GenAI estimation logic.</span>
          </div>
        </div>
        <div className={styles.topbarMeta}>
          <Link href="/">{"<-"} Back to builder</Link>
        </div>
      </header>

      <section className={styles.dashboardGrid}>
        <article className={styles.panel}>
          <div className={styles.sectionHeading}>
            <span className={styles.kicker}>How it works</span>
              <h2>Three steps from menu cart to estimate.</h2>
            <p>
              The portal first checks the required item fields, then enriches the menu cart with optional context, and
              then sends the rows through the GenAI estimation workflow.
            </p>
          </div>
          <div className={styles.workflowList}>
            <article className={styles.workflowCard}>
              <span>01</span>
              <h3>Capture the mandatory row</h3>
              <p>Numeric RID, item name, and item price are required. Item grammage is optional.</p>
            </article>
            <article className={styles.workflowCard}>
              <span>02</span>
              <h3>Enrich with ingredients and operator notes</h3>
              <p>Ingredient cards and a detailed description give the estimator useful dish and portion context.</p>
            </article>
            <article className={styles.workflowCard}>
              <span>03</span>
              <h3>Run GenAI with full retrieval context</h3>
              <p>The estimate uses labeled nutrition references, the April 20 active-menu dataset, and ICMR checks.</p>
            </article>
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.sectionHeading}>
            <span className={styles.kicker}>Confidence guide</span>
            <h2>How to decide what can move forward.</h2>
            <p>Confidence reflects the model assessment and available evidence support. Log submission opens at 70% or above.</p>
          </div>
          <div className={styles.confidenceGrid}>
            {confidenceGuide.map((item) => (
              <article key={item.band} className={styles.confidenceCard}>
                <span>{item.band}</span>
                <strong>{item.headline}</strong>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>
        </article>
      </section>

      <section className={styles.bottomGrid}>
        <article className={styles.panel}>
          <div className={styles.sectionHeading}>
            <span className={styles.kicker}>Field reference</span>
            <h2>The row contract is now explicit.</h2>
            <p>There are {REQUIRED_MENU_FIELDS.length} blocking fields and a separate set of optional enrichment inputs.</p>
          </div>

          <div className={styles.rankedList}>
            {MENU_FIELD_GUIDE.map((field, index) => (
              <article key={field.key} className={styles.rankedCard}>
                <span className={styles.rankedIndex}>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>
                    {field.key} {field.required ? "(Required)" : "(Optional)"}
                  </h3>
                  <p>{field.description}</p>
                </div>
              </article>
            ))}
          </div>

          <div className={styles.sectionHeading} style={{ marginTop: "32px" }}>
            <span className={styles.kicker}>Operator tips</span>
            <h2>Five habits that improve accuracy.</h2>
          </div>
          <div className={styles.rankedList}>
            {ownerTips.map((item) => (
              <article key={item.step} className={styles.rankedCard}>
                <span className={styles.rankedIndex}>{item.step}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.detail}</p>
                </div>
              </article>
            ))}
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.sectionHeading}>
            <span className={styles.kicker}>Examples from current data</span>
            <h2>Dishes the current data already understands well.</h2>
            <p>These examples are still useful for benchmarking when you sanity-check new partner rows.</p>
          </div>
          <div className={styles.featureGridCompact}>
            {featured.map((item) => (
              <article key={item.normalized_name} className={styles.featureCard}>
                <span className={styles.featureTag}>
                  {item.top_cuisine || item.reference_cuisine || "Catalog item"}
                </span>
                <h3>{item.display_name}</h3>
                <p>{item.description || "Short description not available in the current export."}</p>
                <div className={styles.featureStats}>
                  <strong>{formatKcalDisplay(item.predicted_energy_kcal, "High")}</strong>
                  <span>{item.predicted_protein_g} g protein</span>
                  <span>{item.support_count.toLocaleString()} labeled reference rows</span>
                </div>
              </article>
            ))}
          </div>

          <div className={styles.sectionHeading} style={{ marginTop: "32px" }}>
            <span className={styles.kicker}>Cuisines with strongest support</span>
            <h2>These match fastest in the current labeled data.</h2>
          </div>
          <div className={styles.barList}>
            {overview.topCuisines.slice(0, 5).map((cuisine) => (
              <div key={cuisine.name} className={styles.barRow}>
                <div className={styles.barMeta}>
                  <strong>{cuisine.name}</strong>
                  <span>{cuisine.count.toLocaleString()} rows</span>
                </div>
                <div className={styles.barTrack}>
                  <div
                    className={styles.barFill}
                    style={{ width: `${(cuisine.count / overview.topCuisines[0].count) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}
