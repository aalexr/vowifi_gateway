import type { WebSocketMessage } from "./api";

type Handler = (msg: WebSocketMessage) => void;

export type { Handler };
