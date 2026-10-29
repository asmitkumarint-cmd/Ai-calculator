import Link from "next/link";

import BulkUploader from "@/components/bulk/bulk-uploader";
import { getOverview } from "@/lib/portal-data";

import styles from "../page.module.css";

export default async function BulkPage() {
  const overview = await getOverview();
  const cuisineOptions = overview.topCuisines.map((item) => item.name).filter(Boolean);

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.brandLockup}>
          <span className={styles.brandMark}>RX</span>
          <div>
            <strong>Bulk menu upload</strong>
            <span>Upload a menu cart and estimate protein and kcal for each item.</span>
          </div>
        </div>
        <div className={styles.topbarMeta}>
          <Link href="/">{"<-"} Back to single-item builder</Link>
        </div>
      </header>

      <BulkUploader cuisineOptions={cuisineOptions} />
    </main>
  );
}
