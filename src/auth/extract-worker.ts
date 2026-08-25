import { extractSessionTokenFromBrowser } from "./session";

const result = extractSessionTokenFromBrowser();
process.stdout.write((result ? JSON.stringify(result) : "null") + "\n");
