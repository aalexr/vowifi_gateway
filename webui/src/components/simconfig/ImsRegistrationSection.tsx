import React from "react";
import CheckboxRow from "./CheckboxRow";
import CollapsibleCard from "./CollapsibleCard";
import Field from "./Field";
import Hint from "./Hint";
import type { FormSectionProps } from "./types";

/** Per-line REGISTER/call-setup quirks some IMS cores need. */
export default function ImsRegistrationSection({
  form,
  upd,
}: FormSectionProps) {
  const enabled = [
    form.ims_domain && "domain",
    form.reg_geolocation_country && `geo ${form.reg_geolocation_country}`,
    form.reg_srvcc_tags && "SRVCC",
    form.reg_imei_urn_spare_zero && "IMEI spare 0",
    form.dial_00_to_plus && "00→+",
    form.update_after_prack && "UPDATE after PRACK",
  ].filter(Boolean);

  return (
    <CollapsibleCard
      id="ims"
      title="IMS Registration"
      summary={enabled.length ? enabled.join(" · ") : "defaults"}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Registrar home domain">
          <input
            className="mono"
            value={form.ims_domain || ""}
            onChange={(e) => upd({ ims_domain: e.target.value.trim() })}
            placeholder="auto (ims.mnc….mcc….3gppnetwork.org)"
          />
        </Field>
        <Field label="Geolocation in REGISTER (country)">
          <input
            className="mono"
            value={form.reg_geolocation_country || ""}
            maxLength={2}
            onChange={(e) =>
              upd({
                reg_geolocation_country: e.target.value
                  .replace(/[^a-zA-Z]/g, "")
                  .toUpperCase(),
              })
            }
            placeholder="off (e.g. DE)"
          />
        </Field>
      </div>
      <CheckboxRow
        marginTop={8}
        checked={!!form.reg_srvcc_tags}
        onChange={(reg_srvcc_tags) => upd({ reg_srvcc_tags })}
      >
        Advertise SRVCC capabilities in REGISTER
      </CheckboxRow>
      <CheckboxRow
        checked={!!form.reg_imei_urn_spare_zero}
        onChange={(reg_imei_urn_spare_zero) => upd({ reg_imei_urn_spare_zero })}
      >
        Send IMEI in +sip.instance with spare digit 0 (RFC 7254)
      </CheckboxRow>
      <CheckboxRow
        checked={!!form.dial_00_to_plus}
        onChange={(dial_00_to_plus) => upd({ dial_00_to_plus })}
      >
        Dial a leading 00 as + (for phones that can't dial "+", e.g. DECT
        handsets)
      </CheckboxRow>
      <CheckboxRow
        checked={!!form.update_after_prack}
        onChange={(update_after_prack) => upd({ update_after_prack })}
      >
        Send the call-setup UPDATE only after the PRACK is answered (fixes 491 →
        500 on outgoing calls)
      </CheckboxRow>
      <Hint>
        Leave these off/empty unless the carrier needs them — they change only
        this line. Some IMS cores accept the REGISTER and then remove it within
        a second (status "The carrier's IMS accepted the registration but then
        removed it again") unless it looks like a native phone. <b>MTS RU</b>{" "}
        needs only the Geolocation country (the country you are in, e.g.{" "}
        <code>DE</code>); the other options are there for carriers that turn out
        to need them (an iPhone sends all of them). Restart the line after
        changing them.
      </Hint>
    </CollapsibleCard>
  );
}
