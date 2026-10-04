import type { EdgeType } from "./types";

// Industry-standard report palette (matches the reference report legend),
// shared by the PDF and the website so legends always agree.
export const EDGE_HEX: Record<EdgeType, string> = {
  eave: "#4CAF50",
  valley: "#E5533D",
  hip: "#8E5BD6",
  ridge: "#9BBF3F",
  rake: "#E8B21F",
  flash: "#3B8BE6",
  step: "#E0902A",
  transition: "#E26EE6",
  parapet: "#F0A030",
  unspecified: "#4FC3F7",
};

export const EDGE_DASHED: Partial<Record<EdgeType, boolean>> = { flash: true, step: true };

export const EDGE_LABEL: Record<EdgeType, string> = {
  eave: "Eaves",
  valley: "Valleys",
  hip: "Hips",
  ridge: "Ridges",
  rake: "Rakes",
  flash: "Wall flashing",
  step: "Step flashing",
  transition: "Transitions",
  parapet: "Parapet wall",
  unspecified: "Unspecified",
};

export const EDGE_ORDER: EdgeType[] = ["eave", "valley", "hip", "ridge", "rake", "flash", "step", "transition", "parapet", "unspecified"];
