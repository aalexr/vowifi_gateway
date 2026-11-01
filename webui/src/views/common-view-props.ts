import { InstanceConfig, DetectedCard, InstanceId } from "../api";
import type { Handler } from "../types";

interface CommonViewProps {
  instances: InstanceConfig[];
  cards: DetectedCard[];
  noReaders: boolean;
  cardsKnown: boolean;
  selected?: InstanceConfig | null;
  setSelected: (selected: InstanceId | null) => void;
  refresh: () => Promise<void>;
  subscribe: (handler: Handler) => () => void;
  showToast: (msg: React.ReactNode) => void;
  setView: (view: string) => void;
}

export type { CommonViewProps };
