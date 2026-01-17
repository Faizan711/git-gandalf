const MAX_DIFF_BYTES = 500_000;
const BASE_URL = "http://127.0.0.1:1234";
const LLM_TIMEOUT_MS = 100000;

const SYSTEM_PROMPT = `You are a senior software engineer acting as a pre-commit code reviewer.
Your task is to analyze the provided git diff and metadata.

Risk Criteria:
- LOW: Formatting, comments, minor logic changes.
- MEDIUM: New logic, missing error handling, complex regex.
- HIGH: Security risks, secrets, destructiveness, infinite loops.

You must output ONLY valid JSON. No conversational text. No markdown blocks.

Response Schema:
{
    "risk": "LOW" | "MEDIUM" | "HIGH",
    "issues": ["string"],
    "summary": "string"
}
`;

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
    if (decision.risk == "MEDIUM") {
      console.log("Warning:", decision.summary);
    }
    if (decision.risk == "HIGH") {
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    console.error("\nGit Gandalf: ❌ INTERNAL ERROR");
    console.error(`Reason: ${error.message}`);
    process.exit(1);
  }
});

process.stdin.on("error", () => {
  process.exit(1);
});

/**
 * Ticket 7: The "Bouncer" (Updated for Thinking Models)
 * Cleans <think> tags, markdown, and parses JSON.
 */
function normalizeResponse(rawText) {
  // 1. Remove <think> blocks (Common in reasoning models like Qwen/DeepSeek)
  let cleanText = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "");

  // 2. Strip Markdown (LLMs love wrapping JSON in ```json ... ```)
  cleanText = cleanText
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  // 3. Aggressive JSON Hunt: Find the substring between the first '{' and last '}'
  // This ignores any conversational filler text before or after the JSON.
  const firstBrace = cleanText.indexOf("{");
  const lastBrace = cleanText.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1) {
    cleanText = cleanText.substring(firstBrace, lastBrace + 1);
  }

  let data;
  try {
    data = JSON.parse(cleanText);
  } catch (e) {
    // Log the failed text to help debug
    throw new Error(`LLM returned invalid JSON syntax.`);
  }

  // 4. Validate Risk (Strict Enum)
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

  // 5. Normalize Issues (Ensure Array of Strings)
  let issues = [];
  if (Array.isArray(data.issues)) {
    issues = data.issues.map(String);
  } else if (typeof data.issues === "string") {
    issues = [data.issues];
  }

  // 6. Normalize Summary (Ensure String)
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
