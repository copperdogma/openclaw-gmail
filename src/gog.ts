import { spawn } from "node:child_process";

export async function gogJson(args: string[], opts?: { account?: string; env?: Record<string, string> }) {
  const env = {
    ...process.env,
    ...(opts?.env ?? {}),
  };

  // Prefer --account to avoid relying on env, but env is fine too.
  if (opts?.account) {
    args = [...args, "--account", opts.account];
  }

  // Always JSON output for programmatic use.
  if (!args.includes("--json")) {
    args = [...args, "--json"];
  }

  return await new Promise<any>((resolve, reject) => {
    const child = spawn("gog", args, { env });

    let out = "";
    let err = "";

    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));

    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`gog ${args.join(" ")} exited ${code}: ${err.trim()}`));
        return;
      }
      try {
        resolve(out.trim() ? JSON.parse(out) : null);
      } catch (e) {
        reject(new Error(`Failed to parse gog JSON output: ${(e as Error).message}\nOutput: ${out.slice(0, 2000)}`));
      }
    });
  });
}
