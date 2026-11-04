// For the engine's view-parity tool: builds a view of a checkout.
import { buildView } from "../src/blind.js";

buildView(process.argv[2]!, process.argv[3]!);
