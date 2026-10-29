import { NextResponse } from "next/server";

const CONFIDENCE_THRESHOLD = 70;

function cleanText(value, maxLength = 5000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export async function POST(request) {
  try {
    const body = await request.json();
    const input = body?.input || {};
    const estimate = body?.estimate || {};
    const confidence = Number(estimate.confidence_percent);
    const protein = Number(estimate.estimated_protein_g);
    const energy = Number(estimate.estimated_energy_kcal);

    if (!input.rid || !input.name || !input.price) {
      return NextResponse.json({ error: "RID, item name, and item price are required." }, { status: 400 });
    }

    if (!Number.isFinite(confidence) || confidence < CONFIDENCE_THRESHOLD) {
      return NextResponse.json({ error: "Only estimates at 70% confidence or above can be logged." }, { status: 422 });
    }

    if (!Number.isFinite(protein) || !Number.isFinite(energy)) {
      return NextResponse.json({ error: "A complete protein and calorie estimate is required to log this entry." }, { status: 422 });
    }

    const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
    const webhookToken = process.env.GOOGLE_SHEETS_WEBHOOK_TOKEN;
    if (!webhookUrl || !webhookToken) {
      return NextResponse.json(
        { error: "Google Sheets logging is not configured. Add the webhook URL and token to the server environment." },
        { status: 503 }
      );
    }

    const record = {
      submitted_at: new Date().toISOString(),
      rid: cleanText(input.rid, 64),
      item_name: cleanText(input.name, 300),
      item_price: cleanText(input.price, 64),
      item_grammage: cleanText(input.grammage, 64),
      item_description: cleanText(input.description),
      cuisine: cleanText(input.cuisine, 200),
      preparation_style: cleanText(input.preparation_style, 200),
      ingredients: Array.isArray(input.ingredients)
        ? input.ingredients.slice(0, 50).map((ingredient) => ({
            name: cleanText(ingredient?.name, 200),
            grammage: cleanText(ingredient?.grammage, 64),
          }))
        : [],
      estimated_protein_g: protein,
      estimated_energy_kcal: energy,
      confidence_percent: Math.round(confidence),
      confidence_band: cleanText(estimate.confidence_band, 32),
      estimator: cleanText(body?.estimator, 100),
      reasoning_trace: cleanText(estimate.reasoning_trace, 2000),
    };

    const upstream = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: webhookToken, record }),
      cache: "no-store",
      redirect: "follow",
    });
    const responseText = await upstream.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = null;
    }

    if (!upstream.ok || responseData?.ok !== true) {
      return NextResponse.json(
        { error: responseData?.error || "Google Sheets did not confirm that the entry was saved." },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to log the menu item." }, { status: 500 });
  }
}
