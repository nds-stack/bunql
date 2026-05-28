import { readFileSync, writeFileSync } from "fs";

const drivers = ["mongodb", "redis", "pg", "mysql"];

for (const d of drivers) {
  const connPath = `src/driver/${d}/connection.ts`;
  let content = readFileSync(connPath, "utf-8");

  // Extract error class
  const errorRegex = /export class \w+Error extends Error[\s\S]*?^}/m;
  const errorMatch = content.match(errorRegex);
  let errorClassName = "";

  if (errorMatch) {
    const errorContent = errorMatch[0];
    const nameMatch = errorContent.match(/export class (\w+Error)/);
    errorClassName = nameMatch ? nameMatch[1] : "";
    writeFileSync(`src/driver/${d}/error.ts`, errorContent + "\n");
    console.log(`${d}: error.ts extracted (${errorClassName})`);
    content = content.replace(errorMatch[0], "");
  }

  // Extract pool class
  const poolRegex = /export class \w+Pool[\s\S]*?^}/m;
  const poolMatch = content.match(poolRegex);
  let poolClassName = "";

  if (poolMatch) {
    const rawPool = poolMatch[0];
    const nameMatch = rawPool.match(/export class (\w+Pool)/);
    poolClassName = nameMatch ? nameMatch[1] : "";
    const baseName = poolClassName.replace("Pool", "");

    const poolContent = `import { ${baseName}, ${baseName}Config } from "./connection";\nimport { ${errorClassName || baseName + "Error"} } from "./error";\n\n${rawPool}\n`;
    writeFileSync(`src/driver/${d}/pool.ts`, poolContent);
    console.log(`${d}: pool.ts extracted (${poolClassName})`);
    content = content.replace(poolMatch[0], "");
  }

  // Add imports for error and pool at the top of connection.ts
  if (poolClassName) {
    const importLine = `import { ${errorClassName} } from "./error";\nimport { ${poolClassName} } from "./pool";\n\n`;
    content = importLine + content;
  }

  // Remove trailing export type
  content = content.replace(/^export type \{ \};\n*$/m, "");

  writeFileSync(connPath, content);
  console.log(`${d}: connection.ts updated`);
}
