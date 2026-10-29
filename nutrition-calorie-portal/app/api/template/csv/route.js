import { NextResponse } from "next/server";

import { buildCsvTemplateString } from "@/lib/menu-template";

export function GET() {
  return new NextResponse(buildCsvTemplateString(), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="rx-menu-template.csv"',
      "Cache-Control": "no-store",
    },
  });
}
