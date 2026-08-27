import fs from "fs";
import path from "path";

const clientDir = path.resolve("dist/client");
if (!fs.existsSync(clientDir)) {
  throw new Error("dist/client does not exist. Run npm run build:client first.");
}

const forbidden = [
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
  "SESSION_SECRET",
  ...[process.env.DISCORD_CLIENT_SECRET, process.env.DISCORD_BOT_TOKEN, process.env.SESSION_SECRET]
    .filter((value) => typeof value === "string" && value.length >= 8)
];

const textExtensions = new Set([".html", ".js", ".css", ".json", ".map"]);
const leaked = [];
for (const file of walk(clientDir)) {
  if (!textExtensions.has(path.extname(file))) continue;
  const contents = fs.readFileSync(file, "utf8");
  for (const marker of forbidden) {
    if (marker && contents.includes(marker)) leaked.push(`${path.relative(clientDir, file)}: ${marker}`);
  }
}

if (leaked.length) {
  throw new Error(`Server-only secret material found in the client bundle:\n${leaked.join("\n")}`);
}
console.log("Client bundle secret scan passed.");

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(resolved);
    else yield resolved;
  }
}
