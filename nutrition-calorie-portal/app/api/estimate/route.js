import { NextResponse } from "next/server";

import { validateMenuItems } from "@/lib/menu-input-schema";
import { estimateMenuItems } from "@/lib/portal-data";


export async function POST(request) {
  try {
    const body = await request.json();
    const rawItems = Array.isArray(body?.items) ? body.items : [];

    if (rawItems.length > 50) {
      return NextResponse.json(
        {
          error: "Estimate requests are limited to 50 rows. Send smaller chunks and retry.",
          reasonCode: "too_many_rows",
          retryable: false,
        },
        { status: 400 }
      );
    }

    const { normalizedItems, errors } = validateMenuItems(rawItems);

    if (!normalizedItems.length) {
      return NextResponse.json(
        { error: "No menu items received.", reasonCode: "empty_request", retryable: false },
        { status: 400 }
      );
    }

    if (errors.length) {
      return NextResponse.json(
        {
          error: "Each menu item must include numeric RID, ITEM_NAME, and ITEM_PRICE before estimation can run.",
          reasonCode: "validation_error",
          retryable: false,
          details: errors,
        },
        { status: 400 }
      );
    }

    const payload = await estimateMenuItems(normalizedItems);
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const isGenAiUnavailable =
      message.includes("GenAI") ||
      message.includes("OPENAI_API_KEY") ||
      message.includes("reference assets") ||
      message.includes("OpenAI");

    return NextResponse.json(
      {
        error: isGenAiUnavailable
          ? "The GenAI estimator is unavailable right now."
          : "Failed to estimate menu items.",
        reasonCode: isGenAiUnavailable ? "genai_unavailable" : "estimate_request_failed",
        retryable: false,
        detail: message,
      },
      { status: isGenAiUnavailable ? 503 : 500 }
    );
  }
}