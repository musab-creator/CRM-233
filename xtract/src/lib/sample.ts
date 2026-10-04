import { demoBuildingInsights } from "./solar";

// A fixed L-shaped hip roof used for the homepage diagrams and sample PDF.
export const SAMPLE_ADDRESS = "1200 Sample Ridge Ln, Jacksonville, FL 32256";
export const SAMPLE_SEED = "L-11";

export function sampleInsights() {
  return demoBuildingInsights(30.25, -81.55, SAMPLE_SEED);
}
