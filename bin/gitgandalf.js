const MAX_DIFF_BYTES = 500_000;
const BASE_URL = "http://127.0.0.1:1234";
const LLM_TIMEOUT_MS = 100000;

const SYSTEM_PROMPT = `You are a senior software engineer acting as a pre-commit code reviewer.
Your task is to analyze the provided git diff and metadata.

You must output ONLY valid JSON. No conversational text. No markdown blocks.

Response Schema:
{
    "risk": "LOW" | "MEDIUM" | "HIGH",
    "issues": ["string"],
    "summary": "string"
}

Risk Criteria:
- LOW: Formatting, comments, minor logic changes.
- MEDIUM: New logic, missing error handling, complex regex.
- HIGH: Security risks, secrets, destructiveness, infinite loops.`;

let diff = "";
let byteCount = 0;
let aborted = false;

process.stdin.on("data", (chunk) => {
  if (aborted) return;
  byteCount += chunk.length;
  if (byteCount > MAX_DIFF_BYTES) {
    aborted = true;
    process.exit(1);
  }
  diff += chunk.toString("utf8");
});

process.stdin.on("end", async () => {
  if (aborted) return;
  diff = diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (diff.trim().length === 0) {
    console.log("No staged changes.");
    process.exit(0);
  }

  console.log("Git Gandalf: Analyzing...");

  try {
    const metadata = parseDiff(diff);

    const userMessage = `METADATA:
${JSON.stringify(metadata, null, 2)}

RAW DIFF:
${diff}`;

    const rawOutput = await callLocalLLM(SYSTEM_PROMPT, userMessage);

    // --- TICKET 7: JUDGMENT NORMALIZATION ---
    console.log("Git Gandalf: Validating judgment...");

    // This will throw an Error if the LLM output is garbage
    const decision = normalizeResponse(rawOutput);

    console.log("\n--- TICKET 7 VALIDATED OUTPUT ---");
    console.log(JSON.stringify(decision, null, 2));
    console.log("---------------------------------");

    process.exit(0);
  } catch (error) {
    // Ticket 7 Requirement: Malformed output = Hard Failure
    console.error("\nGit Gandalf: ❌ INTERNAL ERROR");
    console.error(`Reason: ${error.message}`);
    process.exit(1);
  }
});

process.stdin.on("error", () => {
  process.exit(1);
});

/**
 * Ticket 7: The "Bouncer"
 * Cleans markdown, parses JSON, and enforces schema.
 */
function normalizeResponse(rawText) {
  // 1. Strip Markdown (LLMs love wrapping JSON in ```json ... ```)
  const cleanText = rawText
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  let data;
  try {
    data = JSON.parse(cleanText);
  } catch (e) {
    throw new Error("LLM returned invalid JSON syntax.");
  }

  // 2. Validate Risk (Strict Enum)
  if (!data.risk || typeof data.risk !== "string") {
    throw new Error("Missing 'risk' field.");
  }
  const risk = data.risk.toUpperCase();
  const validRisks = ["LOW", "MEDIUM", "HIGH"];
  if (!validRisks.includes(risk)) {
    throw new Error(
      `Invalid risk value: '${data.risk}'. Must be LOW, MEDIUM, or HIGH.`,
    );
  }

  // 3. Normalize Issues (Ensure Array of Strings)
  let issues = [];
  if (Array.isArray(data.issues)) {
    issues = data.issues.map(String);
  } else if (typeof data.issues === "string") {
    issues = [data.issues]; // Be nice: fix single string to array
  }

  // 4. Normalize Summary (Ensure String)
  const summary =
    typeof data.summary === "string" ? data.summary : "No summary provided.";

  return { risk, issues, summary };
}

// ... (Rest of the boilerplate: getModelId, callLocalLLM, parseDiff) ...
async function getModelId(controller) {
  const response = await fetch(`${BASE_URL}/v1/models`, {
    method: "GET",
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`Failed to fetch models`);
  const data = await response.json();
  return data.data?.[0]?.id || "local-model";
}

async function callLocalLLM(systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const modelId = await getModelId(controller);
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Server status ${response.status}`);
    const data = await response.json();
    return data.choices[0]?.message?.content || "{}";
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseDiff(rawDiff) {
  const lines = rawDiff.split("\n");
  const files = new Set();
  let linesAdded = 0,
    linesRemoved = 0,
    isBinary = false;
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      isBinary = false;
      files.add(line.split(" ").pop());
    }
    if (line.startsWith("Binary files")) isBinary = true;
    if (isBinary) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
    if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
  }
  return {
    files_changed: files.size,
    files: Array.from(files),
    lines_added: linesAdded,
    lines_removed: linesRemoved,
  };
}
