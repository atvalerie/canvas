const fs = require("fs");
const path = require("path");

const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const args = process.argv.slice(2);
const yes = args.includes("--yes");
const [kind, value] = args.filter((a) => a !== "--yes");

const usage = () => {
  console.log(`usage: node remove.js <id|user|owner> <value> [--yes]
  node remove.js id 1a2b3c4d5e6f
  node remove.js user val          every item by anyone named val
  node remove.js user val#2        only items by val#2
  node remove.js owner 42492da06234ad0a
without --yes it only lists what would be deleted`);
  process.exit(1);
};
if (!kind || !value) usage();

const store = require("./db")(DATA);

let found;
if (kind === "id") {
  const entry = store.get(value);
  found = entry ? [entry] : [];
} else if (kind === "owner") {
  found = store.find({ owner: value });
} else if (kind === "user") {
  const [, name, tag] = /^(.*?)(?:#(\d+))?$/.exec(value);
  found = store.find({ name, tag: tag && Number(tag) });
} else {
  usage();
}

for (const { item } of found) {
  console.log(
    `${item.id}  ${item.type}  ${item.user}#${item.tag ?? "?"}  at ${item.x},${item.y}`,
  );
}
console.log(`${found.length} item(s)`);

if (yes) {
  for (const { n, item } of found) {
    const file = item.file || item.image;
    if (file) fs.rmSync(path.join(DATA, "uploads", file), { force: true });
    store.remove(n);
  }
  console.log("deleted. restart the app so open pages reload and drop them");
} else if (found.length) {
  console.log("run again with --yes to delete");
}
store.close();
