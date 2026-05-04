import { access } from "node:fs/promises";

const required = [
  "index.html",
  "styles.css",
  "app.js",
  "netlify/functions/drawing.mjs"
];

await Promise.all(required.map((file) => access(file)));
console.log("Static site is ready for Netlify.");
