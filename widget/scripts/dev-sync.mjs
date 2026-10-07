// Copies the repo's data and archive into public/ so the dev server and
// local builds serve the same relative paths as production. data/ is
// overwritten every run; archive/ PDFs are immutable, so existing files are
// skipped and only new ones are copied.
import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const widget = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(widget);

cpSync(join(root, "data"), join(widget, "public", "data"), { recursive: true });
cpSync(join(root, "archive"), join(widget, "public", "archive"), {
  recursive: true,
  force: false,
});
console.log("synced data/ and archive/ into widget/public/");
