import React from "react";
import { Phone as PhoneIcon, PhoneOff } from "lucide-react";

/** The call screen's anchor glyph. Neutral by design: call health is told in words and SIP
 *  detail, not by tinting a picture in lamp colours. `ended` swaps in the hang-up glyph. */
export default function Avatar({ ended = false }: { ended?: boolean }) {
  const Icon = ended ? PhoneOff : PhoneIcon;
  return (
    <div className="call-avatar" aria-hidden="true">
      <Icon size={30} strokeWidth={1.6} />
    </div>
  );
}
