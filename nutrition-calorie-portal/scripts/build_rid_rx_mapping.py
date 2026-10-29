#!/usr/bin/env python3
"""Convert the partner RID to RX mapping CSV into a compact runtime asset."""

import csv
import gzip
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python3 scripts/build_rid_rx_mapping.py INPUT.csv OUTPUT.json.gz")

    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    mapping = {}
    duplicate_ids = set()
    with source.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"RESTAURANT_ID", "RX_CLASIFIER"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise SystemExit(f"Mapping CSV is missing required columns: {', '.join(sorted(missing))}")

        for row in reader:
            rid = "".join(char for char in (row.get("RESTAURANT_ID") or "") if char.isdigit())
            classifier = (row.get("RX_CLASIFIER") or "").strip()
            if not rid or not classifier or classifier.lower() == "unclassified":
                continue
            if rid in mapping:
                duplicate_ids.add(rid)
                continue
            mapping[rid] = classifier

    if duplicate_ids:
        raise SystemExit(f"Found {len(duplicate_ids)} duplicate restaurant IDs; refusing ambiguous mapping.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    categories = sorted(set(mapping.values()))
    category_indexes = {category: index for index, category in enumerate(categories)}
    rows = sorted((int(rid), category_indexes[category]) for rid, category in mapping.items())
    payload = bytearray()
    payload.extend(len(rows).to_bytes(4, "little"))
    payload.append(len(categories))
    for category in categories:
        encoded = category.encode("utf-8")
        if len(encoded) > 255:
            raise SystemExit("Classifier label exceeds 255 UTF-8 bytes.")
        payload.append(len(encoded))
        payload.extend(encoded)
    for rid, category_index in rows:
        if rid > 0xFFFFFFFF:
            raise SystemExit(f"Restaurant ID {rid} exceeds the supported 32-bit range.")
        payload.extend(rid.to_bytes(4, "little"))
        payload.append(category_index)
    with destination.open("wb") as output:
        with gzip.GzipFile(fileobj=output, mode="wb", mtime=0, compresslevel=9) as compressed:
            compressed.write(bytes(payload))
    print(f"Wrote {len(mapping)} mapped restaurant IDs to {destination} ({destination.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
