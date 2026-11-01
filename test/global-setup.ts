import { execSync } from "node:child_process";

/** Build dist/ once so the end-to-end tests can spawn the real CLI. */
export default function setup(): void {
  execSync("npx tsup", { stdio: "inherit" });
}
