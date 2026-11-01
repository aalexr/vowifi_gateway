import React from "react";
import type { InstanceConfig } from "../../api";
import CheckboxRow from "./CheckboxRow";
import Field from "./Field";
import Hint from "./Hint";
import Section from "./Section";
import type { FormSectionProps } from "./types";
import { imsAdvancedSet } from "./utils";

interface ImsRegistrationSectionProps extends FormSectionProps {
  /** The saved instance (not the live form): opens the section if it already uses these. */
  saved?: InstanceConfig | null;
}

/** Per-line REGISTER/call-setup quirks some IMS cores need. Collapsed unless in use. */
export default function ImsRegistrationSection({
  form,
  upd,
  saved,
}: ImsRegistrationSectionProps) {
  return (
    <Section
      title="IMS registration"
      desc="Advanced — leave off/empty unless the carrier needs them."
      collapsible
      defaultOpen={imsAdvancedSet(saved)}
      resetKey={saved?.id}
    >
      <div className="form-grid">
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
        These change only this line. Some IMS cores accept the REGISTER and then
        remove it within a second (status "The carrier's IMS accepted the
        registration but then removed it again") unless it looks like a native
        phone. <b>MTS RU</b> needs only the Geolocation country (the country you
        are in, e.g. <code>DE</code>); the other options are there for carriers
        that turn out to need them (an iPhone sends all of them). Restart the
        line after changing them.
      </Hint>
    </Section>
  );
}
