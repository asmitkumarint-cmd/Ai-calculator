import Link from "next/link";

import MinimalCalculator from "@/components/minimal-calculator";

import styles from "./page.module.css";

export default async function Home() {
  return (
    <main className={styles.minimalPage}>
      <header className={styles.minimalTopbar}>
        <div className={styles.brandLockup}>
          <span className={styles.brandMark}>RX</span>
          <div>
            <strong>RX Menu Nutrition Desk</strong>
            <span>Item-wise protein and kcal estimates for restaurant menus.</span>
          </div>
        </div>
        <nav className={styles.minimalNav}>
          <Link href="/docs">How it works</Link>
          <Link href="/bulk">Bulk upload</Link>
        </nav>
      </header>

      <section className={styles.minimalHero}>
        <h1>Add one menu item. Get a clean nutrition estimate.</h1>
        <p>
          Start with numeric <strong>RID</strong>, item name, and price. Add grammage, ingredients, or add-ons whenever
          available.
        </p>
      </section>

      <MinimalCalculator />

      <section className={styles.productBand} aria-label="Scale this flow">
        <div>
          <span className={styles.productEyebrow}>Scale the same flow</span>
          <h2>Use the same item-wise rules for a full restaurant menu.</h2>
          <p>
            The single-item builder is the default partner flow. For larger menus, upload a CSV or Excel file and review
            items in a menu cart before exporting the result.
          </p>
        </div>
        <div className={styles.productActions}>
          <Link className={styles.productButtonPrimary} href="/bulk">
            Open menu cart
          </Link>
          <Link className={styles.productButton} href="/api/template/xlsx">
            Download Excel template
          </Link>
          <Link className={styles.productButton} href="/docs">
            View field guide
          </Link>
        </div>
      </section>

      <footer className={styles.minimalFooter}>
        <span>RID is used only for tracking; it is not part of nutrition reasoning.</span>
        <span>
          Need a full menu? <Link href="/bulk">Use menu cart -&gt;</Link>
        </span>
      </footer>
    </main>
  );
}
