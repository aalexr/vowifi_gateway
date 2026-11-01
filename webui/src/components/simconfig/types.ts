import type { InstanceConfig, SipConfig } from "../../api";

/**
 * The SimConfig working copy of an instance. `sip` is always present: the form is seeded
 * from `emptyInstance()` and saved instances always carry it (config.upsert_instance).
 */
export type InstanceForm = InstanceConfig & { sip: SipConfig };

/** Props shared by the SimConfig form sections: the working form and its patch helpers. */
export interface FormSectionProps {
  form: InstanceForm;
  upd: (patch: Partial<InstanceConfig>) => void;
}

export interface SipSectionProps extends FormSectionProps {
  updSip: (patch: Partial<SipConfig>) => void;
}
