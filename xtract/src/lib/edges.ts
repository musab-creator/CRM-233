import type { EdgeType } from "./types";

// One palette for the PDF and the website so legends always match.
export const EDGE_HEX: Record<EdgeType, string> = {
  eave: "#0369A1",
  rake: "#7C3AED",
  ridge: "#DC2626",
  hip: "#EA580C",
  valley: "#059669",
  flash: "#64748B",
};

export const EDGE_LABEL: Record<EdgeType, string> = {
  eave: "Eaves",
  rake: "Rakes",
  ridge: "Ridges",
  hip: "Hips",
  valley: "Valleys",
  flash: "Wall flashing",
};

export const EDGE_ORDER: EdgeType[] = ["eave", "rake", "ridge", "hip", "valley", "flash"];
