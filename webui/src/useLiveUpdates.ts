import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, connectWs } from "./api";
import type { DetectedCard, InstanceConfig, InstanceId } from "./api";
import type { Handler } from "./types";

const useLiveUpdates = (showToast: (msg: ReactNode) => void) => {
  const [instances, setInstances] = useState<InstanceConfig[]>([]);
  const [cards, setCards] = useState<DetectedCard[]>([]);
  // first successful reader scan received
  const [cardsKnown, setCardsKnown] = useState(false);
  const [selected, setSelected] = useState<InstanceId | null>(null);

  const wsEvents = useRef({
    handlers: new Set<Handler>(),
  });

  const refresh = useCallback(async () => {
    try {
      const r = await api.instances();
      setInstances(r.instances);
      setSelected((s) => {
        if (s !== null && s !== "") return s;
        return r.instances[0] ? r.instances[0].id : null;
      });
    } catch (e) {
      /* manager may be starting */
    }
    try {
      const c = await api.cards();
      setCards(c.cards);
      setCardsKnown(true);
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // live updates
  useEffect(() => {
    const off = connectWs((msg) => {
      if (msg.type === "status") {
        // Keep the WHOLE status payload (reason, reason_code, retry, frozen, …), not just
        // state/label/detail — otherwise a live status push would drop the failure reason
        // that the initial /api/instances fetch showed, making the error banner vanish.
        const { type, instance, ...status } = msg;
        setInstances((list) =>
          list.map((i) =>
            String(i.id) === String(instance) ? { ...i, status } : i,
          ),
        );
      }
      if (msg.type === "cards") {
        setCards(msg.cards);
        setCardsKnown(true);
      }
      if (
        msg.type === "engine" &&
        [
          "card_removed",
          "reader_lost",
          "reader_added",
          "reader_removed",
        ].includes(msg.event)
      ) {
        const name = msg.args?.[0];
        showToast(
          {
            card_removed: "SIM removed — line stopped",
            reader_lost: "Reader unplugged — line stopped",
            reader_added: `Card reader connected${name ? `: ${name}` : ""}`,
            reader_removed: `Card reader disconnected${name ? `: ${name}` : ""}`,
          }[msg.event],
        );
        refresh();
      }
      wsEvents.current.handlers.forEach((h) => h(msg));
      // later parts of a concatenated SMS only update the existing message (msg.update)
      if (
        msg.type === "sms" &&
        msg.message?.direction === "in" &&
        !msg.update
      ) {
        showToast(`SMS from ${msg.message.peer}`);
      }
      if (msg.type === "call" && msg.call?.direction === "in") {
        showToast(`Incoming call from ${msg.call.peer}`);
      }
    });
    return off;
  }, []);

  const subscribe = useCallback((handler: Handler) => {
    wsEvents.current.handlers.add(handler);
    return () => {
      wsEvents.current.handlers.delete(handler);
    };
  }, []);

  return {
    instances,
    cards,
    cardsKnown,
    selected,
    setSelected,
    refresh,
    subscribe,
  };
};

export { useLiveUpdates };
