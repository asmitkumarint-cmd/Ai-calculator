import { NextResponse } from "next/server";

import { buildWorkbookBuffer } from "@/lib/menu-template";

export function GET() {
  return new NextResponse(buildWorkbookBuffer(), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="rx-menu-template.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
