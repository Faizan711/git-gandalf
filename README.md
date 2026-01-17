# 🧙 Git Gandalf

> **The Local (or Remote) LLM–Powered Pre-Commit Code Reviewer**

Git Gandalf is a "boring", dependency-free git hook that blocks high-risk commits (like hardcoded secrets) using an LLM. It is designed for **Local LLMs** (like LM Studio) but can be configured to point anywhere.

## Prerequisites

1. **Node.js**: Version 18+ (required for built-in `fetch`).
2. **An LLM Endpoint**:
* **Default**: Local server running at `http://127.0.0.1:1234` (e.g., LM Studio, Ollama via compatibility mode).
* **Custom**: You can edit the script to point to any OpenAI-compatible endpoint.



## Installation

### 1. Copy the Script

Copy the `bin/gitgandalf.js` file to the root of your project (the same folder as your `package.json`).

### 2. Install the Hook

Copy the pre-commit file to your `.git` hooks folder:

```bash
cp hooks/pre-commit .git/hooks/pre-commit

```

### 3. Grant Permissions (⚠️ Required)

Git will **not** run the script unless you explicitly make it executable. If you skip this, you will get a "Permission Denied" error.

**Mac / Linux / Git Bash:**

```bash
chmod +x .git/hooks/pre-commit

```

**Windows (PowerShell):**
Usually not required, but if you run into issues, ensure your user has execute rights on the file.

## Configuration (Switching to Online/Remote LLMs)

By default, Git Gandalf looks for a local server. To change this:

1. Open `gitgandalf.js` in your editor.
2. Edit the `BASE_URL` constant at the top:

```javascript
// CHANGE THIS:
const BASE_URL = "http://127.0.0.1:1234";

// TO YOUR SERVER (example):
const BASE_URL = "https://my-internal-llm.company.com";

```

*(Note: The current version does not support `Authorization` headers for paid APIs like OpenAI/Anthropic out of the box. You must modify the `fetch` call in the script to add API keys if needed.)*

## Usage

Just commit as normal!

```bash
git add .
git commit -m "feat: new login page"

```

* **🟢 ALLOW**: Commit proceeds.
* **🟡 WARN**: Commit proceeds, but you get a warning.
* **🔴 BLOCK**: Commit fails. Fix the issues and try again.

## Emergency Bypass

If the LLM is down, hallucinating, or blocking a critical hotfix, you can skip the hook:

```bash
git commit -m "critical fix" --no-verify

```

## Troubleshooting

* **`Permission denied`**: You forgot to run `chmod +x .git/hooks/pre-commit`.
* **`Git Gandalf Skipped`**: The script couldn't reach the URL defined in `BASE_URL`. Check if your model is running.
