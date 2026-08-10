import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

import cors from "cors";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3000;
const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const rootDir = path.dirname(fileURLToPath(import.meta.url));

app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

// Optional for a separate frontend such as GitHub Pages. On Render, leave this
// unset and serve the page and API from the same origin.
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (allowedOrigins.length) {
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin is not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }));
}

const rateBuckets = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = Number(process.env.COACH_RATE_LIMIT) || 30;

function coachRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || "unknown";
  const bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return next();
  }

  if (bucket.count >= RATE_LIMIT) {
    return res.status(429).json({ error: "Too many coach questions. Please try again in a few minutes." });
  }

  bucket.count += 1;
  return next();
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-8)
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: cleanText(message?.content, 1000),
    }))
    .filter((message) => message.content);
}

function formatGameContext(context = {}) {
  const fields = [
    ["Selected object", cleanText(context.objectName, 120)],
    ["Object density", Number.isFinite(Number(context.objectDensity)) ? `${Number(context.objectDensity)} kg/m³` : "unknown"],
    ["Object size", Number.isFinite(Number(context.objectSize)) ? `${Number(context.objectSize)} m` : "unknown"],
    ["Fluid density", Number.isFinite(Number(context.fluidDensity)) ? `${Number(context.fluidDensity)} kg/m³` : "unknown"],
    ["Student prediction", cleanText(context.prediction, 20) || "none"],
    ["Expected outcome", cleanText(context.outcome, 20) || "unknown"],
    ["Immersed fraction", context.immersedFraction == null ? "not applicable" : String(context.immersedFraction)],
    ["Game score", Number.isFinite(Number(context.score)) ? String(Number(context.score)) : "unknown"],
    ["Time remaining", Number.isFinite(Number(context.timeLeft)) ? `${Number(context.timeLeft)} s` : "unknown"],
  ];

  return fields.map(([label, value]) => `${label}: ${value}`).join("\n");
}

function extractReply(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();

  return (data?.output || [])
    .flatMap((item) => item?.content || [])
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, aiConfigured: Boolean(process.env.OPENAI_API_KEY), model });
});

app.post("/api/chat", coachRateLimit, async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "AI Coach is not configured yet." });
  }

  const question = cleanText(req.body?.question, 800);
  if (!question) {
    return res.status(400).json({ error: "Please enter a question." });
  }

  const history = cleanHistory(req.body?.history);
  const gameContext = formatGameContext(req.body?.context);
  const sessionSource = cleanText(req.body?.sessionId, 160) || req.ip || "anonymous";
  const safetyIdentifier = crypto.createHash("sha256").update(sessionSource).digest("hex").slice(0, 64);

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: [
          "You are the AI Coach for a CE2134 floating-and-sinking learning game.",
          "Teach with Archimedes' principle, density comparison, buoyant force, and immersed fraction.",
          "Use the supplied live game state and its numbers. Do not invent measurements.",
          "Lead the student with one or two short reasoning steps before giving the conclusion.",
          "Correct misconceptions gently. Keep replies classroom-friendly and under 140 words.",
          "Use plain text and readable equations; do not use markdown tables.",
        ].join(" "),
        input: [
          ...history,
          { role: "user", content: `${question}\n\nCurrent game state:\n${gameContext}` },
        ],
        reasoning: { effort: "low" },
        max_output_tokens: 350,
        safety_identifier: safetyIdentifier,
      }),
    });

    if (!upstream.ok) {
      const details = (await upstream.text()).slice(0, 800);
      console.error(`OpenAI request failed (${upstream.status}): ${details}`);
      const status = upstream.status === 429 ? 429 : 502;
      return res.status(status).json({ error: "The AI Coach is temporarily unavailable." });
    }

    const data = await upstream.json();
    const reply = extractReply(data);
    if (!reply) throw new Error("OpenAI returned an empty reply");

    return res.json({ reply });
  } catch (error) {
    console.error("AI Coach error:", error);
    return res.status(500).json({ error: "The AI Coach is temporarily unavailable." });
  }
});

app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error(error);
  return res.status(500).json({ error: "Server error" });
});

app.listen(port, () => {
  console.log(`Float-or-Sink Sprint listening on http://localhost:${port}`);
  console.log(`AI Coach model: ${model}`);
});

