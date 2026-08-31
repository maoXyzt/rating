import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDbPath = path.resolve(serverDir, "..", "data", "image-rating.sqlite");

export const databasePath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : defaultDbPath;
