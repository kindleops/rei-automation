import { NextResponse } from 'next/server.js';
import { callBigPickle } from "@/lib/ai/opencode-zen-client.js";

const POLISH_SYSTEM = `You are a real estate SMS cleaning assistant. Clean rough real estate SMS drafts. 
Fix punctuation, capitalization, and sentence structure to make it seller-ready.
Keep the tone casual, human, and concise. 
Do NOT change the meaning. 
Do NOT change real estate terms (numbers, addresses, dates, names, loan amounts, prices).
Do NOT add claims or sales copy. 
Do NOT make it sound like AI.
Return ONLY the cleaned message body text.`;

export async function POST(request) {
  try {
    const { text, preserveNumbers = true } = await request.json();

    if (!text || typeof text !== 'string') {
      return withCors(request, NextResponse.json({ ok: false, error: 'Invalid input' }, { status: 400 }));
    }

    const messages = [
      { role: "system", content: POLISH_SYSTEM },
      { role: "user", content: `Clean this SMS draft:\n\n${text}` },
    ];

    const result = await callBigPickle(messages, { expectJson: false, temperature: 0.2 });

    if (!result) {
      return withCors(request, NextResponse.json({ ok: false, error: 'Polish unavailable' }, { status: 500 }));
    }

    return withCors(request, NextResponse.json({
      ok: true,
      polishedText: result.trim(),
    }));

  } catch (error) {
    console.error('[PolishDraft] Error:', error);
    return withCors(request, NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 }));
  }
}

export async function OPTIONS(request) {
  return handleOptionsResponse(request);
}
