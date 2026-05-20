import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    { id: "claude-code", root: ".." },
    // <deepsec:projects-insert-above>
  ],
});
