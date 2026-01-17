const MAX_DIFF_BYTES = 500_000;
const BASE_URL = "http://127.0.0.1:1234";
const LLM_TIMEOUT_MS = 100000; //100 seconds limit as my computer is bit slow

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

  process.stdout.write("🧙 Git Gandalf is reviewing...");

  try {
    const metadata = parseDiff(diff);

    const userMessage = `METADATA:
    ${JSON.stringify(metadata, null, 2)}

    RAW DIFF:
    ${diff}`;

    const rawOutput = await callLocalLLM(SYSTEM_PROMPT, userMessage);

    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);

    // This will throw an Error if the LLM output is garbage
    const decision = normalizeResponse(rawOutput);
    const policyAction = evaluateRisk(decision.risk);

    renderReview(decision, policyAction);

    if (policyAction == "BLOCK") {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (error) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    const isInfraError =
      error.name === "AbortError" ||
      error.message.includes("fetch failed") ||
      (error.cause &&
        (error.cause.code === "ECONNREFUSED" ||
          error.cause.code === "ECONNRESET"));

    const C = {
      Reset: "\x1b[0m",
      Red: "\x1b[31m",
      Yellow: "\x1b[33m",
      Bold: "\x1b[1m",
    };

    if (isInfraError) {
      //If the AI is broken/slow, don't stop. WARN and ALLOW.
      console.log(`\n${C.Yellow}${C.Bold}⚠️  Git Gandalf Skipped${C.Reset}`);
      console.log(
        `${C.Yellow}Reason: Local LLM is unreachable or timed out.${C.Reset}`,
      );
      console.log(`${C.Yellow}Proceeding without review.${C.Reset}\n`);
      process.exit(0);
    } else {
      console.error(
        `\n${C.Red}${C.Bold}❌ Git Gandalf Internal Error${C.Reset}`,
      );
      console.error(`${C.Red}Reason: ${error.message}${C.Reset}`);
      console.error(`${C.Red}Commit blocked for safety.${C.Reset}\n`);
      process.exit(1);
    }
    process.exit(1);
  }
});

process.stdin.on("error", () => {
  process.exit(1);
});

//getting response from model and extracting our answer from all mess
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

//find all changes, no. of files, lines of code, etc
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

//policy engine function
function evaluateRisk(risk) {
  switch (risk) {
    case "HIGH":
      return "BLOCK";
    case "MEDIUM":
      return "WARN";
    case "LOW":
    default:
      return "ALLOW";
  }
}

// to display output on console
function renderReview(decision, policy) {
  const C = {
    Reset: "\x1b[0m",
    Red: "\x1b[31m",
    Green: "\x1b[32m",
    Yellow: "\x1b[33m",
    Bold: "\x1b[1m",
  };

  console.log(`\n${C.Bold}🧙 Git Gandalf Review${C.Reset}\n`);

  let riskColor = C.Green;
  if (decision.risk === "HIGH") riskColor = C.Red;
  if (decision.risk === "MEDIUM") riskColor = C.Yellow;

  console.log(
    `${C.Bold}Risk:${C.Reset}    ${riskColor}${decision.risk}${C.Reset}`,
  );
  console.log("");
  if (decision.issues.length > 0) {
    console.log(`${C.Bold}Issues:${C.Reset}`);
    decision.issues.forEach((issue) => console.log(` - ${issue}`));
  } else {
    console.log(`${C.Bold}Issues:${C.Reset}  (none)`);
  }

  console.log("");
  if (policy === "BLOCK") {
    console.log(`${C.Red}${C.Bold}Decision: 🚫 BLOCK${C.Reset}`);
    console.log(`${C.Red}${decision.summary}${C.Reset}`); // Summary explains the block
  } else if (policy === "WARN") {
    console.log(`${C.Yellow}${C.Bold}Decision: ⚠️  WARN${C.Reset}`);
    console.log(`${C.Yellow}${decision.summary}${C.Reset}`);
  } else {
    console.log(`${C.Green}${C.Bold}Decision: ✅ ALLOW${C.Reset}`);
    console.log(`${C.Green}${decision.summary}${C.Reset}`);
  }
  console.log("");
}
