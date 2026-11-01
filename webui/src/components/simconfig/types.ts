import type { InstanceConfig, SipConfig } from "../../api";

/** Props shared by the SimConfig form sections: the working form and its patch helpers. */
export interface FormSectionProps {
  form: InstanceConfig;
  upd: (patch: Partial<InstanceConfig>) => void;
}

export interface SipSectionProps extends FormSectionProps {
  updSip: (patch: Partial<SipConfig>) => void;
}
