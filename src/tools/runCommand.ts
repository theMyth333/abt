// src/tools/runCommand.ts
// Tool: run_command
// Runs a shell command via Bun.spawn and returns stdout + stderr + exit code.
// Includes a denylist of obviously destructive patterns and a 30s timeout.
// WARNING: This tool lets the LLM execute arbitrary shell commands. Only run this
// harness in environments where that is acceptable (dev machines, sandboxed VMs).

import type { ToolDefinition } from "../ollama/types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

// Patterns that are unconditionally rejected before spawning.
// This is not a security boundary — it's a footgun-prevention layer.
// A determined LLM could still cause harm via less obvious commands.
const DENYLIST: RegExp[] = [
  /rm\s+-rf\s+\//,                // rm -rf /
  /rm\s+-rf\s+~\/?$/,             // rm -rf ~
  /:\(\)\s*\{\s*:|:\s*&\s*\}/,    // fork bomb: (){:|:&};:
  /dd\s+if=\/dev\/(zero|random)\s+of=\/dev\/(sda|nvme|hda)/, // overwrite disk
  /mkfs\./,                        // reformat filesystem
  /chmod\s+-R\s+777\s+\//,        // chmod -R 777 /
  />\s*\/dev\/(sda|nvme|hda)/,    // write directly to block device
  /shutdown|reboot|halt|poweroff/, // system state changes
];

export const runCommandDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "run_command",
    description:
      "Run a shell command and return its stdout, stderr, and exit code. Use for compiling, testing, listing git status, etc. Avoid long-running processes.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute (passed to `sh -c`).",
        },
        cwd: {
          type: "string",
          description:
            "Optional working directory for the command (relative to the harness cwd or absolute).",
        },
      },
      required: ["command"],
    },
  },
};

export async function runCommandHandler(args: Record<string, unknown>): Promise<string> {
  const command = args.command as string;
  const cwd = (args.cwd as string | undefined) ?? process.cwd();

  if (!command || typeof command !== "string") {
    throw new Error("run_command requires a 'command' argument (string).");
  }

  // Denylist check before we do anything
  for (const pattern of DENYLIST) {
    if (pattern.test(command)) {
      throw new Error(
        `Command rejected by denylist (matched /${pattern.source}/): "${command}"`
      );
    }
  }

  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Race the process completion against a timeout.
  // If the timeout fires, kill the process and report the timeout.
  const timeoutId = setTimeout(() => {
    proc.kill();
  }, DEFAULT_TIMEOUT_MS);

  let stdout = "";
  let stderr = "";

  try {
    // Bun.spawn stdout/stderr are ReadableStream<Uint8Array>
    const decoder = new TextDecoder();

    // Collect both streams concurrently
    const [stdoutBytes, stderrBytes] = await Promise.all([
      // ReadableStream<Uint8Array> → Uint8Array
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
    ]);

    stdout = decoder.decode(stdoutBytes);
    stderr = decoder.decode(stderrBytes);
  } finally {
    clearTimeout(timeoutId);
  }

  const exitCode = await proc.exited;

  // Build a structured result string the model can parse
  const lines: string[] = [
    `exit_code: ${exitCode}`,
  ];
  if (stdout.trim()) lines.push(`stdout:\n${stdout.trim()}`);
  if (stderr.trim()) lines.push(`stderr:\n${stderr.trim()}`);
  if (!stdout.trim() && !stderr.trim()) lines.push("(no output)");

  return lines.join("\n\n");
}
