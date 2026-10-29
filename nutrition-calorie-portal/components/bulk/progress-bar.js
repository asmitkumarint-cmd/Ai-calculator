"use client";

import styles from "./bulk.module.css";

export default function ProgressBar({ progress }) {
  if (!progress?.total) {
    return null;
  }

  const processed = Math.min(progress.total, progress.completed + progress.failed);
  const percent = Math.round((processed / progress.total) * 100);

  return (
    <div className={styles.progressWrap} aria-label="Estimate progress">
      <div className={styles.progressMeta}>
        <span>{processed} of {progress.total} rows processed</span>
        <span>{progress.failed} failed</span>
      </div>
      <div className={styles.progressTrack}>
        <span className={styles.progressFill} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
