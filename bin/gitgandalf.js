const MAX_DIFF_BYTES = 500_000; // ~500 KB limit for changes

let diff = "";
let byteCount = 0;
let aborted = false;

process.stdin.on("data", (chunk) => {
  if (aborted) return;

  byteCount += chunk.length;

  if (byteCount > MAX_DIFF_BYTES) {
    aborted = true;
    console.error("Git Gandalf Review");
    console.error("Diff too large to analyze safely. Aborting.");
    process.exit(1); // fail closed
  }

  diff += chunk.toString("utf8");
});

process.stdin.on("end", () => {
  if (aborted) return;

  // Normalize line endings to proper understanding
  diff = diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (diff.trim().length === 0) {
    console.log("Git Gandalf Review");
    console.log("No staged changes detected. Skipping analysis.");
    process.exit(0);
  }

  // Ticket 3 explicitly stops here
  console.log("Git Gandalf Review");
  console.log("(no analysis yet)");
  process.exit(0);
});

process.stdin.on("error", () => {
  console.error("Git Gandalf Review");
  console.error("Failed to read diff input. Aborting.");
  process.exit(1); // fail closed
});
