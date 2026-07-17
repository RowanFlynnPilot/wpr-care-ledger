// Copies the repo's data (always) and archive (once) into public/ so the
// dev server and local builds serve the same relative paths as production.
import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const widget = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(widget);

cpSync(join(root, "data"), join(widget, "public", "data"), { recursive: true });
if (!existsSync(join(widget, "public", "archive"))) {
  cpSync(join(root, "archive"), join(widget, "public", "archive"), { recursive: true });
}
console.log("synced data/ and archive/ into widget/public/");
